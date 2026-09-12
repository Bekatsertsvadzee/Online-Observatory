import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({ NODE_ENV: process.env.NODE_ENV ?? "test" }),
}));

const { PAYMENT_HOLD_MINUTES, reserveSlot } = await import("@/features/booking/reserve");
const { settlePayment } = await import("@/features/payments/settle");
const { nightWindow } = await import("@/lib/slots/darkness");
const { generateSlots, SLOT_DURATION_MINUTES } = await import("@/lib/slots/generate");

/**
 * DV-056 runs against a real PostgreSQL instance for the same reason DV-055 does:
 * the claims under test are about row locks and a unique index. A duplicate
 * callback must find the first one's row locked, not race it; a mocked client
 * has no locks and would only prove that the code does what the code does.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const POOL_SIZE = 32;
const CONCURRENT_CALLBACKS = 20;

const SITE = { latitude: 41.7151, longitude: 44.8271, timezone: "Asia/Tbilisi" };
const NOW = new Date("2026-12-15T12:00:00.000Z");
const NIGHT = "2026-12-15";
/** After the hold has lapsed, before the slot itself has. */
const AFTER_HOLD = new Date(NOW.getTime() + (PAYMENT_HOLD_MINUTES + 1) * 60_000);

let database: PrismaClient;
let observatoryId: string;
let telescopeId: string;
let targetId: string;
let userId: string;

/** The nth bookable slot of the fixture night, taken from the generator itself. */
function slotStartAt(index: number): Date {
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
  }).filter((candidate) => candidate.available)[index];
  if (!slot) throw new Error(`no available slot ${index} on the fixture night`);
  return new Date(slot.startAt);
}

function firstSlotStartAt(): Date {
  return slotStartAt(0);
}

async function createUser(): Promise<string> {
  const user = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Payer", emailVerifiedAt: NOW },
  });
  return user.id;
}

async function reserve(options: { userId?: string; slotStartAt?: Date; now?: Date } = {}) {
  const result = await reserveSlot({
    userId: options.userId ?? userId,
    request: {
      observatoryId,
      targetId,
      slotStartAt: (options.slotStartAt ?? firstSlotStartAt()).toISOString(),
      durationMinutes: SLOT_DURATION_MINUTES,
    },
    idempotencyKey: null,
    now: options.now ?? NOW,
  });
  if (!result.ok) throw new Error(`fixture reservation failed: ${result.message}`);
  return result.body;
}

function captured(paymentId: string, overrides: Partial<Parameters<typeof settlePayment>[0]["outcome"]> = {}) {
  return {
    paymentId,
    providerRef: `sbx_${paymentId.slice(0, 8)}`,
    result: "CAPTURED" as const,
    amountMinor: 4500,
    currency: "GEL" as const,
    failureReason: null,
    ...overrides,
  };
}

async function auditActions(entityId: string) {
  const rows = await database.auditLog.findMany({
    where: { OR: [{ entityId }, { missionId: entityId }] },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => row.action);
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING, max: POOL_SIZE }),
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

describe("a captured payment", () => {
  it("confirms the booking and schedules its mission", async () => {
    const { booking, paymentIntent } = await reserve();
    const price = booking.priceMinor;

    const result = await settlePayment({
      provider: "SANDBOX",
      outcome: captured(paymentIntent.paymentId, { amountMinor: price }),
      now: NOW,
    });

    expect(result).toMatchObject({ ok: true, applied: true, missionId: expect.any(String) });
    if (!result.ok) return;

    const payment = await database.payment.findUniqueOrThrow({
      where: { id: paymentIntent.paymentId },
    });
    expect(payment).toMatchObject({
      status: "CAPTURED",
      providerRef: `sbx_${paymentIntent.paymentId.slice(0, 8)}`,
      capturedAt: NOW,
    });

    const confirmed = await database.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(confirmed).toMatchObject({ status: "CONFIRMED", missionId: result.missionId });

    const mission = await database.mission.findUniqueOrThrow({
      where: { id: result.missionId! },
      include: { events: true },
    });
    expect(mission).toMatchObject({
      userId,
      targetId,
      observatoryId,
      telescopeId,
      state: "SCHEDULED",
      mode: "SIMULATED",
      scheduledFor: new Date(booking.slotStartAt),
      requestedAt: NOW,
    });
    expect(mission.events).toEqual([
      expect.objectContaining({ state: "SCHEDULED", source: "CLOUD", simulated: true }),
    ]);

    expect(await auditActions(paymentIntent.paymentId)).toEqual(["PAYMENT_CAPTURED"]);
    expect(await auditActions(mission.id)).toEqual(["PAYMENT_CAPTURED", "MISSION_SCHEDULED"]);
  });

  it("applies a repeated callback once, and schedules one mission", async () => {
    const { booking, paymentIntent } = await reserve();
    const outcome = captured(paymentIntent.paymentId, { amountMinor: booking.priceMinor });

    const first = await settlePayment({ provider: "SANDBOX", outcome, now: NOW });
    const second = await settlePayment({ provider: "SANDBOX", outcome, now: NOW });

    expect(first).toMatchObject({ ok: true, applied: true });
    expect(second).toMatchObject({
      ok: true,
      applied: false,
      missionId: first.ok ? first.missionId : null,
    });
    expect(await database.mission.count()).toBe(1);
    expect(await auditActions(paymentIntent.paymentId)).toEqual(["PAYMENT_CAPTURED"]);
  });

  it("schedules exactly one mission when the same callback arrives many times at once", async () => {
    const { booking, paymentIntent } = await reserve();
    const outcome = captured(paymentIntent.paymentId, { amountMinor: booking.priceMinor });

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_CALLBACKS }, () =>
        settlePayment({ provider: "SANDBOX", outcome, now: NOW }),
      ),
    );

    expect(results.filter((result) => result.ok && result.applied)).toHaveLength(1);
    expect(results.filter((result) => result.ok && !result.applied)).toHaveLength(
      CONCURRENT_CALLBACKS - 1,
    );
    expect(await database.mission.count()).toBe(1);
    expect(await auditActions(paymentIntent.paymentId)).toEqual(["PAYMENT_CAPTURED"]);
  });

  it("refuses a later callback that contradicts the first, and keeps the mission", async () => {
    const { booking, paymentIntent } = await reserve();
    await settlePayment({
      provider: "SANDBOX",
      outcome: captured(paymentIntent.paymentId, { amountMinor: booking.priceMinor }),
      now: NOW,
    });

    const contradiction = await settlePayment({
      provider: "SANDBOX",
      outcome: captured(paymentIntent.paymentId, {
        amountMinor: booking.priceMinor,
        result: "FAILED",
        failureReason: "CARD_DECLINED",
      }),
      now: NOW,
    });

    expect(contradiction).toMatchObject({ ok: false, status: 400 });
    expect(await database.booking.findUniqueOrThrow({ where: { id: booking.id } })).toMatchObject(
      { status: "CONFIRMED" },
    );
    expect(await database.mission.count()).toBe(1);
    expect(await auditActions(paymentIntent.paymentId)).toEqual([
      "PAYMENT_CAPTURED",
      "PAYMENT_WEBHOOK_REFUSED",
    ]);
  });

  it("still confirms a hold that lapsed but was never swept", async () => {
    // The booking is still PENDING_PAYMENT and still inside the exclusion
    // constraint; nobody else holds the slot. Being late only costs the customer
    // the slot if somebody else took it first.
    const { booking, paymentIntent } = await reserve();

    const result = await settlePayment({
      provider: "SANDBOX",
      outcome: captured(paymentIntent.paymentId, { amountMinor: booking.priceMinor }),
      now: AFTER_HOLD,
    });

    expect(result).toMatchObject({ ok: true, applied: true, missionId: expect.any(String) });
    expect(await database.booking.findUniqueOrThrow({ where: { id: booking.id } })).toMatchObject(
      { status: "CONFIRMED" },
    );
  });

  it("records a capture whose slot went to somebody else, and creates no mission", async () => {
    const slotStartAt = firstSlotStartAt();
    const late = await reserve({ slotStartAt });

    // Another customer reserves after the hold lapses. Their reservation sweeps
    // the lapsed hold to EXPIRED and takes the slot.
    const other = await reserve({ userId: await createUser(), slotStartAt, now: AFTER_HOLD });
    expect(
      await database.booking.findUniqueOrThrow({ where: { id: late.booking.id } }),
    ).toMatchObject({ status: "EXPIRED" });

    const result = await settlePayment({
      provider: "SANDBOX",
      outcome: captured(late.paymentIntent.paymentId, { amountMinor: late.booking.priceMinor }),
      now: AFTER_HOLD,
    });

    expect(result).toEqual({ ok: true, applied: true, missionId: null });
    expect(
      await database.payment.findUniqueOrThrow({ where: { id: late.paymentIntent.paymentId } }),
    ).toMatchObject({ status: "CAPTURED" });
    expect(
      await database.booking.findUniqueOrThrow({ where: { id: late.booking.id } }),
    ).toMatchObject({ status: "EXPIRED", missionId: null });
    expect(
      await database.booking.findUniqueOrThrow({ where: { id: other.booking.id } }),
    ).toMatchObject({ status: "PENDING_PAYMENT" });
    expect(await database.mission.count()).toBe(0);
    expect(await auditActions(late.paymentIntent.paymentId)).toEqual([
      "PAYMENT_CAPTURED_WITHOUT_SLOT",
    ]);
  });
});

describe("a failed payment", () => {
  it("releases the slot and creates no mission", async () => {
    const { booking, paymentIntent } = await reserve();

    const result = await settlePayment({
      provider: "SANDBOX",
      outcome: captured(paymentIntent.paymentId, {
        amountMinor: booking.priceMinor,
        result: "FAILED",
        failureReason: "CARD_DECLINED",
      }),
      now: NOW,
    });

    expect(result).toEqual({ ok: true, applied: true, missionId: null });
    expect(
      await database.payment.findUniqueOrThrow({ where: { id: paymentIntent.paymentId } }),
    ).toMatchObject({ status: "FAILED", failureReason: "CARD_DECLINED" });
    expect(await database.booking.findUniqueOrThrow({ where: { id: booking.id } })).toMatchObject(
      { status: "CANCELLED", missionId: null },
    );
    expect(await database.mission.count()).toBe(0);

    // The slot is on sale again: somebody else can take it at once.
    const next = await reserve({ userId: await createUser() });
    expect(next.booking.slotStartAt).toBe(booking.slotStartAt);

    expect(await auditActions(booking.id)).toEqual(["BOOKING_RESERVED", "BOOKING_SLOT_RELEASED"]);
    expect(await auditActions(paymentIntent.paymentId)).toEqual(["PAYMENT_FAILED"]);
  });
});

describe("a callback that does not fit the records", () => {
  it("is refused when it names a payment that does not exist", async () => {
    const result = await settlePayment({
      provider: "SANDBOX",
      outcome: captured(randomUUID()),
      now: NOW,
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(await database.auditLog.count({ where: { action: "PAYMENT_WEBHOOK_REFUSED" } })).toBe(1);
  });

  it("is refused when the amount differs from the intent, and changes nothing", async () => {
    const { booking, paymentIntent } = await reserve();

    const result = await settlePayment({
      provider: "SANDBOX",
      outcome: captured(paymentIntent.paymentId, { amountMinor: booking.priceMinor - 1 }),
      now: NOW,
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(
      await database.payment.findUniqueOrThrow({ where: { id: paymentIntent.paymentId } }),
    ).toMatchObject({ status: "PENDING", providerRef: null });
    expect(await database.booking.findUniqueOrThrow({ where: { id: booking.id } })).toMatchObject(
      { status: "PENDING_PAYMENT" },
    );
    expect(await database.mission.count()).toBe(0);
  });

  it("is refused when it comes from a provider the payment was not opened with", async () => {
    const { booking, paymentIntent } = await reserve();

    const result = await settlePayment({
      provider: "BOG_IPAY",
      outcome: captured(paymentIntent.paymentId, { amountMinor: booking.priceMinor }),
      now: NOW,
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(
      await database.payment.findUniqueOrThrow({ where: { id: paymentIntent.paymentId } }),
    ).toMatchObject({ status: "PENDING" });
  });

  it("is refused when it reuses a provider reference from another payment", async () => {
    const first = await reserve();
    const second = await reserve({ userId: await createUser(), slotStartAt: slotStartAt(1) });
    const providerRef = "sbx_reused";

    await settlePayment({
      provider: "SANDBOX",
      outcome: captured(first.paymentIntent.paymentId, {
        amountMinor: first.booking.priceMinor,
        providerRef,
      }),
      now: NOW,
    });
    const result = await settlePayment({
      provider: "SANDBOX",
      outcome: captured(second.paymentIntent.paymentId, {
        amountMinor: second.booking.priceMinor,
        providerRef,
      }),
      now: NOW,
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(
      await database.payment.findUniqueOrThrow({ where: { id: second.paymentIntent.paymentId } }),
    ).toMatchObject({ status: "PENDING" });
    expect(await database.mission.count()).toBe(1);
  });
});
