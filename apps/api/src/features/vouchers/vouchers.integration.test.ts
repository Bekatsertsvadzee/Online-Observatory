import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  zBookingWithPaymentIntent,
  zGiftVoucherList,
  zGiftVoucherWithPaymentIntent,
} from "@darkview/contracts/zod";
import { PrismaClient } from "@darkview/db";
import { refundEntitledBooking } from "@darkview/db/refunds";
import { deriveVoucherCode, hashVoucherCode } from "@darkview/db/vouchers";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

const SECRET = "v".repeat(32);

vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({
    NODE_ENV: process.env.NODE_ENV ?? "test",
    VOUCHER_CODE_SECRET: process.env.TEST_NO_VOUCHER_SECRET ? undefined : "v".repeat(32),
  }),
}));

const { reserveSlot } = await import("@/features/booking/reserve");
const { settlePayment } = await import("@/features/payments/settle");
const { listMyGiftVouchers, purchaseGiftVoucher } =
  await import("@/features/vouchers/vouchers");
const { nightWindow } = await import("@/lib/slots/darkness");
const { generateSlots, PROVISIONAL_SLOT_PRICE_MINOR, SLOT_DURATION_MINUTES } =
  await import("@/lib/slots/generate");

/**
 * DV-112 against a real PostgreSQL instance. What only a database can show: that a
 * voucher is spent in the reservation's transaction and nowhere else, so a race or
 * a failed reservation can neither spend it twice nor spend it for nothing.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const SITE = { latitude: 41.7151, longitude: 44.8271, timezone: "Asia/Tbilisi" };
/** A winter afternoon in Tbilisi: every slot that night is still ahead. */
const NOW = new Date("2026-12-15T12:00:00.000Z");
const NIGHT = "2026-12-15";

let database: PrismaClient;
let observatoryId: string;
let targetId: string;
let buyerId: string;
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

/** A voucher bought and paid for, and its code as the email would carry it. */
async function paidVoucher(options: { recipientEmail?: string; paidAt?: Date } = {}) {
  const ordered = await purchaseGiftVoucher({
    userId: buyerId,
    request: {
      durationMinutes: SLOT_DURATION_MINUTES,
      ...(options.recipientEmail ? { recipientEmail: options.recipientEmail } : {}),
    },
    now: NOW,
  });
  if (!ordered.ok) throw new Error(ordered.message);
  const paymentId = ordered.body.paymentIntent.paymentId;
  const settled = await settlePayment({
    provider: "SANDBOX",
    outcome: {
      paymentId,
      providerRef: `sbx_${paymentId.slice(0, 8)}`,
      result: "CAPTURED",
      amountMinor: PROVISIONAL_SLOT_PRICE_MINOR,
      currency: "GEL",
      failureReason: null,
    },
    now: options.paidAt ?? NOW,
  });
  if (!settled.ok) throw new Error(settled.message);
  return {
    voucherId: ordered.body.voucher.id,
    code: deriveVoucherCode(SECRET, ordered.body.voucher.id),
    paymentId,
  };
}

function redeem(
  code: string,
  options: { userId?: string; slot?: number; now?: Date } = {},
) {
  return reserveSlot({
    userId: options.userId ?? customerId,
    request: {
      observatoryId,
      targetId,
      slotStartAt: slotStartAt(options.slot ?? 0).toISOString(),
      durationMinutes: SLOT_DURATION_MINUTES,
      voucherCode: code,
    },
    idempotencyKey: null,
    now: options.now ?? NOW,
  });
}

const voucherRow = (id: string) =>
  database.giftVoucher.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING, max: 16 }),
  });
  testDatabase.current = database;
  await database.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(async () => {
  await database.bookingEntitlement.deleteMany();
  await database.emailNotification.deleteMany();
  await database.auditLog.deleteMany();
  await database.networkAvailabilityWindow.deleteMany();
  await database.observatoryNetworkNode.deleteMany();
  await database.capture.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  await database.missionEvent.deleteMany();
  await database.observerPack.deleteMany();
  await database.booking.deleteMany();
  await database.mission.deleteMany();
  await database.giftVoucher.deleteMany();
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
  buyerId = await createUser("Buyer");
  customerId = await createUser("Recipient");
  await database.observatoryNetworkNode.create({
    data: {
      ownerId: buyerId,
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

describe("buying a gift voucher", () => {
  it("opens a payment and stores only the code's hash, in a body the contract accepts", async () => {
    const ordered = await purchaseGiftVoucher({
      userId: buyerId,
      request: {
        durationMinutes: SLOT_DURATION_MINUTES,
        recipientEmail: "friend@example.test",
        recipientName: "Friend",
      },
      now: NOW,
    });

    expect(ordered.ok).toBe(true);
    if (!ordered.ok) return;
    expect(zGiftVoucherWithPaymentIntent.parse(ordered.body)).toEqual(ordered.body);
    expect(ordered.body.voucher).toMatchObject({
      status: "PENDING_PAYMENT",
      priceMinor: PROVISIONAL_SLOT_PRICE_MINOR,
      codeLast4: null,
      expiresAt: null,
    });

    const row = await voucherRow(ordered.body.voucher.id);
    const code = deriveVoucherCode(SECRET, row.id);
    expect(row.codeHash).toBe(hashVoucherCode(code));
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(code.replace(/-/g, ""));
    expect(
      await database.payment.findUniqueOrThrow({ where: { id: row.paymentId } }),
    ).toMatchObject({
      purpose: "GIFT_VOUCHER",
      status: "PENDING",
      amountMinor: PROVISIONAL_SLOT_PRICE_MINOR,
    });
    expect(
      await database.auditLog.count({
        where: { action: "GIFT_VOUCHER_ORDERED", entityId: row.id },
      }),
    ).toBe(1);
  });

  it("refuses a length no slot is sold at", async () => {
    await expect(
      purchaseGiftVoucher({
        userId: buyerId,
        request: { durationMinutes: SLOT_DURATION_MINUTES + 30 },
        now: NOW,
      }),
    ).resolves.toMatchObject({ ok: false, status: 422 });
    expect(await database.giftVoucher.count()).toBe(0);
  });

  it("refuses to sell on a deployment with no code secret", async () => {
    vi.stubEnv("TEST_NO_VOUCHER_SECRET", "1");
    try {
      await expect(
        purchaseGiftVoucher({
          userId: buyerId,
          request: { durationMinutes: SLOT_DURATION_MINUTES },
          now: NOW,
        }),
      ).resolves.toMatchObject({ ok: false, status: 503 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("becomes active for twelve months when paid, and queues the code's email once", async () => {
    const { voucherId, paymentId } = await paidVoucher({
      recipientEmail: "friend@example.test",
    });

    expect(await voucherRow(voucherId)).toMatchObject({
      status: "ACTIVE",
      expiresAt: new Date("2027-12-15T12:00:00.000Z"),
    });
    const list = await listMyGiftVouchers(buyerId, NOW);
    expect(zGiftVoucherList.parse(list)).toEqual(list);
    expect(list.items[0]).toMatchObject({
      status: "ACTIVE",
      codeLast4: expect.stringMatching(/^[0-9A-Z]{4}$/),
    });

    // The callback again: answered by settlement's own idempotency, nothing new.
    await settlePayment({
      provider: "SANDBOX",
      outcome: {
        paymentId,
        providerRef: `sbx_${paymentId.slice(0, 8)}`,
        result: "CAPTURED",
        amountMinor: PROVISIONAL_SLOT_PRICE_MINOR,
        currency: "GEL",
        failureReason: null,
      },
      now: NOW,
    });
    expect(
      await database.emailNotification.count({ where: { kind: "GIFT_VOUCHER_ISSUED" } }),
    ).toBe(1);
    expect(
      await database.auditLog.count({
        where: { action: "GIFT_VOUCHER_ISSUED", entityId: voucherId },
      }),
    ).toBe(1);
  });

  it("is cancelled when the payment fails, and its code redeems nothing", async () => {
    const ordered = await purchaseGiftVoucher({
      userId: buyerId,
      request: { durationMinutes: SLOT_DURATION_MINUTES },
      now: NOW,
    });
    if (!ordered.ok) throw new Error(ordered.message);
    const paymentId = ordered.body.paymentIntent.paymentId;
    await settlePayment({
      provider: "SANDBOX",
      outcome: {
        paymentId,
        providerRef: `sbx_${paymentId.slice(0, 8)}`,
        result: "FAILED",
        amountMinor: PROVISIONAL_SLOT_PRICE_MINOR,
        currency: "GEL",
        failureReason: "DECLINED",
      },
      now: NOW,
    });

    expect((await voucherRow(ordered.body.voucher.id)).status).toBe("CANCELLED");
    await expect(
      redeem(deriveVoucherCode(SECRET, ordered.body.voucher.id)),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
    });
    expect(await database.emailNotification.count()).toBe(0);
  });
});

describe("booking with a gift voucher", () => {
  it("confirms the booking at no charge, schedules its mission, and spends the voucher", async () => {
    const { voucherId, code } = await paidVoucher();

    const result = await redeem(code.toLowerCase());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(zBookingWithPaymentIntent.parse(result.body)).toEqual(result.body);
    expect(result.body.paymentIntent).toBeNull();
    expect(result.body.booking).toMatchObject({
      status: "CONFIRMED",
      priceMinor: 0,
      paymentId: null,
    });
    const mission = await database.mission.findUniqueOrThrow({
      where: { id: result.body.booking.missionId! },
    });
    expect(mission.state).toBe("SCHEDULED");
    expect(await voucherRow(voucherId)).toMatchObject({
      status: "REDEEMED",
      redeemedByUserId: customerId,
      redeemedBookingId: result.body.booking.id,
    });
    expect(await database.payment.count({ where: { purpose: "BOOKING" } })).toBe(0);
    expect(
      await database.auditLog.count({
        where: { action: "GIFT_VOUCHER_REDEEMED", entityId: voucherId },
      }),
    ).toBe(1);
  });

  it("cannot be spent twice", async () => {
    const { code } = await paidVoucher();
    expect((await redeem(code, { slot: 0 })).ok).toBe(true);

    await expect(redeem(code, { slot: 2 })).resolves.toMatchObject({
      ok: false,
      status: 422,
    });
    expect(await database.booking.count()).toBe(1);
  });

  it("is spent by exactly one of many simultaneous redemptions", async () => {
    const { voucherId, code } = await paidVoucher();
    const others = await Promise.all(
      Array.from({ length: 8 }, (_, index) => createUser(`Racer ${index}`)),
    );

    const results = await Promise.all(
      others.map((userId, index) => redeem(code, { userId, slot: index })),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results
        .filter((result) => !result.ok)
        .every((result) => !result.ok && result.status === 422),
    ).toBe(true);
    expect(await database.booking.count()).toBe(1);
    expect((await voucherRow(voucherId)).status).toBe("REDEEMED");
  });

  it("spends nothing when the reservation fails because the slot was taken", async () => {
    const { voucherId, code } = await paidVoucher();
    const taker = await createUser("Taker");
    const taken = await reserveSlot({
      userId: taker,
      request: {
        observatoryId,
        targetId,
        slotStartAt: slotStartAt(0).toISOString(),
        durationMinutes: SLOT_DURATION_MINUTES,
      },
      idempotencyKey: null,
      now: NOW,
    });
    expect(taken.ok).toBe(true);

    await expect(redeem(code, { slot: 0 })).resolves.toMatchObject({
      ok: false,
      status: 409,
      code: "SLOT_UNAVAILABLE",
    });
    expect(await voucherRow(voucherId)).toMatchObject({
      status: "ACTIVE",
      redeemedBookingId: null,
    });
  });

  it("spends nothing when a redemption races a cash booking for the same slot", async () => {
    const { voucherId, code } = await paidVoucher();
    const payer = await createUser("Payer");

    const [cash, voucher] = await Promise.all([
      reserveSlot({
        userId: payer,
        request: {
          observatoryId,
          targetId,
          slotStartAt: slotStartAt(0).toISOString(),
          durationMinutes: SLOT_DURATION_MINUTES,
        },
        idempotencyKey: null,
        now: NOW,
      }),
      redeem(code, { slot: 0 }),
    ]);

    expect([cash.ok, voucher.ok].filter(Boolean)).toHaveLength(1);
    expect((await voucherRow(voucherId)).status).toBe(voucher.ok ? "REDEEMED" : "ACTIVE");
    expect(
      await database.booking.count({
        where: { status: { in: ["PENDING_PAYMENT", "CONFIRMED"] } },
      }),
    ).toBe(1);
  });

  it("is refused once expired, and stays unspent", async () => {
    const { voucherId, code } = await paidVoucher();
    await database.giftVoucher.update({
      where: { id: voucherId },
      data: { expiresAt: new Date(NOW.getTime() - 1) },
    });

    await expect(redeem(code)).resolves.toMatchObject({ ok: false, status: 422 });
    expect(await voucherRow(voucherId)).toMatchObject({
      status: "ACTIVE",
      redeemedBookingId: null,
    });
    expect((await listMyGiftVouchers(buyerId, NOW)).items[0].status).toBe("EXPIRED");
  });

  it("refuses a code nobody was sold, with the same answer as a spent one", async () => {
    await expect(redeem("ABCD-EFGH-JKMN-PQRS")).resolves.toMatchObject({
      ok: false,
      status: 422,
      message: "That voucher code cannot be used.",
    });
  });

  it("refuses a voucher for another length and says which length", async () => {
    const { voucherId, code } = await paidVoucher();
    await database.giftVoucher.update({
      where: { id: voucherId },
      data: { durationMinutes: 60 },
    });

    await expect(redeem(code)).resolves.toMatchObject({
      ok: false,
      status: 422,
      message: "This voucher is for a 60-minute observation.",
    });
  });
});

describe("a refunded booking a voucher paid for (DV-111)", () => {
  async function entitledVoucherBooking() {
    const voucher = await paidVoucher();
    const result = await redeem(voucher.code);
    if (!result.ok) throw new Error(result.message);
    await database.booking.update({
      where: { id: result.body.booking.id },
      data: { status: "CONFIRMED" },
    });
    await database.bookingEntitlement.create({
      data: {
        bookingId: result.body.booking.id,
        userId: customerId,
        outcome: "OPEN",
        cause: "WEATHER",
        minutesLost: 30,
        evaluatedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
      },
    });
    return { ...voucher, bookingId: result.body.booking.id };
  }

  it("restores the voucher instead of paying out, and it can be spent again", async () => {
    const { voucherId, code, bookingId, paymentId } = await entitledVoucherBooking();

    const refunded = await database.$transaction((tx) =>
      refundEntitledBooking(tx, {
        bookingId,
        actorUserId: customerId,
        automatic: false,
        now: NOW,
      }),
    );

    expect(refunded).toEqual({ ok: true, paymentId: null, voucherId, minutesReturned: 0 });
    expect(await voucherRow(voucherId)).toMatchObject({
      status: "ACTIVE",
      redeemedBookingId: null,
      redeemedByUserId: null,
    });
    // The voucher's own purchase is untouched: no cash left the business.
    expect(
      (await database.payment.findUniqueOrThrow({ where: { id: paymentId } })).status,
    ).toBe("CAPTURED");
    expect(
      (await database.booking.findUniqueOrThrow({ where: { id: bookingId } })).status,
    ).toBe("REFUNDED");
    expect(
      await database.emailNotification.count({
        where: { kind: "GIFT_VOUCHER_RESTORED" },
      }),
    ).toBe(1);
    expect(
      await database.auditLog.count({
        where: { action: "GIFT_VOUCHER_RESTORED", entityId: voucherId },
      }),
    ).toBe(1);

    expect((await redeem(code, { slot: 3 })).ok).toBe(true);
  });

  it("keeps at least thirty days of life on a voucher restored near its expiry", async () => {
    const { voucherId, bookingId } = await entitledVoucherBooking();
    await database.giftVoucher.update({
      where: { id: voucherId },
      data: { expiresAt: new Date(NOW.getTime() + 86_400_000) },
    });

    await database.$transaction((tx) =>
      refundEntitledBooking(tx, {
        bookingId,
        actorUserId: null,
        automatic: true,
        now: NOW,
      }),
    );

    expect((await voucherRow(voucherId)).expiresAt).toEqual(
      new Date(NOW.getTime() + 30 * 86_400_000),
    );
  });
});
