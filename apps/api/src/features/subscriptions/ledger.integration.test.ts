import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@darkview/db";
import {
  expireSubscriptionMinutes,
  postCreditEntry,
  readCreditBalance,
  releaseSpentMinutes,
  spendBookingMinutes,
} from "@darkview/db/credits";

/**
 * The credit ledger against ADR-022, as amended on 2026-09-19: minutes do not
 * roll over, they expire at period end -- and cancelling refunds nothing
 * "because the period is already funded and its credits already granted", which
 * is only true if a cancelled customer can still spend them.
 *
 * Needs a real PostgreSQL at DATABASE_TEST_URL and skips without one.
 */
const CONNECTION_STRING = process.env.DATABASE_TEST_URL;
const PERIOD_START = new Date("2026-12-01T00:00:00.000Z");
const PERIOD_END = new Date("2027-01-01T00:00:00.000Z");
/** The 30-day automatic refund lands here: after the period it belonged to. */
const AFTER_PERIOD_END = new Date("2027-01-05T00:00:00.000Z");

let database: PrismaClient;
let userId: string;
let subscriptionId: string;

async function subscribe(status: "ACTIVE" | "CANCELLED", periodEnd: Date) {
  const subscription = await database.subscription.create({
    data: {
      userId,
      plan: "OBSERVER",
      status,
      startsAt: PERIOD_START,
      priceMinor: 5000,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: periodEnd,
    },
  });
  subscriptionId = subscription.id;
  await database.$transaction((tx) =>
    postCreditEntry(tx, {
      userId,
      amount: 120,
      reason: "SUBSCRIPTION_GRANT",
      idempotencyKey: `renewal:${userId}:${PERIOD_START.toISOString()}`,
    }),
  );
}

describe.skipIf(!CONNECTION_STRING)("the credit ledger against ADR-022", () => {
  beforeAll(async () => {
    database = new PrismaClient({
      adapter: new PrismaPg({ connectionString: CONNECTION_STRING! }),
    });
  });

  afterAll(async () => {
    await database.$executeRawUnsafe('TRUNCATE "User" CASCADE');
    await database.$disconnect();
  });

  beforeEach(async () => {
    await database.$executeRawUnsafe('TRUNCATE "User" CASCADE');
    const user = await database.user.create({
      data: { email: `${randomUUID()}@example.test`, name: "Probe", emailVerifiedAt: PERIOD_START },
    });
    userId = user.id;
  });

  it("minutes returned by a refund after the period ended still expire", async () => {
    await subscribe("ACTIVE", PERIOD_END);
    const bookingId = randomUUID();
    await database.$transaction((tx) =>
      postCreditEntry(tx, {
        userId,
        amount: -30,
        reason: "MISSION_DEBIT",
        idempotencyKey: `booking:${bookingId}`,
      }),
    );

    const subscription = { id: subscriptionId, userId, isDemo: false };
    await database.$transaction((tx) => expireSubscriptionMinutes(tx, subscription, PERIOD_END));
    expect(await readCreditBalance(database, userId)).toBe(0);

    // The 30-day automatic refund (refunds.ts:265) lands after the period ended.
    await database.$transaction((tx) =>
      releaseSpentMinutes(
        tx,
        { id: bookingId, userId, subscriptionMinutesSpent: 30 },
        AFTER_PERIOD_END,
      ),
    );
    // The sweep's next pass for the same period end.
    await database.$transaction((tx) => expireSubscriptionMinutes(tx, subscription, PERIOD_END));

    expect(await readCreditBalance(database, userId)).toBe(0);
  });

  // Skipped, not deleted, and not made to pass: it is the open question itself.
  //
  // Settlement grants a period's minutes to a subscription the customer had
  // already cancelled -- "ADR-022 gives them the minutes it bought" -- and
  // `spendBookingMinutes` refuses to let a CANCELLED subscription spend anything,
  // which `minutes.integration.test.ts` asserts on purpose. Money is taken and
  // nothing is given. Either the grant should not happen or cancellation should
  // keep spending alive until the period it funded ends; ADR-022 section 9 says
  // cancellation is "immediate", section 6's amendment says the period is funded
  // and its credits granted, and the two do not agree. A product decision.
  it.skip("minutes granted by a capture on a cancelled subscription can be spent", async () => {
    // The state subscriptions.ts:559-583 leaves after a capture that lands on a
    // CANCELLED subscription: status stands, period set, minutes granted.
    await subscribe("CANCELLED", PERIOD_END);
    const result = await database.$transaction((tx) =>
      spendBookingMinutes(
        tx,
        { id: randomUUID(), userId, minutes: 30, isDemo: false },
        new Date("2026-12-15T12:00:00.000Z"),
      ),
    );
    expect(result).toEqual({ spent: true });
  });
});
