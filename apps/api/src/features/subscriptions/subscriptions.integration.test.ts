import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { zSubscription, zSubscriptionWithPaymentIntent } from "@darkview/contracts/zod";
import { PrismaClient } from "@darkview/db";
import { readCreditBalance } from "@darkview/db/credits";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({ NODE_ENV: process.env.NODE_ENV ?? "test" }),
}));

const { settlePayment } = await import("@/features/payments/settle");
const {
  cancelMySubscription,
  pauseMySubscription,
  readMySubscription,
  readSubscriptionPlans,
  resumeMySubscription,
  subscribe,
} = await import("@/features/subscriptions/subscriptions");

/**
 * ADR-022 against a real PostgreSQL instance. What only a database can show: that a
 * period's minutes are granted once and only by a captured payment, that the
 * append-only ledger the grant goes through survives a repeated webhook, and that a
 * cancellation leaves the minutes somebody paid for where they are.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const NOW = new Date("2026-12-15T12:00:00.000Z");
const PRICE_MINOR = 9000;
const MINUTES = 120;

let database: PrismaClient;
let userId: string;

async function offerPlan(
  plan: "OBSERVER" | "EXPLORER" | "ADVANCED",
  overrides: { priceMinor?: number; minutesPerPeriod?: number; isAvailable?: boolean } = {},
) {
  const data = {
    nameEn: `${plan} plan`,
    nameKa: `${plan} გეგმა`,
    priceMinor: overrides.priceMinor ?? PRICE_MINOR,
    minutesPerPeriod: overrides.minutesPerPeriod ?? MINUTES,
    isAvailable: overrides.isAvailable ?? true,
  };
  await database.subscriptionPlanConfig.upsert({
    where: { plan },
    create: { plan, ...data },
    update: data,
  });
}

/** Subscribe and return the payment the first period waits on. */
async function order(plan: "OBSERVER" | "EXPLORER" | "ADVANCED" = "OBSERVER") {
  const result = await subscribe({ userId, request: { plan }, now: NOW });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(zSubscriptionWithPaymentIntent.safeParse(result.body).success).toBe(true);
  return result.body;
}

async function settle(
  paymentId: string,
  outcome: { result?: "CAPTURED" | "FAILED"; amountMinor?: number; mandateRef?: string } = {},
  now: Date = NOW,
) {
  const settled = await settlePayment({
    provider: "SANDBOX",
    outcome: {
      paymentId,
      providerRef: `sbx_${paymentId.slice(0, 8)}`,
      result: outcome.result ?? "CAPTURED",
      amountMinor: outcome.amountMinor ?? PRICE_MINOR,
      currency: "GEL",
      failureReason: outcome.result === "FAILED" ? "CARD_DECLINED" : null,
      ...(outcome.mandateRef ? { mandateRef: outcome.mandateRef } : {}),
    },
    now,
  });
  if (!settled.ok) throw new Error(settled.message);
  return settled;
}

const balance = () => readCreditBalance(database, userId);
const subscriptionRow = () => database.subscription.findUniqueOrThrow({ where: { userId } });

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING, max: 16 }),
  });
  testDatabase.current = database;
  await database.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  // Leave the database as it was found. This matters more here than in most
  // suites: `CreditLedger.user` is onDelete Restrict and the ledger refuses a
  // DELETE, so one entry left behind makes `user.deleteMany()` fail in every
  // suite that runs after this one. This suite is also the only one that puts a
  // plan on sale, and a sibling asserts the catalogue ships empty.
  await database.$executeRawUnsafe('TRUNCATE "User" CASCADE');
  await database.subscriptionPlanConfig.deleteMany();
  await database.$disconnect();
});

beforeEach(async () => {
  // One statement, because the suites share a database and leave rows behind: a
  // mission or a partner node still pointing at a user from another file is what
  // a delete list has to chase. CASCADE from User reaches every table that
  // references one, and TRUNCATE is also the only way past the credit ledger's
  // append-only trigger, which refuses a DELETE by design.
  await database.$executeRawUnsafe('TRUNCATE "User" CASCADE');
  await database.subscriptionPlanConfig.deleteMany();
  await database.auditLog.deleteMany();

  const user = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Subscriber", emailVerifiedAt: NOW },
  });
  userId = user.id;
});

describe("the plan catalogue", () => {
  it("is empty until a plan is made available, and is ordered by price", async () => {
    expect(await readSubscriptionPlans()).toEqual([]);

    await offerPlan("EXPLORER", { priceMinor: 18000 });
    await offerPlan("OBSERVER", { priceMinor: 9000 });
    await offerPlan("ADVANCED", { priceMinor: 30000, isAvailable: false });

    const plans = await readSubscriptionPlans();
    expect(plans.map((plan) => plan.plan)).toEqual(["OBSERVER", "EXPLORER"]);
  });

  it("refuses to sell when nothing is configured, and when the named plan is withdrawn", async () => {
    const nothing = await subscribe({ userId, request: { plan: "OBSERVER" }, now: NOW });
    expect(nothing).toMatchObject({ ok: false, status: 503 });

    await offerPlan("EXPLORER");
    await offerPlan("OBSERVER", { isAvailable: false });
    const withdrawn = await subscribe({ userId, request: { plan: "OBSERVER" }, now: NOW });
    expect(withdrawn).toMatchObject({ ok: false, status: 422 });
  });
});

describe("subscribing", () => {
  beforeEach(() => offerPlan("OBSERVER"));

  it("grants nothing until the payment is captured", async () => {
    const ordered = await order();

    expect(ordered.subscription.minuteBalance).toBe(0);
    expect(ordered.subscription.currentPeriodStart).toBeNull();
    expect(await balance()).toBe(0);

    const payment = await database.payment.findUniqueOrThrow({
      where: { id: ordered.paymentIntent.paymentId },
    });
    expect(payment).toMatchObject({
      purpose: "SUBSCRIPTION",
      status: "PENDING",
      amountMinor: PRICE_MINOR,
      // Not a renewal: the period it funds begins when it captures.
      periodStart: null,
    });
  });

  it("opens the period and grants its minutes when the payment captures", async () => {
    const ordered = await order();
    await settle(ordered.paymentIntent.paymentId, { mandateRef: "mandate_abc" });

    const subscription = await readMySubscription(userId);
    expect(zSubscription.safeParse(subscription).success).toBe(true);
    expect(subscription).toMatchObject({
      status: "ACTIVE",
      minuteBalance: MINUTES,
      currentPeriodStart: NOW.toISOString(),
      currentPeriodEnd: "2027-01-15T12:00:00.000Z",
    });
    expect((await subscriptionRow()).providerMandateRef).toBe("mandate_abc");
  });

  it("earns loyalty points on the money, and none on the minutes", async () => {
    const ordered = await order();
    await settle(ordered.paymentIntent.paymentId);

    const entries = await database.loyaltyLedgerEntry.findMany({ where: { userId } });
    expect(entries.some((entry) => entry.kind === "PURCHASE_EARNED")).toBe(true);
    // ADR-022 section 3: three balances, three ledgers, no crossing.
    expect(entries.every((entry) => entry.points >= 0)).toBe(true);
  });

  it("grants one period's minutes however many times the webhook arrives", async () => {
    const ordered = await order();
    await settle(ordered.paymentIntent.paymentId);
    const repeated = await settle(ordered.paymentIntent.paymentId);

    expect(repeated).toMatchObject({ applied: false });
    expect(await balance()).toBe(MINUTES);
    expect(await database.creditLedger.count({ where: { userId } })).toBe(1);
  });

  it("ends a subscription whose first payment failed, and lets the customer try again", async () => {
    const ordered = await order();
    await settle(ordered.paymentIntent.paymentId, { result: "FAILED" });

    // Nothing saved a card, so no retry could reach an instrument.
    expect(await subscriptionRow()).toMatchObject({ status: "EXPIRED" });
    expect(await balance()).toBe(0);

    const again = await order();
    expect(again.subscription.status).toBe("ACTIVE");
  });

  it("refuses a second subscription while one is running", async () => {
    const ordered = await order();
    await settle(ordered.paymentIntent.paymentId);

    const second = await subscribe({ userId, request: { plan: "OBSERVER" }, now: NOW });
    expect(second).toMatchObject({ ok: false, status: 409 });
  });

  it("keeps the minutes of a period paid for after the customer cancelled", async () => {
    const ordered = await order();
    // The customer cancels while the bank is still thinking. They have no funded
    // period yet, so the subscription ends -- and then the money arrives.
    await cancelMySubscription({ userId, now: NOW });
    await settle(ordered.paymentIntent.paymentId);

    const row = await subscriptionRow();
    expect(row.status).toBe("CANCELLED");
    expect(await balance()).toBe(MINUTES);
  });
});

describe("pausing, resuming and cancelling", () => {
  beforeEach(() => offerPlan("OBSERVER"));

  it("answers 404 before there is anything to change", async () => {
    expect(await pauseMySubscription({ userId, now: NOW })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await cancelMySubscription({ userId, now: NOW })).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("pauses and resumes, idempotently and without writing a row for a no-op", async () => {
    const ordered = await order();
    await settle(ordered.paymentIntent.paymentId);

    const paused = await pauseMySubscription({ userId, now: NOW });
    expect(paused).toMatchObject({ ok: true, body: { status: "PAUSED" } });
    expect((await subscriptionRow()).pausedAt).not.toBeNull();

    const again = await pauseMySubscription({ userId, now: NOW });
    expect(again).toMatchObject({ ok: true, body: { status: "PAUSED" } });
    expect(
      await database.auditLog.count({ where: { action: "SUBSCRIPTION_PAUSED" } }),
    ).toBe(1);

    expect(await resumeMySubscription({ userId, now: NOW })).toMatchObject({
      ok: true,
      body: { status: "ACTIVE" },
    });
    expect((await subscriptionRow()).pausedAt).toBeNull();
    expect(await resumeMySubscription({ userId, now: NOW })).toMatchObject({ ok: true });
  });

  it("refuses to resume a subscription that is ending, however it is ending", async () => {
    const ordered = await order();
    await settle(ordered.paymentIntent.paymentId);
    await cancelMySubscription({ userId, now: NOW });

    // Still ACTIVE, and still running out the period it was paid for. A 200 here
    // would read as an un-cancellation that nothing performed.
    expect((await subscriptionRow()).status).toBe("ACTIVE");
    expect(await resumeMySubscription({ userId, now: NOW })).toMatchObject({
      ok: false,
      status: 409,
    });

    const afterPeriodEnd = new Date("2027-02-01T12:00:00.000Z");
    await cancelMySubscription({ userId, now: afterPeriodEnd });
    expect(await resumeMySubscription({ userId, now: NOW })).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("lets a funded period run to its end, keeping the minutes spendable", async () => {
    const ordered = await order();
    await settle(ordered.paymentIntent.paymentId);

    const cancelled = await cancelMySubscription({ userId, now: NOW });
    expect(cancelled).toMatchObject({
      ok: true,
      // Nothing is refunded and nothing is taken back: the period is paid for.
      body: { status: "ACTIVE", cancelAtPeriodEnd: true, minuteBalance: MINUTES },
    });

    // Idempotent, and it does not fall through to an immediate cancellation.
    expect(await cancelMySubscription({ userId, now: NOW })).toMatchObject({
      ok: true,
      body: { status: "ACTIVE", cancelAtPeriodEnd: true },
    });
    expect(
      await database.auditLog.count({ where: { action: "SUBSCRIPTION_CANCEL_SCHEDULED" } }),
    ).toBe(1);
  });

  it("ends a subscription at once when its period has already run out", async () => {
    const ordered = await order();
    await settle(ordered.paymentIntent.paymentId);

    const afterPeriodEnd = new Date("2027-02-01T12:00:00.000Z");
    const cancelled = await cancelMySubscription({ userId, now: afterPeriodEnd });
    expect(cancelled).toMatchObject({ ok: true, body: { status: "CANCELLED" } });
    expect((await subscriptionRow()).endsAt).toEqual(afterPeriodEnd);

    expect(await cancelMySubscription({ userId, now: afterPeriodEnd })).toMatchObject({
      ok: false,
      status: 409,
    });
  });
});

describe("renewing (ADR-022 sections 8 and 9, amended 2026-09-19)", () => {
  beforeEach(() => offerPlan("OBSERVER"));

  const PERIOD_END = new Date("2027-01-15T12:00:00.000Z");

  /** A funded subscription, and the charge the realtime sweep opens at its period end. */
  async function funded() {
    const ordered = await order();
    await settle(ordered.paymentIntent.paymentId, { mandateRef: "mandate_abc" });
    return (await subscriptionRow()).id;
  }

  const openRenewal = (subscriptionId: string) =>
    database.payment.create({
      data: {
        userId,
        purpose: "SUBSCRIPTION",
        provider: "SANDBOX",
        status: "PENDING",
        amountMinor: PRICE_MINOR,
        subscriptionId,
        periodStart: PERIOD_END,
      },
    });

  it("grants the next period's minutes when the renewal captures, and keeps the saved card", async () => {
    const subscriptionId = await funded();
    const renewal = await openRenewal(subscriptionId);

    await settle(renewal.id, {}, PERIOD_END);

    expect(await subscriptionRow()).toMatchObject({
      status: "ACTIVE",
      currentPeriodStart: PERIOD_END,
      currentPeriodEnd: new Date("2027-02-15T12:00:00.000Z"),
      providerMandateRef: "mandate_abc",
      lastPaymentId: renewal.id,
    });
    expect(await balance()).toBe(MINUTES * 2);
    expect(await database.auditLog.count({ where: { action: "SUBSCRIPTION_RENEWED" } })).toBe(1);
  });

  it("grants nothing on a failed renewal, and lets the next attempt open and capture once", async () => {
    const subscriptionId = await funded();
    const first = await openRenewal(subscriptionId);
    await settle(first.id, { result: "FAILED" }, PERIOD_END);

    expect(await subscriptionRow()).toMatchObject({ status: "ACTIVE", currentPeriodEnd: PERIOD_END });
    expect(await balance()).toBe(MINUTES);

    const retry = await openRenewal(subscriptionId);
    await settle(retry.id, {}, PERIOD_END);

    expect(await balance()).toBe(MINUTES * 2);
    expect(
      await database.creditLedger.count({ where: { reason: "SUBSCRIPTION_GRANT" } }),
    ).toBe(2);
  });

  it("refuses a second live charge for one period", async () => {
    const subscriptionId = await funded();
    await openRenewal(subscriptionId);

    await expect(openRenewal(subscriptionId)).rejects.toThrow();
  });

  it("resumes a pause that outlasted its period into a period that starts now", async () => {
    await funded();
    await pauseMySubscription({ userId, now: NOW });
    const resumedAt = new Date("2027-03-01T12:00:00.000Z");

    await expect(resumeMySubscription({ userId, now: resumedAt })).resolves.toMatchObject({
      ok: true,
      body: { status: "ACTIVE", currentPeriodEnd: resumedAt.toISOString() },
    });
  });

  it("leaves the period alone when a pause is lifted before it ends", async () => {
    await funded();
    await pauseMySubscription({ userId, now: NOW });

    await resumeMySubscription({ userId, now: NOW });

    expect((await subscriptionRow()).currentPeriodEnd).toEqual(PERIOD_END);
  });
});
