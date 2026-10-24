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
    VOUCHER_CODE_SECRET: "v".repeat(32),
    PAYMENT_PROVIDER: "BOG_IPAY" as "BOG_IPAY" | "SANDBOX" | undefined,
    BOG_CLIENT_ID: "99971" as string | undefined,
    BOG_SECRET_KEY: "unit-test-secret" as string | undefined,
  },
}));

const bank = vi.hoisted(() => ({
  createBogOrder: vi.fn(),
  fetchBogReceipt: vi.fn(),
}));

vi.mock("@/features/payments/bog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/payments/bog")>()),
  createBogOrder: bank.createBogOrder,
  fetchBogReceipt: bank.fetchBogReceipt,
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));
vi.mock("@/lib/validation/env", () => ({ getServerEnvironment: () => environment }));

const { PAYMENT_HOLD_MINUTES, reserveSlot } = await import("@/features/booking/reserve");
const { openBogCheckout, receiveBogCallback } = await import("@/features/payments/bog-checkout");
const { purchaseGiftVoucher } = await import("@/features/vouchers/vouchers");
const { nightWindow } = await import("@/lib/slots/darkness");
const { generateSlots, SLOT_DURATION_MINUTES } = await import("@/lib/slots/generate");

/**
 * ADR-073 against a real PostgreSQL instance, with only the bank's two calls faked:
 * opening an order and reading its receipt. Everything the receipt leads to runs
 * through `settlePayment` and its row locks.
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
    held: [],
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
  await database.emailNotification.deleteMany();
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
      name: "NexStar 8SE",
      manufacturer: "Celestron",
      model: "NexStar 8SE",
      apertureMm: 203,
      focalLengthMm: 2032,
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

  // Polaris: some 42 degrees up over Tbilisi all night, every night, so every slot
  // here can deliver it (#151). M13 stood here before, below the horizon for most of
  // a December night -- a booking the platform now refuses.
  const target = await database.target.create({
    data: {
      slug: `polaris-${randomUUID()}`,
      nameEn: "Polaris",
      nameKa: "პოლარისი",
      type: "DOUBLE_STAR",
      positionSource: "FIXED",
      rightAscensionHours: 2.5303,
      declinationDegrees: 89.2641,
      angularSizeArcmin: 0.3,
      magnitude: 2,
      opticalConfig: "F10_NATIVE",
      imagingProfile: "DOUBLE_STAR",
      minAltitudeDegrees: 25,
      expectedMissionMinutes: 30,
    },
  });
  targetId = target.id;
});

const BANK_PAGE = "https://payment.bog.ge/?order_id=bog-1";

/** The bank's receipt for a payment, for the sum the payment was opened for. */
async function receipt(paymentId: string, key: string, extra: Record<string, unknown> = {}) {
  const { amountMinor } = await database.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const amount = (amountMinor / 100).toFixed(2);
  return {
    external_order_id: paymentId,
    order_status: { key },
    purchase_units: { currency_code: "GEL", request_amount: amount, transfer_amount: amount },
    ...extra,
  };
}

function callback(orderId: string) {
  return JSON.stringify({ event: "order_payment", body: { order_id: orderId } });
}

async function opened(paymentId: string, forUserId: string = userId) {
  const result = await openBogCheckout({ userId: forUserId, paymentId, now: NOW });
  if (!result.ok) throw new Error(result.message);
  return result.location;
}

describe("Bank of Georgia as the provider (ADR-073)", () => {
  beforeEach(() => {
    environment.NODE_ENV = "test";
    environment.PAYMENT_PROVIDER = "BOG_IPAY";
    environment.BOG_CLIENT_ID = "99971";
    environment.BOG_SECRET_KEY = "unit-test-secret";
    bank.createBogOrder.mockReset();
    bank.fetchBogReceipt.mockReset();
    bank.createBogOrder.mockResolvedValue({ orderId: "bog-1", redirectUrl: BANK_PAGE });
  });

  it("opens a reservation's payment with BOG, pointing at this API's checkout", async () => {
    const { paymentIntent } = await reserve();
    expect(paymentIntent.redirectUrl).toBe(
      `https://darkview.test/api/payments/${paymentIntent.paymentId}/checkout`,
    );
    const payment = await database.payment.findUniqueOrThrow({ where: { id: paymentIntent.paymentId } });
    expect(payment).toMatchObject({ provider: "BOG_IPAY", providerRef: null });
  });

  it("opens the bank's order on the first visit, for what is left of the hold, and only once", async () => {
    const { booking, paymentIntent } = await reserve(await createUser("ka"));
    const payer = booking.userId;
    expect(await opened(paymentIntent.paymentId, payer)).toBe(BANK_PAGE);
    expect(bank.createBogOrder).toHaveBeenCalledTimes(1);
    expect(bank.createBogOrder.mock.calls[0][1]).toMatchObject({
      paymentId: paymentIntent.paymentId,
      amountMinor: booking.priceMinor,
      currency: "GEL",
      locale: "ka",
      ttlMinutes: PAYMENT_HOLD_MINUTES,
      callbackUrl: "https://darkview.test/api/payments/bog/callback",
      successUrl: `https://darkview.test/ka/app/bookings/${booking.id}`,
      failUrl: `https://darkview.test/ka/app/bookings/${booking.id}`,
    });

    expect(await opened(paymentIntent.paymentId, payer)).toBe(BANK_PAGE);
    expect(bank.createBogOrder).toHaveBeenCalledTimes(1);
    expect(await database.payment.findUniqueOrThrow({ where: { id: paymentIntent.paymentId } })).toMatchObject({
      providerRef: "bog-1",
      redirectUrl: BANK_PAGE,
    });
  });

  it("is a 404 for somebody else's payment and sends a lapsed hold back to its booking", async () => {
    const { booking, paymentIntent } = await reserve();
    expect(
      await openBogCheckout({ userId: await createUser(), paymentId: paymentIntent.paymentId, now: NOW }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await openBogCheckout({ userId, paymentId: paymentIntent.paymentId, now: AFTER_HOLD }),
    ).toEqual({ ok: true, location: `https://darkview.test/en/app/bookings/${booking.id}` });
    expect(bank.createBogOrder).not.toHaveBeenCalled();
  });

  it("answers 503 and opens nothing when the bank cannot be reached", async () => {
    const { paymentIntent } = await reserve();
    bank.createBogOrder.mockRejectedValueOnce(new Error("down"));
    expect(
      await openBogCheckout({ userId, paymentId: paymentIntent.paymentId, now: NOW }),
    ).toMatchObject({ ok: false, status: 503 });
    expect(
      await database.payment.findUniqueOrThrow({ where: { id: paymentIntent.paymentId } }),
    ).toMatchObject({ providerRef: null });
  });

  it("refuses to sell without the merchant's keys, and production never falls back to the sandbox", async () => {
    environment.BOG_CLIENT_ID = undefined;
    await expect(reserve()).rejects.toThrow(/no payment provider/);

    environment.BOG_CLIENT_ID = "99971";
    environment.NODE_ENV = "production";
    environment.PAYMENT_PROVIDER = undefined;
    const { paymentIntent } = await reserve();
    expect(paymentIntent.redirectUrl).toContain("/checkout");

    environment.PAYMENT_PROVIDER = "SANDBOX";
    await expect(reserve()).rejects.toThrow(/no payment provider/);
  });

  it("confirms the booking from the receipt the bank is asked for, once", async () => {
    const { booking, paymentIntent } = await reserve();
    await opened(paymentIntent.paymentId);
    bank.fetchBogReceipt.mockResolvedValue(await receipt(paymentIntent.paymentId, "completed"));

    expect(await receiveBogCallback(callback("bog-1"), NOW)).toEqual({ status: 200 });
    expect(bank.fetchBogReceipt).toHaveBeenCalledWith(expect.anything(), "bog-1");
    const confirmed = await database.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.missionId).not.toBeNull();

    expect(await receiveBogCallback(callback("bog-1"), NOW)).toEqual({ status: 200 });
    expect(await database.mission.count()).toBe(1);
    expect(
      await database.payment.findUniqueOrThrow({ where: { id: paymentIntent.paymentId } }),
    ).toMatchObject({ status: "CAPTURED", providerRef: "bog-1" });
  });

  it("believes the receipt, not the callback, and refuses a short capture", async () => {
    const { booking, paymentIntent } = await reserve();
    await opened(paymentIntent.paymentId);
    bank.fetchBogReceipt.mockResolvedValue(
      await receipt(paymentIntent.paymentId, "completed", {
        purchase_units: { currency_code: "GEL", request_amount: "45.00", transfer_amount: "4.50" },
      }),
    );
    expect(await receiveBogCallback(callback("bog-1"), NOW)).toEqual({ status: 200 });
    expect((await database.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      "PENDING_PAYMENT",
    );
    expect(
      await database.auditLog.count({ where: { action: "PAYMENT_WEBHOOK_REFUSED" } }),
    ).toBeGreaterThan(0);
  });

  it("releases the slot when the bank rejects, and keeps waiting while it is in progress", async () => {
    const { booking, paymentIntent } = await reserve();
    await opened(paymentIntent.paymentId);

    bank.fetchBogReceipt.mockResolvedValueOnce(await receipt(paymentIntent.paymentId, "in_progress"));
    expect(await receiveBogCallback(callback("bog-1"), NOW)).toEqual({ status: 200 });
    expect((await database.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      "PENDING_PAYMENT",
    );

    bank.fetchBogReceipt.mockResolvedValueOnce(
      await receipt(paymentIntent.paymentId, "rejected", { reject_reason: "expiration" }),
    );
    expect(await receiveBogCallback(callback("bog-1"), NOW)).toEqual({ status: 200 });
    expect(
      await database.payment.findUniqueOrThrow({ where: { id: paymentIntent.paymentId } }),
    ).toMatchObject({ status: "FAILED", failureReason: "PAYMENT_EXPIRED" });
    expect((await database.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).not.toBe(
      "PENDING_PAYMENT",
    );
  });

  it("acknowledges an unknown order, and asks the bank to call again when its receipt cannot be read", async () => {
    expect(await receiveBogCallback(callback("nobody"), NOW)).toEqual({ status: 200 });
    expect(bank.fetchBogReceipt).not.toHaveBeenCalled();
    expect(await receiveBogCallback("not json", NOW)).toEqual({ status: 400 });

    const { paymentIntent } = await reserve();
    await opened(paymentIntent.paymentId);
    bank.fetchBogReceipt.mockRejectedValueOnce(new Error("timeout"));
    expect(await receiveBogCallback(callback("bog-1"), NOW)).toEqual({ status: 502 });
  });

  it("gives a gift the bank's hour, and activates it on capture", async () => {
    const ordered = await purchaseGiftVoucher({
      userId,
      request: { durationMinutes: SLOT_DURATION_MINUTES },
      now: NOW,
    });
    if (!ordered.ok) throw new Error(ordered.message);
    const { voucher, paymentIntent } = ordered.body;
    await opened(paymentIntent.paymentId);
    expect(bank.createBogOrder.mock.calls[0][1]).toMatchObject({
      ttlMinutes: 60,
      successUrl: `https://darkview.test/en/gift/${voucher.id}`,
    });

    bank.fetchBogReceipt.mockResolvedValue(await receipt(paymentIntent.paymentId, "completed"));
    expect(await receiveBogCallback(callback("bog-1"), NOW)).toEqual({ status: 200 });
    expect(
      (await database.giftVoucher.findUniqueOrThrow({ where: { id: voucher.id } })).status,
    ).not.toBe("PENDING_PAYMENT");
  });
});
