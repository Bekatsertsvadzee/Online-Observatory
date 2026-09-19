import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { zLoyaltyAccount, zLoyaltyScheme } from "@darkview/contracts/zod";
import { PrismaClient } from "@darkview/db";
import { postLoyaltyEntry } from "@darkview/db/loyalty";
import { refundEntitledBooking } from "@darkview/db/refunds";

vi.mock("server-only", () => ({}));

const { testDatabase, sentLinks } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
  sentLinks: [] as string[],
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({
    NODE_ENV: "test",
    APP_URL: "https://darkview.test",
    AUTH_SECRET: "integration-test-secret-integration-test-secret",
    EMAIL_VERIFICATION_WEBHOOK_URL: "https://mail.darkview.test/hook",
    EMAIL_VERIFICATION_WEBHOOK_SECRET: "integration-test-webhook-secret-0000",
    TRUSTED_PROXY_HOPS: 0,
    VOUCHER_CODE_SECRET: "v".repeat(32),
  }),
}));
vi.mock("@/lib/auth/email-verification", () => ({
  sendEmailVerification: async (message: { verificationUrl: string }) => {
    sentLinks.push(message.verificationUrl);
  },
}));

const { register, verifyEmail } = await import("@/features/auth/authenticate");
const { reserveSlot } = await import("@/features/booking/reserve");
const { settlePayment } = await import("@/features/payments/settle");
const { adjustLoyaltyPoints, readLoyaltyAccount, readPublicLoyaltyScheme } =
  await import("@/features/loyalty/account");
const { nightWindow } = await import("@/lib/slots/darkness");
const { generateSlots, PROVISIONAL_SLOT_PRICE_MINOR, SLOT_DURATION_MINUTES } =
  await import("@/lib/slots/generate");

/**
 * DV-090 to DV-096 against a real PostgreSQL instance: points move only in the
 * transaction of what caused them, once per source, and a tier follows purchases
 * and nothing else.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const SITE = { latitude: 41.7151, longitude: 44.8271, timezone: "Asia/Tbilisi" };
const NOW = new Date("2026-12-15T12:00:00.000Z");
const NIGHT = "2026-12-15";
/** 45.00 GEL less Member's 10%. */
const MEMBER_PRICE =
  PROVISIONAL_SLOT_PRICE_MINOR - Math.floor(PROVISIONAL_SLOT_PRICE_MINOR / 10);

let database: PrismaClient;
let observatoryId: string;
let targetId: string;
let userId: string;

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

async function createUser(name = "Customer") {
  const user = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name, emailVerifiedAt: NOW },
  });
  return user.id;
}

function book(
  options: { userId?: string; slot?: number; points?: number; now?: Date } = {},
) {
  return reserveSlot({
    userId: options.userId ?? userId,
    request: {
      observatoryId,
      targetId,
      slotStartAt: slotStartAt(options.slot ?? 0).toISOString(),
      durationMinutes: SLOT_DURATION_MINUTES,
      ...(options.points ? { loyaltyPoints: options.points } : {}),
    },
    idempotencyKey: null,
    now: options.now ?? NOW,
  });
}

async function settle(
  paymentId: string,
  amountMinor: number,
  result: "CAPTURED" | "FAILED" = "CAPTURED",
) {
  const settled = await settlePayment({
    provider: "SANDBOX",
    outcome: {
      paymentId,
      providerRef: `sbx_${paymentId.slice(0, 8)}`,
      result,
      amountMinor,
      currency: "GEL",
      failureReason: result === "FAILED" ? "DECLINED" : null,
    },
    now: NOW,
  });
  if (!settled.ok) throw new Error(settled.message);
}

/** A cash booking, paid. */
async function paidBooking(
  options: { userId?: string; slot?: number; points?: number } = {},
) {
  const reserved = await book(options);
  if (!reserved.ok) throw new Error(reserved.message);
  const intent = reserved.body.paymentIntent!;
  await settle(intent.paymentId, reserved.body.booking.priceMinor);
  return {
    bookingId: reserved.body.booking.id,
    paymentId: intent.paymentId,
    priceMinor: reserved.body.booking.priceMinor,
  };
}

const account = (id = userId) =>
  database.loyaltyAccount.findUniqueOrThrow({ where: { userId: id } });

async function grant(points: number, id = userId) {
  await database.$transaction((tx) =>
    postLoyaltyEntry(tx, {
      userId: id,
      kind: "ADMIN_ADJUSTMENT",
      points,
      sourceRef: `test:${randomUUID()}`,
    }),
  );
}

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
  await database.rateLimitBucket.deleteMany();

  const observatory = await database.observatory.create({
    data: {
      slug: `test-${randomUUID()}`,
      nameEn: "Test",
      nameKa: "Test",
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
  userId = await createUser();
  await database.observatoryNetworkNode.create({
    data: {
      ownerId: userId,
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

describe("the scheme (DV-090)", () => {
  it("is the Astroman club's published terms, as data the contract accepts", async () => {
    const scheme = await readPublicLoyaltyScheme();
    expect(zLoyaltyScheme.parse(scheme)).toEqual(scheme);
    expect(scheme).toMatchObject({
      pointsPerGel: 5,
      pointsPerGelRedeemed: 100,
      welcomeBonusPoints: 100,
      referralBonusPoints: 200,
      progressMarkers: [5000],
      tiers: [
        { code: "MEMBER", thresholdPoints: 0, discountPercent: 10 },
        { code: "VIP", thresholdPoints: 20000, discountPercent: 20 },
      ],
    });
  });

  it("is changed by updating a row, not by a deploy", async () => {
    await database.loyaltyTier.update({
      where: { code: "MEMBER" },
      data: { discountPercent: 15 },
    });
    try {
      const reserved = await book();
      expect(reserved.ok && reserved.body.booking.tierDiscountMinor).toBe(
        Math.floor(PROVISIONAL_SLOT_PRICE_MINOR * 0.15),
      );
    } finally {
      await database.loyaltyTier.update({
        where: { code: "MEMBER" },
        data: { discountPercent: 10 },
      });
    }
  });
});

describe("earning (DV-093)", () => {
  it("earns five points per GEL actually paid, once, when the payment settles", async () => {
    const { paymentId, priceMinor } = await paidBooking();

    const earned = Math.floor((MEMBER_PRICE * 5) / 100);
    expect(await account()).toMatchObject({ balance: earned, tierPoints: earned });
    await settle(paymentId, priceMinor);
    expect((await account()).balance).toBe(earned);
    expect(
      await database.loyaltyLedgerEntry.count({
        where: { userId, kind: "PURCHASE_EARNED" },
      }),
    ).toBe(1);
    expect(
      await database.auditLog.count({ where: { action: "LOYALTY_PURCHASE_EARNED" } }),
    ).toBe(1);
  });

  it("earns nothing on a payment that failed", async () => {
    const reserved = await book();
    if (!reserved.ok) throw new Error(reserved.message);
    await settle(
      reserved.body.paymentIntent!.paymentId,
      reserved.body.booking.priceMinor,
      "FAILED",
    );

    expect((await account()).balance).toBe(0);
    expect(
      await database.loyaltyLedgerEntry.count({ where: { kind: "PURCHASE_EARNED" } }),
    ).toBe(0);
  });

  it("takes back what a refunded payment earned and gives back what its booking spent (DV-111)", async () => {
    await grant(1000);
    const { bookingId } = await paidBooking({ points: 1000 });
    const afterPurchase = await account();
    expect(afterPurchase.balance).toBeGreaterThan(0);
    await database.bookingEntitlement.create({
      data: {
        bookingId,
        userId,
        outcome: "OPEN",
        cause: "WEATHER",
        minutesLost: 30,
        evaluatedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 86_400_000),
      },
    });

    const refunded = await database.$transaction((tx) =>
      refundEntitledBooking(tx, {
        bookingId,
        actorUserId: userId,
        automatic: false,
        now: NOW,
      }),
    );

    expect(refunded.ok).toBe(true);
    expect(await account()).toMatchObject({ balance: 1000, tierPoints: 0 });
    expect(
      await database.loyaltyLedgerEntry.count({
        where: { kind: { in: ["PURCHASE_REVERSED", "REDEMPTION_RELEASED"] } },
      }),
    ).toBe(2);
  });
});

describe("tiers (DV-094)", () => {
  it("moves to VIP on purchase points and says so in the audit log", async () => {
    await database.loyaltyAccount.create({
      data: { userId, tierCode: "MEMBER", referralCode: "TESTCODE", tierPoints: 19_900 },
    });

    await paidBooking();

    expect(await account()).toMatchObject({ tierCode: "VIP" });
    expect(
      await database.auditLog.count({
        where: { action: "LOYALTY_TIER_CHANGED", entityId: userId },
      }),
    ).toBe(1);
    const view = await readLoyaltyAccount(userId);
    expect(zLoyaltyAccount.parse(view)).toEqual(view);
    expect(view).toMatchObject({ tier: { code: "VIP" }, nextTier: null });
  });

  it("is never raised by a bonus or an operator adjustment", async () => {
    await grant(50_000);

    expect(await account()).toMatchObject({
      balance: 50_000,
      tierPoints: 0,
      tierCode: "MEMBER",
    });
  });

  it("gives VIP's discount on the next booking", async () => {
    await database.loyaltyAccount.create({
      data: { userId, tierCode: "VIP", referralCode: "TESTCODE", tierPoints: 20_000 },
    });

    const reserved = await book();

    expect(reserved.ok && reserved.body.booking.tierDiscountMinor).toBe(
      Math.floor(PROVISIONAL_SLOT_PRICE_MINOR / 5),
    );
  });
});

describe("spending points on a booking (DV-095)", () => {
  it("takes the points when the slot is held and lowers the payment by their value", async () => {
    await grant(2000);

    const reserved = await book({ points: 2000 });

    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(reserved.body.booking).toMatchObject({
      loyaltyPointsRedeemed: 2000,
      priceMinor: MEMBER_PRICE - 2000,
    });
    expect(reserved.body.paymentIntent).toBeTruthy();
    expect(
      (
        await database.payment.findUniqueOrThrow({
          where: { id: reserved.body.paymentIntent!.paymentId },
        })
      ).amountMinor,
    ).toBe(MEMBER_PRICE - 2000);
    expect((await account()).balance).toBe(0);
  });

  it("refuses more points than the customer has, and holds nothing", async () => {
    await grant(100);

    await expect(book({ points: 200 })).resolves.toMatchObject({
      ok: false,
      status: 422,
    });
    expect(await database.booking.count()).toBe(0);
    expect((await account()).balance).toBe(100);
  });

  it("leaves at least the scheme's minimum to pay", async () => {
    await grant(10_000);

    await expect(book({ points: MEMBER_PRICE })).resolves.toMatchObject({
      ok: false,
      status: 422,
    });
    expect(
      (await book({ points: Math.floor((MEMBER_PRICE - 100) / 100) * 100 })).ok,
    ).toBe(true);
  });

  it("refuses points together with a voucher: one reduction per booking", async () => {
    await grant(1000);

    await expect(
      reserveSlot({
        userId,
        request: {
          observatoryId,
          targetId,
          slotStartAt: slotStartAt(0).toISOString(),
          durationMinutes: SLOT_DURATION_MINUTES,
          loyaltyPoints: 100,
          voucherCode: "ABCD-EFGH-JKMN-PQRS",
        },
        idempotencyKey: null,
        now: NOW,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      message: "A booking uses one of a voucher, loyalty points or subscription minutes.",
    });
    expect((await account()).balance).toBe(1000);
  });

  it("lets only one of two simultaneous bookings spend the same points", async () => {
    await grant(1000);

    const results = await Promise.all([
      book({ slot: 0, points: 1000 }),
      book({ slot: 2, points: 1000 }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect((await account()).balance).toBe(0);
    expect(await database.booking.count()).toBe(1);
  });

  it("gives the points back when the payment fails", async () => {
    await grant(1000);
    const reserved = await book({ points: 1000 });
    if (!reserved.ok) throw new Error(reserved.message);

    await settle(
      reserved.body.paymentIntent!.paymentId,
      reserved.body.booking.priceMinor,
      "FAILED",
    );

    expect((await account()).balance).toBe(1000);
  });

  it("gives the points back, once, when the hold lapses", async () => {
    await grant(1000);
    const reserved = await book({ points: 1000 });
    if (!reserved.ok) throw new Error(reserved.message);

    const later = new Date(NOW.getTime() + 60 * 60_000);
    const other = await createUser("Later");
    await book({ userId: other, slot: 3, now: later });
    await book({ userId: other, slot: 4, now: later });

    expect(
      (
        await database.booking.findUniqueOrThrow({
          where: { id: reserved.body.booking.id },
        })
      ).status,
    ).toBe("EXPIRED");
    expect((await account()).balance).toBe(1000);
    expect(
      await database.loyaltyLedgerEntry.count({
        where: { userId, kind: "REDEMPTION_RELEASED" },
      }),
    ).toBe(1);
  });
});

describe("referrals (DV-096)", () => {
  async function registerWith(referralCode?: string) {
    const email = `${randomUUID()}@example.test`;
    await register({
      displayName: "New Observer",
      email,
      password: "a correct horse battery",
      locale: "en",
      ...(referralCode ? { referralCode } : {}),
    });
    const created = await database.user.findUniqueOrThrow({ where: { email } });
    const token = sentLinks[sentLinks.length - 1].split("/").at(-1)!;
    return { id: created.id, token };
  }

  it("grants the welcome bonus once the address is verified, not at sign-up", async () => {
    const { id, token } = await registerWith();
    expect((await account(id)).balance).toBe(0);

    await verifyEmail({ token });

    expect(await account(id)).toMatchObject({ balance: 100, tierPoints: 0 });
  });

  it("rewards both sides on the new customer's first paid booking, and only the first", async () => {
    const referrer = await readLoyaltyAccount(userId);
    const { id: referee, token } = await registerWith(
      referrer.referralCode.toLowerCase(),
    );
    await verifyEmail({ token });
    expect((await account(referee)).referredByUserId).toBe(userId);
    expect((await account()).balance).toBe(0);

    await paidBooking({ userId: referee, slot: 0 });
    await paidBooking({ userId: referee, slot: 2 });

    expect((await account()).balance).toBe(200);
    expect((await account()).tierPoints).toBe(0);
    const earned = Math.floor((MEMBER_PRICE * 5) / 100);
    expect((await account(referee)).balance).toBe(100 + 200 + 2 * earned);
    expect(
      await database.loyaltyLedgerEntry.count({ where: { kind: "REFERRAL_BONUS" } }),
    ).toBe(2);
  });

  it("ignores an unknown code, and the database refuses a self-referral", async () => {
    const { id } = await registerWith("NOSUCHCODE");
    expect((await account(id)).referredByUserId).toBeNull();

    await expect(
      database.loyaltyAccount.update({
        where: { userId: id },
        data: { referredByUserId: id },
      }),
    ).rejects.toThrow();
  });
});

describe("operator adjustments and the ledger (DV-092)", () => {
  const operator = () => createUser("Operator");

  it("adds points once per adjustment id, audited with the reason", async () => {
    const operatorId = await operator();
    const request = {
      adjustmentId: randomUUID(),
      userId,
      points: 500,
      reason: "Apology for a cloudy night",
    };

    await adjustLoyaltyPoints({ request, operatorId });
    const again = await adjustLoyaltyPoints({ request, operatorId });

    expect(again.ok && again.account.balance).toBe(500);
    const audit = await database.auditLog.findFirstOrThrow({
      where: { action: "LOYALTY_ADMIN_ADJUSTMENT" },
    });
    expect(audit).toMatchObject({ actorUserId: operatorId });
    expect(audit.metadata).toMatchObject({ reason: "Apology for a cloudy night" });
  });

  it("refuses to take a balance below zero", async () => {
    const operatorId = await operator();
    await grant(100);

    await expect(
      adjustLoyaltyPoints({
        request: {
          adjustmentId: randomUUID(),
          userId,
          points: -200,
          reason: "Correction",
        },
        operatorId,
      }),
    ).resolves.toMatchObject({ ok: false, status: 409 });
    expect((await account()).balance).toBe(100);
  });

  it("refuses to edit an entry: corrections are new entries", async () => {
    await grant(100);
    const entry = await database.loyaltyLedgerEntry.findFirstOrThrow({
      where: { userId },
    });

    await expect(
      database.loyaltyLedgerEntry.update({
        where: { id: entry.id },
        data: { points: 1_000_000 },
      }),
    ).rejects.toThrow(/append-only/);
  });
});
