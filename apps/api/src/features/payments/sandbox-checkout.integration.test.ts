import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase, environment } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
  environment: {
    NODE_ENV: "test" as string,
    APP_URL: "https://darkview.test",
    PAYMENT_SANDBOX_WEBHOOK_SECRET: "s".repeat(32) as string | undefined,
  },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));
vi.mock("@/lib/validation/env", () => ({ getServerEnvironment: () => environment }));

const { PAYMENT_HOLD_MINUTES, reserveSlot } = await import("@/features/booking/reserve");
const { confirmSandboxCheckout, readSandboxCheckout } = await import(
  "@/features/payments/sandbox-checkout"
);
const { nightWindow } = await import("@/lib/slots/darkness");
const { generateSlots, SLOT_DURATION_MINUTES } = await import("@/lib/slots/generate");

/**
 * #149 against a real PostgreSQL instance: the checkout settles through
 * `settlePayment`, whose idempotency and hold handling are row locks and a
 * unique index, so a mocked client would prove nothing about them.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const SITE = { latitude: 41.7151, longitude: 44.8271, timezone: "Asia/Tbilisi" };
const NOW = new Date("2026-12-15T12:00:00.000Z");
const NIGHT = "2026-12-15";
const AFTER_HOLD = new Date(NOW.getTime() + (PAYMENT_HOLD_MINUTES + 1) * 60_000);

let database: PrismaClient;
let observatoryId: string;
let telescopeId: string;
let targetId: string;
let userId: string;

function firstSlotStartAt(): Date {
  const window = nightWindow(NIGHT, SITE.timezone, {
    latitudeDegrees: SITE.latitude,
    longitudeDegrees: SITE.longitude,
  });
  if (!window) throw new Error("no astronomical darkness on the fixture night");

  const slot = generateSlots({
    observatoryId,
    window,
    now: NOW,
    observatory: { online: true, weatherHold: false },
    bookedStartAt: new Set(),
  }).find((candidate) => candidate.available);
  if (!slot) throw new Error("no available slot on the fixture night");
  return new Date(slot.startAt);
}

async function createUser(locale: "en" | "ka" = "en"): Promise<string> {
  const user = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Payer", emailVerifiedAt: NOW, locale },
  });
  return user.id;
}

async function reserve(forUserId: string = userId) {
  const result = await reserveSlot({
    userId: forUserId,
    request: {
      observatoryId,
      targetId,
      slotStartAt: firstSlotStartAt().toISOString(),
      durationMinutes: SLOT_DURATION_MINUTES,
    },
    idempotencyKey: null,
    now: NOW,
  });
  if (!result.ok) throw new Error(`fixture reservation failed: ${result.message}`);
  return { booking: result.body.booking, paymentIntent: result.body.paymentIntent! };
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING, max: 8 }),
  });
  testDatabase.current = database;
  await database.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(async () => {
  await database.networkAvailabilityWindow.deleteMany();
  await database.observatoryNetworkNode.deleteMany();
  await database.capture.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  await database.missionEvent.deleteMany();
  await database.auditLog.deleteMany();
  await database.observerPack.deleteMany();
  await database.booking.deleteMany();
  await database.mission.deleteMany();
  await database.payment.deleteMany();
  await database.telescope.deleteMany();
  await database.target.deleteMany();
  await database.weatherState.deleteMany();
  await database.observatory.deleteMany();
  await database.user.deleteMany();

  const observatory = await database.observatory.create({
    data: {
      slug: `test-${randomUUID()}`,
      nameEn: "Test Observatory",
      nameKa: "სატესტო ობსერვატორია",
      city: "Tbilisi",
      countryCode: "GE",
      latitude: SITE.latitude,
      longitude: SITE.longitude,
      timezone: SITE.timezone,
      status: "ONLINE",
    },
  });
  observatoryId = observatory.id;

  const telescope = await database.telescope.create({
    data: {
      observatoryId,
      name: "NexStar 6SE",
      manufacturer: "Celestron",
      model: "NexStar 6SE",
      apertureMm: 150,
      focalLengthMm: 1500,
      status: "ONLINE",
    },
  });
  telescopeId = telescope.id;

  userId = await createUser();
  await database.observatoryNetworkNode.create({
    data: {
      ownerId: userId,
      observatoryId,
      primaryTelescopeId: telescopeId,
      kind: "FIRST_PARTY",
      approvalStatus: "APPROVED",
      capabilities: [],
      approvedAt: NOW,
    },
  });

  const target = await database.target.create({
    data: {
      slug: `m13-${randomUUID()}`,
      nameEn: "M13",
      nameKa: "M13",
      type: "GLOBULAR_CLUSTER",
      positionSource: "FIXED",
      rightAscensionHours: 16.6949,
      declinationDegrees: 36.4613,
      angularSizeArcmin: 20,
      magnitude: 5.8,
      opticalConfig: "F10_NATIVE",
      imagingProfile: "GLOBULAR_CLUSTER",
      minAltitudeDegrees: 25,
      expectedMissionMinutes: 30,
    },
  });
  targetId = target.id;
});

describe("the sandbox checkout (#149)", () => {
  beforeEach(() => {
    environment.NODE_ENV = "test";
    environment.PAYMENT_SANDBOX_WEBHOOK_SECRET = "s".repeat(32);
  });

  it("is where a reservation's payment intent redirects", async () => {
    const { paymentIntent } = await reserve();

    expect(paymentIntent).toMatchObject({ provider: "SANDBOX", status: "PENDING" });
    expect(paymentIntent.redirectUrl).toBe(
      `https://darkview.test/api/payments/${paymentIntent.paymentId}/sandbox-checkout`,
    );
  });

  it("confirms the booking and schedules its mission when the owner pays", async () => {
    const { booking, paymentIntent } = await reserve();

    const view = await readSandboxCheckout({ userId, paymentId: paymentIntent.paymentId, now: NOW });
    expect(view).toMatchObject({ ok: true, payable: true, amountMinor: booking.priceMinor });

    const result = await confirmSandboxCheckout({
      userId,
      paymentId: paymentIntent.paymentId,
      result: "CAPTURED",
      now: NOW,
    });

    expect(result).toEqual({
      ok: true,
      applied: true,
      returnUrl: `https://darkview.test/en/app/bookings/${booking.id}`,
    });

    const confirmed = await database.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.missionId).not.toBeNull();

    const payment = await database.payment.findUniqueOrThrow({
      where: { id: paymentIntent.paymentId },
    });
    expect(payment).toMatchObject({
      status: "CAPTURED",
      providerRef: `sandbox-checkout:${paymentIntent.paymentId}`,
      capturedAt: NOW,
    });

    const after = await readSandboxCheckout({ userId, paymentId: paymentIntent.paymentId, now: NOW });
    expect(after).toMatchObject({ ok: true, payable: false, paymentStatus: "CAPTURED" });
  });

  it("treats a second confirmation as a no-op", async () => {
    const { booking, paymentIntent } = await reserve();
    const confirm = () =>
      confirmSandboxCheckout({ userId, paymentId: paymentIntent.paymentId, result: "CAPTURED", now: NOW });

    expect(await confirm()).toMatchObject({ ok: true, applied: true });
    expect(await confirm()).toEqual({
      ok: true,
      applied: false,
      returnUrl: `https://darkview.test/en/app/bookings/${booking.id}`,
    });

    expect(await database.mission.count({ where: { userId } })).toBe(1);
  });

  it("settles two concurrent confirmations once", async () => {
    const { paymentIntent } = await reserve();
    const confirm = () =>
      confirmSandboxCheckout({ userId, paymentId: paymentIntent.paymentId, result: "CAPTURED", now: NOW });

    const results = await Promise.all([confirm(), confirm(), confirm()]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.applied)).toHaveLength(1);
    expect(await database.mission.count({ where: { userId } })).toBe(1);
  });

  it("refuses another user, and says nothing about the payment", async () => {
    const { booking, paymentIntent } = await reserve();
    const stranger = await createUser();

    expect(
      await confirmSandboxCheckout({
        userId: stranger,
        paymentId: paymentIntent.paymentId,
        result: "CAPTURED",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await readSandboxCheckout({ userId: stranger, paymentId: paymentIntent.paymentId, now: NOW }),
    ).toMatchObject({ ok: false, status: 404 });

    const untouched = await database.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(untouched.status).toBe("PENDING_PAYMENT");
  });

  it("refuses a hold that has lapsed, and takes no money", async () => {
    const { booking, paymentIntent } = await reserve();

    const result = await confirmSandboxCheckout({
      userId,
      paymentId: paymentIntent.paymentId,
      result: "CAPTURED",
      now: AFTER_HOLD,
    });

    expect(result).toMatchObject({ ok: false, status: 409, code: "CONFLICT" });
    const payment = await database.payment.findUniqueOrThrow({ where: { id: paymentIntent.paymentId } });
    expect(payment.status).toBe("PENDING");
    const untouched = await database.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(untouched).toMatchObject({ status: "PENDING_PAYMENT", missionId: null });
    expect(
      await readSandboxCheckout({ userId, paymentId: paymentIntent.paymentId, now: AFTER_HOLD }),
    ).toMatchObject({ ok: true, payable: false });
  });

  it("refuses a payment that is not the sandbox's", async () => {
    const { paymentIntent } = await reserve();
    await database.payment.update({
      where: { id: paymentIntent.paymentId },
      data: { provider: "BOG_IPAY" },
    });

    expect(
      await confirmSandboxCheckout({
        userId,
        paymentId: paymentIntent.paymentId,
        result: "CAPTURED",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, status: 409 });
    const payment = await database.payment.findUniqueOrThrow({ where: { id: paymentIntent.paymentId } });
    expect(payment.status).toBe("PENDING");
  });

  it("does not exist in production, or where the sandbox is not configured", async () => {
    const { paymentIntent } = await reserve();
    const confirm = () =>
      confirmSandboxCheckout({ userId, paymentId: paymentIntent.paymentId, result: "CAPTURED", now: NOW });

    environment.NODE_ENV = "production";
    expect(await confirm()).toMatchObject({ ok: false, status: 404 });

    environment.NODE_ENV = "test";
    environment.PAYMENT_SANDBOX_WEBHOOK_SECRET = undefined;
    expect(await confirm()).toMatchObject({ ok: false, status: 404 });

    const payment = await database.payment.findUniqueOrThrow({ where: { id: paymentIntent.paymentId } });
    expect(payment.status).toBe("PENDING");
  });

  it("releases the slot when the owner declines, and will not then take the money", async () => {
    const { booking, paymentIntent } = await reserve();

    expect(
      await confirmSandboxCheckout({ userId, paymentId: paymentIntent.paymentId, result: "FAILED", now: NOW }),
    ).toMatchObject({ ok: true, applied: true });

    const released = await database.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(released.status).not.toBe("PENDING_PAYMENT");
    expect(released.status).not.toBe("CONFIRMED");

    expect(
      await confirmSandboxCheckout({ userId, paymentId: paymentIntent.paymentId, result: "CAPTURED", now: NOW }),
    ).toMatchObject({ ok: false, status: 409 });
  });

  it("returns a Georgian customer to the Georgian booking page", async () => {
    const georgian = await createUser("ka");
    const { booking, paymentIntent } = await reserve(georgian);

    expect(
      await confirmSandboxCheckout({
        userId: georgian,
        paymentId: paymentIntent.paymentId,
        result: "CAPTURED",
        now: NOW,
      }),
    ).toMatchObject({ ok: true, returnUrl: `https://darkview.test/ka/app/bookings/${booking.id}` });
  });
});
