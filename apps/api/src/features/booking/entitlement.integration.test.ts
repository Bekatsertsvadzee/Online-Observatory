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
const { getMyBooking } = await import("@/features/booking/manage");
const { refundMyBooking, rescheduleMyBooking } = await import("@/features/booking/entitlement");
const { nightWindow } = await import("@/lib/slots/darkness");
const { generateSlots, SLOT_DURATION_MINUTES } = await import("@/lib/slots/generate");
const { zBooking } = await import("@darkview/contracts/zod");

/**
 * DV-111, the customer's half, against a real PostgreSQL instance.
 *
 * The entitlement is created by the realtime service's evaluation, which has its
 * own suite; here it is a fixture. What is proved is spending it: a refund returns
 * the money once, a reschedule books a real free slot, and the two cannot both
 * happen to one entitlement.
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

/** A confirmed, paid booking, the way a customer gets one, with an entitlement on it. */
async function entitledBooking(
  options: { outcome?: "OPEN" | "NONE"; expiresAt?: Date; slot?: number } = {},
) {
  const reserved = await reserveSlot({
    userId,
    request: {
      observatoryId,
      targetId,
      slotStartAt: slotStartAt(options.slot ?? 0).toISOString(),
      durationMinutes: SLOT_DURATION_MINUTES,
    },
    idempotencyKey: null,
    now: NOW,
  });
  if (!reserved.ok) throw new Error(`fixture reservation failed: ${reserved.message}`);
  const { booking } = reserved.body;
  const paymentIntent = reserved.body.paymentIntent!;
  await settlePayment({
    provider: "SANDBOX",
    outcome: {
      paymentId: paymentIntent.paymentId,
      providerRef: `sbx_${paymentIntent.paymentId.slice(0, 8)}`,
      result: "CAPTURED",
      amountMinor: booking.priceMinor,
      currency: "GEL",
      failureReason: null,
    },
    now: NOW,
  });

  const outcome = options.outcome ?? "OPEN";
  await database.bookingEntitlement.create({
    data: {
      bookingId: booking.id,
      userId,
      outcome,
      cause: outcome === "OPEN" ? "WEATHER" : null,
      minutesLost: outcome === "OPEN" ? 45 : 5,
      evaluatedAt: NOW,
      expiresAt: outcome === "OPEN" ? (options.expiresAt ?? new Date(NOW.getTime() + 30 * 86_400_000)) : null,
    },
  });
  return { bookingId: booking.id, paymentId: paymentIntent.paymentId };
}

beforeAll(async () => {
  database = new PrismaClient({ adapter: new PrismaPg({ connectionString: CONNECTION_STRING }) });
  testDatabase.current = database;
  await database.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(async () => {
  await database.bookingEntitlement.deleteMany();
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
    data: { email: `${randomUUID()}@example.test`, name: "Customer", emailVerifiedAt: NOW },
  });
  userId = user.id;
  const operator = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Operator", role: "OPERATOR" },
  });

  await database.observatoryNetworkNode.create({
    data: {
      ownerId: operator.id,
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

describe("reading a booking", () => {
  it("shows an open entitlement, and hides one where nothing was owed", async () => {
    const open = await entitledBooking();
    const none = await entitledBooking({ outcome: "NONE", slot: 1 });

    const shown = await getMyBooking({ userId, bookingId: open.bookingId });
    expect(() => zBooking.parse(shown)).not.toThrow();
    expect(shown?.entitlement).toMatchObject({ status: "OPEN", cause: "WEATHER", minutesLost: 45 });

    expect((await getMyBooking({ userId, bookingId: none.bookingId }))?.entitlement).toBeNull();
  });
});

describe("taking the refund", () => {
  it("returns the payment, once", async () => {
    const { bookingId, paymentId } = await entitledBooking();

    const result = await refundMyBooking({ userId, bookingId, now: NOW });

    expect(result).toMatchObject({
      ok: true,
      booking: { status: "REFUNDED", entitlement: { status: "REFUNDED" } },
    });
    expect((await database.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe(
      "REFUNDED",
    );
    await expect(refundMyBooking({ userId, bookingId, now: NOW })).resolves.toMatchObject({
      status: 409,
    });
    expect(await database.auditLog.count({ where: { action: "PAYMENT_REFUNDED" } })).toBe(1);
  });

  it("answers somebody else's booking with 404", async () => {
    const { bookingId } = await entitledBooking();
    const stranger = await database.user.create({
      data: { email: `${randomUUID()}@example.test`, name: "Stranger", emailVerifiedAt: NOW },
    });

    await expect(
      refundMyBooking({ userId: stranger.id, bookingId, now: NOW }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("refuses a booking whose slot owed nothing", async () => {
    const { bookingId } = await entitledBooking({ outcome: "NONE" });

    await expect(refundMyBooking({ userId, bookingId, now: NOW })).resolves.toMatchObject({
      status: 409,
    });
  });

  it("keeps the entitlement open on a provider with no refund integration", async () => {
    const { bookingId, paymentId } = await entitledBooking();
    await database.payment.update({ where: { id: paymentId }, data: { provider: "BOG_IPAY" } });

    await expect(refundMyBooking({ userId, bookingId, now: NOW })).resolves.toMatchObject({
      status: 503,
    });
    expect((await database.bookingEntitlement.findUniqueOrThrow({ where: { bookingId } })).outcome).toBe(
      "OPEN",
    );
  });
});

describe("taking a free reschedule", () => {
  it("books a confirmed, free slot on the same telescope and spends the entitlement", async () => {
    const { bookingId } = await entitledBooking();
    const replacementAt = slotStartAt(2);

    const result = await rescheduleMyBooking({
      userId,
      bookingId,
      request: { slotStartAt: replacementAt.toISOString() },
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => zBooking.parse(result.booking)).not.toThrow();
    expect(result.booking).toMatchObject({
      status: "CONFIRMED",
      priceMinor: 0,
      paymentId: null,
      observatoryId,
      slotStartAt: replacementAt.toISOString(),
      durationMinutes: SLOT_DURATION_MINUTES,
    });

    const mission = await database.mission.findUniqueOrThrow({
      where: { id: result.booking.missionId! },
    });
    expect(mission).toMatchObject({ state: "SCHEDULED", scheduledFor: replacementAt });

    const original = await getMyBooking({ userId, bookingId });
    expect(original?.entitlement).toMatchObject({
      status: "RESCHEDULED",
      rescheduledBookingId: result.booking.id,
    });
    expect(
      await database.emailNotification.count({
        where: { kind: "BOOKING_CONFIRMED", dedupeKey: `booking-confirmed:${result.booking.id}` },
      }),
    ).toBe(1);
  });

  it("refuses an instant that is not an offered slot, and keeps the entitlement", async () => {
    const { bookingId } = await entitledBooking();

    await expect(
      rescheduleMyBooking({
        userId,
        bookingId,
        request: { slotStartAt: new Date(slotStartAt(2).getTime() + 7 * 60_000).toISOString() },
        now: NOW,
      }),
    ).resolves.toMatchObject({ status: 422 });
    expect((await database.bookingEntitlement.findUniqueOrThrow({ where: { bookingId } })).outcome).toBe(
      "OPEN",
    );
  });

  it("refuses a changed target the slot is too short to deliver, and keeps the entitlement", async () => {
    const { bookingId } = await entitledBooking();
    const long = await database.target.create({
      data: {
        slug: `m42-${randomUUID()}`,
        nameEn: "M42",
        nameKa: "M42",
        type: "BRIGHT_NEBULA",
        positionSource: "FIXED",
        rightAscensionHours: 5.5881,
        declinationDegrees: -5.391,
        angularSizeArcmin: 65,
        magnitude: 4,
        opticalConfig: "F10_NATIVE",
        imagingProfile: "BRIGHT_NEBULA",
        minAltitudeDegrees: 25,
        expectedMissionMinutes: SLOT_DURATION_MINUTES + 1,
      },
    });

    await expect(
      rescheduleMyBooking({
        userId,
        bookingId,
        request: { slotStartAt: slotStartAt(2).toISOString(), targetId: long.id },
        now: NOW,
      }),
    ).resolves.toMatchObject({ ok: false, status: 422, code: "VALIDATION_FAILED" });
    expect((await database.bookingEntitlement.findUniqueOrThrow({ where: { bookingId } })).outcome).toBe(
      "OPEN",
    );
  });

  it("accepts a changed target that fits the slot", async () => {
    const { bookingId } = await entitledBooking();
    const short = await database.target.create({
      data: {
        slug: `albireo-${randomUUID()}`,
        nameEn: "Albireo",
        nameKa: "Albireo",
        type: "DOUBLE_STAR",
        positionSource: "FIXED",
        rightAscensionHours: 19.512,
        declinationDegrees: 27.9597,
        angularSizeArcmin: 1,
        magnitude: 3.1,
        opticalConfig: "F10_NATIVE",
        imagingProfile: "DOUBLE_STAR",
        minAltitudeDegrees: 25,
        expectedMissionMinutes: 15,
      },
    });

    const result = await rescheduleMyBooking({
      userId,
      bookingId,
      request: { slotStartAt: slotStartAt(2).toISOString(), targetId: short.id },
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.booking.targetId).toBe(short.id);
  });

  it("refuses a slot somebody else holds, and keeps the entitlement", async () => {
    const { bookingId } = await entitledBooking();
    await entitledBooking({ outcome: "NONE", slot: 1 });

    await expect(
      rescheduleMyBooking({
        userId,
        bookingId,
        request: { slotStartAt: slotStartAt(1).toISOString() },
        now: NOW,
      }),
    ).resolves.toMatchObject({ status: 409, code: "SLOT_UNAVAILABLE" });
    expect((await database.bookingEntitlement.findUniqueOrThrow({ where: { bookingId } })).outcome).toBe(
      "OPEN",
    );
    expect(await database.booking.count({ where: { priceMinor: 0 } })).toBe(0);
  });

  it("refuses once the thirty days have passed", async () => {
    const { bookingId } = await entitledBooking({ expiresAt: new Date(NOW.getTime() - 1_000) });

    await expect(
      rescheduleMyBooking({
        userId,
        bookingId,
        request: { slotStartAt: slotStartAt(2).toISOString() },
        now: NOW,
      }),
    ).resolves.toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it("lets exactly one of a refund and a reschedule racing on one entitlement succeed", async () => {
    const { bookingId } = await entitledBooking();

    const results = await Promise.all([
      refundMyBooking({ userId, bookingId, now: NOW }),
      rescheduleMyBooking({
        userId,
        bookingId,
        request: { slotStartAt: slotStartAt(2).toISOString() },
        now: NOW,
      }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const entitlement = await database.bookingEntitlement.findUniqueOrThrow({ where: { bookingId } });
    expect(["REFUNDED", "RESCHEDULED"]).toContain(entitlement.outcome);
    expect(await database.booking.count({ where: { priceMinor: 0 } })).toBe(
      entitlement.outcome === "RESCHEDULED" ? 1 : 0,
    );
  });
});
