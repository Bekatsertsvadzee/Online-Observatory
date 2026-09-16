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

const { reserveSlot } = await import("@/features/booking/reserve");
const { settlePayment } = await import("@/features/payments/settle");
const { setWeatherHold } = await import("@/features/admin/observatory");
const { nightWindow } = await import("@/lib/slots/darkness");
const { generateSlots, SLOT_DURATION_MINUTES } = await import("@/lib/slots/generate");

/**
 * DV-064: the API's half of the outbox. An email is queued in the transaction of
 * the event that causes it, once, and not at all when the event does not happen.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const SITE = { latitude: 41.7151, longitude: 44.8271, timezone: "Asia/Tbilisi" };
const NOW = new Date("2026-12-15T12:00:00.000Z");
const NIGHT = "2026-12-15";

let database: PrismaClient;
let observatoryId: string;
let telescopeId: string;
let targetId: string;
let userId: string;
let operatorId: string;

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

async function reserve() {
  const result = await reserveSlot({
    userId,
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

function outcome(paymentId: string, amountMinor: number, result: "CAPTURED" | "FAILED" = "CAPTURED") {
  return {
    paymentId,
    providerRef: `sbx_${paymentId.slice(0, 8)}`,
    result,
    amountMinor,
    currency: "GEL" as const,
    failureReason: result === "FAILED" ? ("CARD_DECLINED" as const) : null,
  };
}

async function confirmedBooking(hoursFromNow: number) {
  const row = await database.booking.create({
    data: {
      userId,
      targetId,
      observatoryId,
      telescopeId,
      slotStartAt: new Date(NOW.getTime() + hoursFromNow * 3_600_000),
      durationMinutes: 60,
      status: "CONFIRMED",
      priceMinor: 4500,
    },
  });
  return row.id;
}

const hold = (holdActive: boolean, now = NOW) =>
  setWeatherHold({
    observatoryId,
    request: { holdActive, status: holdActive ? "UNSAFE" : "CLEAR", note: "clouds rolling in" },
    actorUserId: operatorId,
    now,
  });

const outbox = (kind?: string) =>
  database.emailNotification.findMany({
    where: kind ? { kind: kind as never } : {},
    orderBy: { createdAt: "asc" },
  });

beforeAll(async () => {
  database = new PrismaClient({ adapter: new PrismaPg({ connectionString: CONNECTION_STRING }) });
  testDatabase.current = database;
  await database.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(async () => {
  await database.emailNotification.deleteMany();
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
  await database.safetyEnvelope.deleteMany();
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

  const user = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Payer", emailVerifiedAt: NOW },
  });
  userId = user.id;
  const operator = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Operator", role: "OPERATOR" },
  });
  operatorId = operator.id;

  await database.observatoryNetworkNode.create({
    data: {
      ownerId: operatorId,
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

describe("a confirmed booking", () => {
  it("queues its confirmation email with the payment that confirmed it", async () => {
    const { booking, paymentIntent } = await reserve();

    await settlePayment({
      provider: "SANDBOX",
      outcome: outcome(paymentIntent.paymentId, booking.priceMinor),
      now: NOW,
    });

    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "BOOKING_CONFIRMED", userId, status: "PENDING" });
    expect(rows[0].payload).toEqual({ bookingId: booking.id });
  });

  it("queues one email when the payment callback arrives twice", async () => {
    const { booking, paymentIntent } = await reserve();
    const captured = outcome(paymentIntent.paymentId, booking.priceMinor);

    await settlePayment({ provider: "SANDBOX", outcome: captured, now: NOW });
    await settlePayment({ provider: "SANDBOX", outcome: captured, now: NOW });

    expect(await outbox()).toHaveLength(1);
  });

  it("queues nothing when the payment fails", async () => {
    const { booking, paymentIntent } = await reserve();

    await settlePayment({
      provider: "SANDBOX",
      outcome: outcome(paymentIntent.paymentId, booking.priceMinor, "FAILED"),
      now: NOW,
    });

    expect(await outbox()).toEqual([]);
  });

  it("queues nothing when settlement is refused", async () => {
    const { booking, paymentIntent } = await reserve();

    // An amount that does not match the intent: settlement writes nothing.
    await settlePayment({
      provider: "SANDBOX",
      outcome: outcome(paymentIntent.paymentId, booking.priceMinor - 1),
      now: NOW,
    });

    expect(await outbox()).toEqual([]);
  });
});

describe("a weather hold", () => {
  it("tells customers whose slot is within the next day, and nobody else", async () => {
    const tonight = await confirmedBooking(6);
    await confirmedBooking(72);

    await hold(true);

    const rows = await outbox("WEATHER_HOLD");
    expect(rows.map((row) => row.payload)).toEqual([{ bookingId: tonight }]);
  });

  it("does not tell a customer whose slot has already ended", async () => {
    await confirmedBooking(-3);

    await hold(true);

    expect(await outbox("WEATHER_HOLD")).toEqual([]);
  });

  it("says nothing when an active hold is saved again, or cleared", async () => {
    await confirmedBooking(6);

    await hold(true);
    await hold(true, new Date(NOW.getTime() + 60_000));
    await hold(false, new Date(NOW.getTime() + 120_000));

    expect(await outbox("WEATHER_HOLD")).toHaveLength(1);
  });

  it("tells them again when a new hold goes on after one was cleared", async () => {
    await confirmedBooking(6);

    await hold(true);
    await hold(false, new Date(NOW.getTime() + 60_000));
    await hold(true, new Date(NOW.getTime() + 120_000));

    expect(await outbox("WEATHER_HOLD")).toHaveLength(2);
  });
});
