import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";
import { postCreditEntry, readCreditBalance } from "@darkview/db/credits";

import {
  createSandboxCharger,
  RENEWAL_GRACE_DAYS,
  RENEWAL_RETRY_DAYS,
  type RenewalCharger,
  sweepSubscriptions,
} from "@/subscriptions/renewals";

/**
 * ADR-022 sections 8 and 9, amended 2026-09-19, against a real PostgreSQL instance.
 * What only a database can show: that two sweeps open one charge, that a failed
 * charge makes room for the next attempt and no more, and that a period's minutes
 * expire once however many passes see it.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const PERIOD_START = new Date("2026-11-15T12:00:00.000Z");
const PERIOD_END = new Date("2026-12-15T12:00:00.000Z");
const DAY_MS = 86_400_000;
const after = (days: number) => new Date(PERIOD_END.getTime() + days * DAY_MS);

let database: PrismaClient;
let userId: string;
let subscriptionId: string;

async function subscribe(
  options: {
    status?: "ACTIVE" | "PAUSED";
    cancelAtPeriodEnd?: boolean;
    mandateRef?: string | null;
    minutes?: number;
  } = {},
) {
  const subscription = await database.subscription.create({
    data: {
      userId,
      plan: "OBSERVER",
      status: options.status ?? "ACTIVE",
      startsAt: PERIOD_START,
      priceMinor: 5000,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
      cancelAtPeriodEnd: options.cancelAtPeriodEnd ?? false,
      providerMandateRef: options.mandateRef === undefined ? "mandate_abc" : options.mandateRef,
    },
  });
  subscriptionId = subscription.id;
  const minutes = options.minutes ?? 90;
  if (minutes > 0) {
    await database.$transaction((tx) =>
      postCreditEntry(tx, {
        userId,
        amount: minutes,
        reason: "SUBSCRIPTION_GRANT",
        idempotencyKey: `renewal:${subscription.id}:${PERIOD_START.toISOString()}`,
      }),
    );
  }
}

function recordingCharger(): RenewalCharger & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    provider: "SANDBOX",
    calls,
    async chargeSavedInstrument(charge) {
      calls.push(charge);
    },
  };
}

const sweep = (now: Date, charger: RenewalCharger | null = createSandboxCharger()) =>
  sweepSubscriptions(database, { charger, now });

const subscription = () => database.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });

const renewals = () =>
  database.payment.findMany({
    where: { subscriptionId, periodStart: PERIOD_END },
    orderBy: { createdAt: "asc" },
  });

/** What the API's settlement writes when the provider reports a failed charge. */
async function failPending() {
  await database.payment.updateMany({
    where: { subscriptionId, status: "PENDING" },
    data: { status: "FAILED", failureReason: "DECLINED" },
  });
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING, max: 16 }),
  });
  await database.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  // A credit entry left behind is a foreign key no later suite can delete a user
  // through, and the ledger refuses the DELETE that would clear it.
  await database.$executeRawUnsafe('TRUNCATE "User" CASCADE');
  await database.$disconnect();
});

beforeEach(async () => {
  // TRUNCATE is the only way past the ledger's append-only trigger.
  await database.$executeRawUnsafe('TRUNCATE "User" CASCADE');
  await database.auditLog.deleteMany();
  const user = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Subscriber", emailVerifiedAt: PERIOD_START },
  });
  userId = user.id;
});

describe("renewing at period end", () => {
  it("expires the period's minutes, then charges the saved card for the next period", async () => {
    await subscribe();
    const charger = recordingCharger();

    const summary = await sweep(PERIOD_END, charger);

    expect(summary).toEqual({ charged: 1, cancelled: 0, expired: 0, unsubmitted: 0 });
    expect(await readCreditBalance(database, userId)).toBe(0);
    expect(
      await database.creditLedger.findUniqueOrThrow({
        where: { idempotencyKey: `expiry:${subscriptionId}:${PERIOD_END.toISOString()}` },
      }),
    ).toMatchObject({ amount: -90, reason: "EXPIRY" });

    const [payment] = await renewals();
    expect(payment).toMatchObject({
      purpose: "SUBSCRIPTION",
      provider: "SANDBOX",
      status: "PENDING",
      amountMinor: 5000,
    });
    expect(charger.calls).toEqual([
      { paymentId: payment.id, mandateRef: "mandate_abc", amountMinor: 5000, currency: "GEL" },
    ]);
    expect((await subscription()).status).toBe("ACTIVE");
    expect(
      await database.auditLog.count({ where: { action: "SUBSCRIPTION_RENEWAL_CHARGED" } }),
    ).toBe(1);
    expect(await database.auditLog.count({ where: { action: "CREDIT_EXPIRY" } })).toBe(1);
  });

  it("does nothing before the period ends", async () => {
    await subscribe();

    await sweep(new Date(PERIOD_END.getTime() - 1));

    expect(await renewals()).toHaveLength(0);
    expect(await readCreditBalance(database, userId)).toBe(90);
  });

  it("opens one charge and one expiry however many passes see the period", async () => {
    await subscribe();

    await sweep(PERIOD_END);
    await sweep(after(1));

    expect(await renewals()).toHaveLength(1);
    expect(await database.creditLedger.count({ where: { reason: "EXPIRY" } })).toBe(1);
  });

  it("opens one charge when two processes sweep at once", async () => {
    await subscribe();
    const first = recordingCharger();
    const second = recordingCharger();

    await Promise.all([sweep(PERIOD_END, first), sweep(PERIOD_END, second)]);

    expect(await renewals()).toHaveLength(1);
    expect(first.calls.length + second.calls.length).toBe(1);
    expect(await database.creditLedger.count({ where: { reason: "EXPIRY" } })).toBe(1);
  });

  it("writes no expiry entry for a period that left nothing unspent", async () => {
    await subscribe({ minutes: 0 });

    await sweep(PERIOD_END);

    expect(await database.creditLedger.count({ where: { reason: "EXPIRY" } })).toBe(0);
    expect(await renewals()).toHaveLength(1);
  });

  it("expires minutes and opens no charge where nothing may be charged", async () => {
    await subscribe();

    await sweep(PERIOD_END, null);

    expect(await renewals()).toHaveLength(0);
    expect(await readCreditBalance(database, userId)).toBe(0);
    expect((await subscription()).status).toBe("ACTIVE");
  });
});

describe("a failed renewal (ADR-022 section 9)", () => {
  it("retries two and four days after the period ended, and expires at the third failure", async () => {
    await subscribe();

    await sweep(PERIOD_END);
    await failPending();
    await sweep(after(RENEWAL_RETRY_DAYS - 0.5));
    expect(await renewals()).toHaveLength(1);

    await sweep(after(RENEWAL_RETRY_DAYS));
    expect(await renewals()).toHaveLength(2);
    expect((await subscription()).status).toBe("ACTIVE");
    await failPending();

    await sweep(after(RENEWAL_RETRY_DAYS * 2));
    expect(await renewals()).toHaveLength(3);
    await failPending();

    const summary = await sweep(after(RENEWAL_RETRY_DAYS * 2 + 0.01));
    expect(summary.expired).toBe(1);
    expect(await subscription()).toMatchObject({ status: "EXPIRED" });
    expect(await renewals()).toHaveLength(3);
    expect(
      await database.auditLog.findFirstOrThrow({ where: { action: "SUBSCRIPTION_EXPIRED" } }),
    ).toMatchObject({ metadata: expect.objectContaining({ reason: "ATTEMPTS_EXHAUSTED", failedAttempts: 3 }) });
  });

  it("expires when a charge is still unanswered seven days after the period ended", async () => {
    await subscribe();
    await sweep(PERIOD_END);

    await sweep(after(RENEWAL_GRACE_DAYS - 0.01));
    expect((await subscription()).status).toBe("ACTIVE");

    await sweep(after(RENEWAL_GRACE_DAYS));
    expect(await subscription()).toMatchObject({ status: "EXPIRED" });
  });

  it("counts a charge the provider would not take as a failed attempt", async () => {
    await subscribe();
    const refusing: RenewalCharger = {
      provider: "SANDBOX",
      async chargeSavedInstrument() {
        throw new Error("provider unavailable");
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = await sweep(PERIOD_END, refusing);

    expect(summary.unsubmitted).toBe(1);
    expect(await renewals()).toMatchObject([
      { status: "FAILED", failureReason: "CHARGE_NOT_SUBMITTED" },
    ]);
    expect(
      await database.auditLog.count({ where: { action: "SUBSCRIPTION_PAYMENT_FAILED" } }),
    ).toBe(1);
    await sweep(after(RENEWAL_RETRY_DAYS));
    expect(await renewals()).toHaveLength(2);
    error.mockRestore();
  });

  it("expires at once a subscription with no saved card to charge", async () => {
    await subscribe({ mandateRef: null });

    await sweep(PERIOD_END);

    expect(await subscription()).toMatchObject({ status: "EXPIRED" });
    expect(await renewals()).toHaveLength(0);
  });
});

describe("a subscription that is stopping", () => {
  it("is cancelled at the end of the period it paid for, with its minutes expired", async () => {
    await subscribe({ cancelAtPeriodEnd: true });

    const summary = await sweep(PERIOD_END);

    expect(summary.cancelled).toBe(1);
    expect(await subscription()).toMatchObject({ status: "CANCELLED", endsAt: PERIOD_END });
    expect(await renewals()).toHaveLength(0);
    expect(await readCreditBalance(database, userId)).toBe(0);
  });

  it("is neither charged nor ended while paused, and its minutes still expire", async () => {
    await subscribe({ status: "PAUSED" });

    await sweep(after(RENEWAL_GRACE_DAYS + 1));

    expect(await subscription()).toMatchObject({ status: "PAUSED" });
    expect(await renewals()).toHaveLength(0);
    expect(await readCreditBalance(database, userId)).toBe(0);
  });
});
