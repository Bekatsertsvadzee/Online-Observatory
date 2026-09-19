import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { zBookingWithPaymentIntent } from "@darkview/contracts/zod";
import { PrismaClient } from "@darkview/db";
import { postCreditEntry, readCreditBalance, releaseSpentMinutes } from "@darkview/db/credits";
import { refundEntitledBooking } from "@darkview/db/refunds";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({ NODE_ENV: process.env.NODE_ENV ?? "test" }),
}));

const { reserveSlot } = await import("@/features/booking/reserve");
const { rescheduleMyBooking } = await import("@/features/booking/entitlement");
const { nightWindow } = await import("@/lib/slots/darkness");
const { generateSlots, SLOT_DURATION_MINUTES } = await import("@/lib/slots/generate");

/**
 * ADR-022 section 7 against a real PostgreSQL instance: minutes are spent in the
 * reservation's transaction and nowhere else, so a lost race spends nothing and one
 * balance cannot pay for two bookings it does not cover.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const SITE = { latitude: 41.7151, longitude: 44.8271, timezone: "Asia/Tbilisi" };
/** A winter afternoon in Tbilisi: every slot that night is still ahead. */
const NOW = new Date("2026-12-15T12:00:00.000Z");
const NIGHT = "2026-12-15";
const PERIOD_START = new Date("2026-12-01T00:00:00.000Z");
const PERIOD_END = new Date("2027-01-01T00:00:00.000Z");

let database: PrismaClient;
let observatoryId: string;
let targetId: string;
let customerId: string;

function slotStartAt(index: number): Date {
  const window = nightWindow(NIGHT, SITE.timezone, {
    latitudeDegrees: SITE.latitude,
    longitudeDegrees: SITE.longitude,
  })!;
  const slots = generateSlots({
    observatoryId,
    window,
    now: NOW,
    observatory: { online: true, weatherHold: false },
    bookedStartAt: new Set(),
  }).filter((slot) => slot.available);
  return new Date(slots[index].startAt);
}

async function createUser(name: string) {
  const user = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name, emailVerifiedAt: NOW },
  });
  return user.id;
}

/** A subscription whose current period is paid, holding `minutes` to spend. */
async function subscribed(
  userId: string,
  minutes: number,
  options: { status?: "ACTIVE" | "PAUSED" | "CANCELLED" | "EXPIRED"; periodEnd?: Date } = {},
) {
  await database.subscription.create({
    data: {
      userId,
      plan: "OBSERVER",
      status: options.status ?? "ACTIVE",
      startsAt: PERIOD_START,
      priceMinor: 5000,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: options.periodEnd ?? PERIOD_END,
    },
  });
  if (minutes > 0) {
    await database.$transaction((tx) =>
      postCreditEntry(tx, {
        userId,
        amount: minutes,
        reason: "SUBSCRIPTION_GRANT",
        idempotencyKey: `renewal:${userId}:${PERIOD_START.toISOString()}`,
      }),
    );
  }
}

function book(
  options: {
    userId?: string;
    slot?: number;
    idempotencyKey?: string | null;
    extra?: { voucherCode?: string; loyaltyPoints?: number };
    now?: Date;
  } = {},
) {
  return reserveSlot({
    userId: options.userId ?? customerId,
    request: {
      observatoryId,
      targetId,
      slotStartAt: slotStartAt(options.slot ?? 0).toISOString(),
      durationMinutes: SLOT_DURATION_MINUTES,
      useSubscriptionMinutes: true,
      ...options.extra,
    },
    idempotencyKey: options.idempotencyKey ?? null,
    now: options.now ?? NOW,
  });
}

function bookForCash(userId: string, slot: number) {
  return reserveSlot({
    userId,
    request: {
      observatoryId,
      targetId,
      slotStartAt: slotStartAt(slot).toISOString(),
      durationMinutes: SLOT_DURATION_MINUTES,
    },
    idempotencyKey: null,
    now: NOW,
  });
}

const balance = (userId = customerId) => readCreditBalance(database, userId);

async function entitle(bookingId: string) {
  await database.bookingEntitlement.create({
    data: {
      bookingId,
      userId: customerId,
      outcome: "OPEN",
      cause: "WEATHER",
      minutesLost: SLOT_DURATION_MINUTES,
      evaluatedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
    },
  });
}

const refund = (bookingId: string) =>
  database.$transaction((tx) =>
    refundEntitledBooking(tx, { bookingId, actorUserId: customerId, automatic: false, now: NOW }),
  );

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING, max: 16 }),
  });
  testDatabase.current = database;
  await database.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  // A credit entry left behind is a foreign key no later suite can delete a user
  // through, and the ledger refuses the DELETE that would clear it.
  await database.$executeRawUnsafe('TRUNCATE "User", "Observatory", "Target" CASCADE');
  await database.$disconnect();
});

beforeEach(async () => {
  // TRUNCATE is the only way past the ledger's append-only trigger, and CASCADE
  // reaches every booking, mission and payment that points at what it clears.
  await database.$executeRawUnsafe('TRUNCATE "User", "Observatory", "Target" CASCADE');
  await database.auditLog.deleteMany();

  const observatory = await database.observatory.create({
    data: {
      slug: `test-${randomUUID()}`,
      nameEn: "Test Observatory",
      nameKa: "Test Observatory",
      city: "Tbilisi",
      countryCode: "GE",
      ...SITE,
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
  const ownerId = await createUser("Owner");
  customerId = await createUser("Subscriber");
  await database.observatoryNetworkNode.create({
    data: {
      ownerId,
      observatoryId,
      primaryTelescopeId: telescope.id,
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

describe("booking with subscription minutes", () => {
  it("confirms the booking at no charge, schedules its mission, and spends the slot's minutes", async () => {
    await subscribed(customerId, 120);

    const result = await book();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(zBookingWithPaymentIntent.parse(result.body)).toEqual(result.body);
    expect(result.body.paymentIntent).toBeNull();
    expect(result.body.booking).toMatchObject({
      status: "CONFIRMED",
      priceMinor: 0,
      paymentId: null,
      subscriptionMinutesSpent: SLOT_DURATION_MINUTES,
      loyaltyPointsRedeemed: 0,
    });
    const mission = await database.mission.findUniqueOrThrow({
      where: { id: result.body.booking.missionId! },
    });
    expect(mission.state).toBe("SCHEDULED");

    expect(await balance()).toBe(120 - SLOT_DURATION_MINUTES);
    const debit = await database.creditLedger.findUniqueOrThrow({
      where: { idempotencyKey: `booking:${result.body.booking.id}` },
    });
    expect(debit).toMatchObject({ amount: -SLOT_DURATION_MINUTES, reason: "MISSION_DEBIT" });

    expect(await database.payment.count()).toBe(0);
    // No money moved, so no points were earned (ADR-022 section 3).
    expect(
      await database.loyaltyLedgerEntry.count({ where: { bookingId: result.body.booking.id } }),
    ).toBe(0);
    expect(
      await database.auditLog.count({
        where: { action: "BOOKING_PAID_WITH_MINUTES", entityId: result.body.booking.id },
      }),
    ).toBe(1);
    expect(await database.auditLog.count({ where: { action: "CREDIT_MISSION_DEBIT" } })).toBe(1);
    expect(
      await database.emailNotification.count({ where: { kind: "BOOKING_CONFIRMED" } }),
    ).toBe(1);
  });

  it("refuses when the balance does not cover the slot, and takes nothing", async () => {
    await subscribed(customerId, SLOT_DURATION_MINUTES - 1);

    await expect(book()).resolves.toMatchObject({
      ok: false,
      status: 422,
      message: `Not enough subscription minutes: this slot needs ${SLOT_DURATION_MINUTES}.`,
    });
    expect(await balance()).toBe(SLOT_DURATION_MINUTES - 1);
    expect(await database.booking.count()).toBe(0);
    expect(await database.mission.count()).toBe(0);
  });

  it("refuses a customer who has never subscribed", async () => {
    await expect(book()).resolves.toMatchObject({ ok: false, status: 422 });
    expect(await database.booking.count()).toBe(0);
  });

  it("refuses minutes from a period that has ended, before its expiry is written", async () => {
    await subscribed(customerId, 120, { periodEnd: NOW });

    await expect(book()).resolves.toMatchObject({
      ok: false,
      status: 422,
      message: "There is no current subscription period to spend minutes from.",
    });
    expect(await balance()).toBe(120);
  });

  it.each(["CANCELLED", "EXPIRED"] as const)("refuses a %s subscription", async (status) => {
    await subscribed(customerId, 120, { status });

    await expect(book()).resolves.toMatchObject({ ok: false, status: 422 });
    expect(await balance()).toBe(120);
  });

  it("lets a paused subscription spend what its current period already granted", async () => {
    await subscribed(customerId, 120, { status: "PAUSED" });

    await expect(book()).resolves.toMatchObject({ ok: true });
    expect(await balance()).toBe(120 - SLOT_DURATION_MINUTES);
  });

  it.each([
    ["a voucher", { voucherCode: "ABCD-EFGH-JKMN-PQRS" }],
    ["loyalty points", { loyaltyPoints: 100 }],
  ])("refuses minutes together with %s", async (_, extra) => {
    await subscribed(customerId, 120);

    await expect(book({ extra })).resolves.toMatchObject({
      ok: false,
      status: 422,
      message: "A booking uses one of a voucher, loyalty points or subscription minutes.",
    });
    expect(await balance()).toBe(120);
  });

  it("returns the first booking on a retried key, and spends once", async () => {
    await subscribed(customerId, 120);
    const key = randomUUID();

    const first = await book({ idempotencyKey: key });
    const again = await book({ idempotencyKey: key });

    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.replayed).toBe(true);
    expect(again.body.booking.id).toBe(first.body.booking.id);
    expect(again.body.paymentIntent).toBeNull();
    expect(await balance()).toBe(120 - SLOT_DURATION_MINUTES);
  });

  it("pays for exactly as many simultaneous bookings as the balance covers", async () => {
    await subscribed(customerId, SLOT_DURATION_MINUTES * 2);

    const results = await Promise.all(Array.from({ length: 6 }, (_, slot) => book({ slot })));

    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(
      results.filter((result) => !result.ok).every((result) => !result.ok && result.status === 422),
    ).toBe(true);
    expect(await balance()).toBe(0);
    expect(await database.booking.count()).toBe(2);
    expect(await database.creditLedger.count({ where: { reason: "MISSION_DEBIT" } })).toBe(2);
  });

  it("spends nothing when the reservation fails because the slot was taken", async () => {
    await subscribed(customerId, 120);
    expect((await bookForCash(await createUser("Taker"), 0)).ok).toBe(true);

    await expect(book({ slot: 0 })).resolves.toMatchObject({
      ok: false,
      status: 409,
      code: "SLOT_UNAVAILABLE",
    });
    expect(await balance()).toBe(120);
    expect(await database.creditLedger.count({ where: { reason: "MISSION_DEBIT" } })).toBe(0);
  });

  it("spends only if it wins when it races a cash booking for the same slot", async () => {
    await subscribed(customerId, 120);
    const payer = await createUser("Payer");

    const [cash, minutes] = await Promise.all([bookForCash(payer, 0), book({ slot: 0 })]);

    expect([cash.ok, minutes.ok].filter(Boolean)).toHaveLength(1);
    expect(await balance()).toBe(minutes.ok ? 120 - SLOT_DURATION_MINUTES : 120);
    expect(
      await database.booking.count({
        where: { status: { in: ["PENDING_PAYMENT", "CONFIRMED"] } },
      }),
    ).toBe(1);
  });
});

describe("a refunded booking subscription minutes paid for (DV-111)", () => {
  async function entitledMinutesBooking() {
    await subscribed(customerId, 120);
    const result = await book();
    if (!result.ok) throw new Error(result.message);
    await entitle(result.body.booking.id);
    return result.body.booking.id;
  }

  it("returns the minutes instead of paying out, once", async () => {
    const bookingId = await entitledMinutesBooking();

    const refunded = await refund(bookingId);

    expect(refunded).toEqual({
      ok: true,
      paymentId: null,
      voucherId: null,
      minutesReturned: SLOT_DURATION_MINUTES,
    });
    expect(await balance()).toBe(120);
    expect(
      await database.creditLedger.findUniqueOrThrow({
        where: { idempotencyKey: `booking:${bookingId}:release` },
      }),
    ).toMatchObject({ amount: SLOT_DURATION_MINUTES, reason: "REFUND" });
    expect(
      (await database.booking.findUniqueOrThrow({ where: { id: bookingId } })).status,
    ).toBe("REFUNDED");
    expect(
      await database.auditLog.count({
        where: { action: "BOOKING_MINUTES_RETURNED", entityId: bookingId },
      }),
    ).toBe(1);
    // The refund email states an amount of money; none moved, so it has its own (#123).
    expect(await database.emailNotification.count({ where: { kind: "BOOKING_REFUNDED" } })).toBe(
      0,
    );
    expect(
      await database.emailNotification.findMany({
        where: { kind: "SUBSCRIPTION_MINUTES_RETURNED" },
      }),
    ).toMatchObject([
      { userId: customerId, payload: { bookingId, paidBookingId: bookingId } },
    ]);

    await expect(refund(bookingId)).resolves.toEqual({
      ok: false,
      reason: "NO_OPEN_ENTITLEMENT",
    });
    expect(await balance()).toBe(120);
    expect(
      await database.emailNotification.count({ where: { kind: "SUBSCRIPTION_MINUTES_RETURNED" } }),
    ).toBe(1);
  });

  it("returns the minutes the original booking spent when a free reschedule is refunded", async () => {
    const original = await entitledMinutesBooking();
    const rescheduled = await rescheduleMyBooking({
      userId: customerId,
      bookingId: original,
      request: { slotStartAt: slotStartAt(3).toISOString() },
      now: NOW,
    });
    if (!rescheduled.ok) throw new Error(rescheduled.message);
    expect(rescheduled.booking.subscriptionMinutesSpent).toBe(0);
    await entitle(rescheduled.booking.id);

    await expect(refund(rescheduled.booking.id)).resolves.toMatchObject({
      ok: true,
      minutesReturned: SLOT_DURATION_MINUTES,
    });
    expect(await balance()).toBe(120);
    expect(
      await database.creditLedger.count({
        where: { idempotencyKey: `booking:${original}:release` },
      }),
    ).toBe(1);
    expect(
      await database.emailNotification.findMany({
        where: { kind: "SUBSCRIPTION_MINUTES_RETURNED" },
      }),
    ).toMatchObject([
      { payload: { bookingId: rescheduled.booking.id, paidBookingId: original } },
    ]);
  });

  it("releases a booking's minutes once however many paths reach it", async () => {
    await subscribed(customerId, 120);
    const result = await book();
    if (!result.ok) throw new Error(result.message);
    const booking = {
      id: result.body.booking.id,
      userId: customerId,
      subscriptionMinutesSpent: SLOT_DURATION_MINUTES,
    };

    await database.$transaction((tx) => releaseSpentMinutes(tx, booking));
    await database.$transaction((tx) => releaseSpentMinutes(tx, booking));

    expect(await balance()).toBe(120);
    expect(await database.creditLedger.count({ where: { reason: "REFUND" } })).toBe(1);
  });
});
