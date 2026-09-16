import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@darkview/db";

import {
  evaluateEndedSlots,
  refundExpiredEntitlements,
  RESCHEDULE_WINDOW_DAYS,
} from "@/refunds/entitlements";

/**
 * DV-111 against a real PostgreSQL instance.
 *
 * The rules under test are the maintainer's of 2026-09-15: half the slot or more
 * lost to weather or to us entitles the customer to a refund or a reschedule, a
 * no-show and a customer who ended the session get nothing, and thirty days unused
 * becomes a refund. What only a database can show is that the minutes are read
 * from the rows the hold, the link and the mission already write.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const NOW = new Date("2026-12-15T22:00:00.000Z");
/** The slot under test runs 20:00 to 21:00, an hour before NOW. */
const SLOT_START = new Date("2026-12-15T20:00:00.000Z");
const at = (hhmm: string) => new Date(`2026-12-15T${hhmm}:00.000Z`);

let database: PrismaClient;
let observatoryId: string;
let telescopeId: string;
let targetId: string;
let userId: string;

async function paidBooking(
  options: {
    slotStartAt?: Date;
    durationMinutes?: number;
    provider?: "SANDBOX" | "BOG_IPAY";
  } = {},
) {
  const payment = await database.payment.create({
    data: {
      userId,
      provider: options.provider ?? "SANDBOX",
      status: "CAPTURED",
      amountMinor: 4500,
      capturedAt: at("12:00"),
      providerRef: `ref-${randomUUID()}`,
    },
  });
  const booking = await database.booking.create({
    data: {
      userId,
      targetId,
      observatoryId,
      telescopeId,
      paymentId: payment.id,
      slotStartAt: options.slotStartAt ?? SLOT_START,
      durationMinutes: options.durationMinutes ?? 60,
      status: "CONFIRMED",
      priceMinor: 4500,
    },
  });
  return { bookingId: booking.id, paymentId: payment.id };
}

/** A mission for a booking, ending in `state` at `endedAt`. */
async function missionFor(
  bookingId: string,
  state: "COMPLETE" | "FAILED" | "CANCELLED" | "WEATHER_HOLD",
  failureReason: string | null,
  endedAt: Date,
) {
  const mission = await database.mission.create({
    data: {
      userId,
      targetId,
      observatoryId,
      telescopeId,
      state,
      failureReason: failureReason as never,
      scheduledFor: SLOT_START,
    },
  });
  await database.missionEvent.create({
    data: { missionId: mission.id, state: "PREPARING", source: "CLOUD", occurredAt: SLOT_START },
  });
  await database.missionEvent.create({
    data: {
      missionId: mission.id,
      state,
      failureReason: failureReason as never,
      source: "AGENT",
      occurredAt: endedAt,
    },
  });
  await database.booking.update({ where: { id: bookingId }, data: { missionId: mission.id } });
  return mission.id;
}

/** An audit row as the hold or the link writes it, at a chosen instant. */
function observatoryEvent(action: string, createdAt: Date) {
  return database.auditLog.create({
    data: {
      category: action.startsWith("WEATHER") ? "SAFETY" : "AGENT_LINK",
      action,
      entityType: "Observatory",
      entityId: observatoryId,
      createdAt,
    },
  });
}

const entitlementOf = (bookingId: string) =>
  database.bookingEntitlement.findUniqueOrThrow({ where: { bookingId } });

beforeAll(async () => {
  database = new PrismaClient({ adapter: new PrismaPg({ connectionString: CONNECTION_STRING }) });
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
  await database.auditLog.deleteMany();
  await database.missionParticipant.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  await database.missionEvent.deleteMany();
  await database.observerPack.deleteMany();
  await database.booking.deleteMany();
  await database.mission.deleteMany();
  await database.payment.deleteMany();
  await database.safetyEnvelope.deleteMany();
  await database.telescope.deleteMany();
  await database.target.deleteMany();
  await database.weatherState.deleteMany();
  await database.agentMessage.deleteMany();
  await database.observatory.deleteMany();
  await database.user.deleteMany();

  const observatory = await database.observatory.create({
    data: {
      slug: `test-${randomUUID()}`,
      nameEn: "Test Observatory",
      nameKa: "სატესტო ობსერვატორია",
      city: "Tbilisi",
      countryCode: "GE",
      latitude: 41.7151,
      longitude: 44.8271,
      timezone: "Asia/Tbilisi",
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
    },
  });
  telescopeId = telescope.id;

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

  const user = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Customer", emailVerifiedAt: NOW },
  });
  userId = user.id;
});

describe("judging an ended slot", () => {
  it("owes nothing for a mission that completed with the observatory up", async () => {
    const { bookingId } = await paidBooking();
    await missionFor(bookingId, "COMPLETE", null, at("20:55"));

    await evaluateEndedSlots(database, NOW);

    expect(await entitlementOf(bookingId)).toMatchObject({ outcome: "NONE", minutesLost: 0, cause: null });
  });

  it("offers a refund or reschedule when the link was down for half the slot or more", async () => {
    const { bookingId } = await paidBooking();
    await missionFor(bookingId, "COMPLETE", null, at("20:58"));
    await observatoryEvent("AGENT_LINK_LOST", at("20:10"));
    await observatoryEvent("AGENT_LINK_UP", at("20:50"));

    await expect(evaluateEndedSlots(database, NOW)).resolves.toBe(1);

    expect(await entitlementOf(bookingId)).toMatchObject({
      outcome: "OPEN",
      cause: "OBSERVATORY_FAULT",
      minutesLost: 40,
      expiresAt: new Date(NOW.getTime() + RESCHEDULE_WINDOW_DAYS * 86_400_000),
    });
    expect(
      await database.emailNotification.count({ where: { kind: "ENTITLEMENT_AVAILABLE", userId } }),
    ).toBe(1);
    expect(
      await database.auditLog.count({ where: { action: "BOOKING_ENTITLEMENT_GRANTED", entityId: bookingId } }),
    ).toBe(1);
  });

  it("owes nothing when less than half the slot was lost", async () => {
    const { bookingId } = await paidBooking();
    await missionFor(bookingId, "COMPLETE", null, at("20:58"));
    await observatoryEvent("AGENT_LINK_LOST", at("20:40"));
    await observatoryEvent("AGENT_LINK_UP", at("20:55"));

    await evaluateEndedSlots(database, NOW);

    expect(await entitlementOf(bookingId)).toMatchObject({ outcome: "NONE", minutesLost: 15 });
    expect(await database.emailNotification.count()).toBe(0);
  });

  it("counts the rest of the slot after a telescope fault ended the mission", async () => {
    const { bookingId } = await paidBooking();
    await missionFor(bookingId, "FAILED", "MOUNT_FAULT", at("20:20"));

    await evaluateEndedSlots(database, NOW);

    expect(await entitlementOf(bookingId)).toMatchObject({
      outcome: "OPEN",
      cause: "OBSERVATORY_FAULT",
      minutesLost: 40,
    });
  });

  it("does not treat a slot the observatory was closed for as a no-show", async () => {
    const { bookingId } = await paidBooking();
    await missionFor(bookingId, "CANCELLED", "SESSION_EXPIRED", at("21:00"));
    await observatoryEvent("WEATHER_HOLD_SET", at("19:00"));

    await evaluateEndedSlots(database, NOW);

    expect(await entitlementOf(bookingId)).toMatchObject({
      outcome: "OPEN",
      cause: "WEATHER",
      minutesLost: 60,
    });
  });

  it("counts an outage that began more than a week before the slot and never ended", async () => {
    const { bookingId } = await paidBooking();
    await missionFor(bookingId, "CANCELLED", "SESSION_EXPIRED", at("21:00"));
    await observatoryEvent("AGENT_LINK_UP", new Date("2026-12-01T18:00:00.000Z"));
    await observatoryEvent("AGENT_LINK_LOST", new Date("2026-12-05T18:00:00.000Z"));

    await evaluateEndedSlots(database, NOW);

    expect(await entitlementOf(bookingId)).toMatchObject({
      outcome: "OPEN",
      cause: "OBSERVATORY_FAULT",
      minutesLost: 60,
    });
  });

  it("does not count an outage that ended before the slot began", async () => {
    const { bookingId } = await paidBooking();
    await missionFor(bookingId, "CANCELLED", "SESSION_EXPIRED", at("21:00"));
    await observatoryEvent("AGENT_LINK_LOST", new Date("2026-12-05T18:00:00.000Z"));
    await observatoryEvent("AGENT_LINK_UP", at("19:30"));

    await evaluateEndedSlots(database, NOW);

    expect(await entitlementOf(bookingId)).toMatchObject({ outcome: "NONE", minutesLost: 0 });
  });

  it("owes a real no-show nothing", async () => {
    const { bookingId } = await paidBooking();
    await missionFor(bookingId, "CANCELLED", "SESSION_EXPIRED", at("21:00"));

    await evaluateEndedSlots(database, NOW);

    expect(await entitlementOf(bookingId)).toMatchObject({ outcome: "NONE", minutesLost: 0 });
  });

  it("owes nothing to a customer who ended the session themselves", async () => {
    const { bookingId } = await paidBooking();
    await missionFor(bookingId, "CANCELLED", "CUSTOMER_CANCELLED", at("20:05"));
    await observatoryEvent("AGENT_LINK_LOST", at("20:10"));

    await evaluateEndedSlots(database, NOW);

    expect(await entitlementOf(bookingId)).toMatchObject({ outcome: "NONE" });
  });

  it("counts overlapping weather and outage once, credited to weather", async () => {
    const { bookingId } = await paidBooking();
    await missionFor(bookingId, "COMPLETE", null, at("20:59"));
    await observatoryEvent("WEATHER_HOLD_SET", at("20:00"));
    await observatoryEvent("AGENT_LINK_LOST", at("20:20"));
    await observatoryEvent("WEATHER_HOLD_CLEARED", at("20:40"));
    await observatoryEvent("AGENT_LINK_UP", at("20:50"));

    await evaluateEndedSlots(database, NOW);

    expect(await entitlementOf(bookingId)).toMatchObject({
      outcome: "OPEN",
      cause: "WEATHER",
      minutesLost: 50,
    });
  });

  it("leaves a slot that has not finished alone, and judges each slot once", async () => {
    const later = await paidBooking({ slotStartAt: at("21:30") });
    const { bookingId } = await paidBooking();
    await missionFor(bookingId, "FAILED", "CAMERA_FAULT", at("20:10"));

    await evaluateEndedSlots(database, NOW);
    await expect(evaluateEndedSlots(database, new Date(NOW.getTime() + 60_000))).resolves.toBe(0);

    expect(await database.bookingEntitlement.count({ where: { bookingId: later.bookingId } })).toBe(0);
    expect(await database.bookingEntitlement.count({ where: { bookingId } })).toBe(1);
    expect(await database.emailNotification.count({ where: { kind: "ENTITLEMENT_AVAILABLE" } })).toBe(1);
  });
});

describe("an entitlement nobody used for thirty days", () => {
  async function openEntitlement(bookingId: string, expiresAt: Date) {
    await database.bookingEntitlement.create({
      data: {
        bookingId,
        userId,
        outcome: "OPEN",
        cause: "WEATHER",
        minutesLost: 60,
        evaluatedAt: at("21:10"),
        expiresAt,
      },
    });
  }

  it("is refunded automatically, and the customer is told", async () => {
    const { bookingId, paymentId } = await paidBooking();
    await openEntitlement(bookingId, new Date(NOW.getTime() - 1_000));

    await expect(refundExpiredEntitlements(database, NOW)).resolves.toEqual({
      refunded: 1,
      unrefundable: 0,
    });

    expect(await entitlementOf(bookingId)).toMatchObject({ outcome: "REFUNDED", resolvedAt: NOW });
    expect(await database.booking.findUniqueOrThrow({ where: { id: bookingId } })).toMatchObject({
      status: "REFUNDED",
    });
    expect(await database.payment.findUniqueOrThrow({ where: { id: paymentId } })).toMatchObject({
      status: "REFUNDED",
      refundedAt: NOW,
    });
    const audit = await database.auditLog.findFirstOrThrow({ where: { action: "PAYMENT_REFUNDED" } });
    expect(audit.metadata).toMatchObject({ bookingId, automatic: true });
    expect(await database.emailNotification.count({ where: { kind: "BOOKING_REFUNDED" } })).toBe(1);
  });

  it("is left alone before it expires", async () => {
    const { bookingId } = await paidBooking();
    await openEntitlement(bookingId, new Date(NOW.getTime() + 60_000));

    await expect(refundExpiredEntitlements(database, NOW)).resolves.toEqual({
      refunded: 0,
      unrefundable: 0,
    });
    expect((await entitlementOf(bookingId)).outcome).toBe("OPEN");
  });

  it("stays open, and is counted, on a provider with no refund integration", async () => {
    const { bookingId, paymentId } = await paidBooking({ provider: "BOG_IPAY" });
    await openEntitlement(bookingId, new Date(NOW.getTime() - 1_000));

    await expect(refundExpiredEntitlements(database, NOW)).resolves.toEqual({
      refunded: 0,
      unrefundable: 1,
    });
    expect((await entitlementOf(bookingId)).outcome).toBe("OPEN");
    expect((await database.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe(
      "CAPTURED",
    );
  });

  it("refunds the original payment for a free reschedule that was lost too", async () => {
    const original = await paidBooking({ slotStartAt: at("18:00") });
    const replacement = await database.booking.create({
      data: {
        userId,
        targetId,
        observatoryId,
        telescopeId,
        slotStartAt: SLOT_START,
        durationMinutes: 60,
        status: "CONFIRMED",
        priceMinor: 0,
      },
    });
    await database.bookingEntitlement.create({
      data: {
        bookingId: original.bookingId,
        userId,
        outcome: "RESCHEDULED",
        cause: "OBSERVATORY_FAULT",
        minutesLost: 45,
        evaluatedAt: at("19:10"),
        expiresAt: new Date(NOW.getTime() + 86_400_000),
        resolvedAt: at("19:30"),
        rescheduledBookingId: replacement.id,
      },
    });
    await openEntitlement(replacement.id, new Date(NOW.getTime() - 1_000));

    await refundExpiredEntitlements(database, NOW);

    expect(
      await database.payment.findUniqueOrThrow({ where: { id: original.paymentId } }),
    ).toMatchObject({ status: "REFUNDED" });
    expect((await database.booking.findUniqueOrThrow({ where: { id: replacement.id } })).status).toBe(
      "REFUNDED",
    );
    expect((await entitlementOf(original.bookingId)).outcome).toBe("RESCHEDULED");
  });
});
