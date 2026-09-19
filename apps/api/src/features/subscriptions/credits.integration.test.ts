import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@darkview/db";
import {
  grantSubscriptionMinutes,
  postCreditEntry,
  readCreditBalance,
} from "@darkview/db/credits";

/**
 * ADR-022 against a real PostgreSQL instance: minutes move only in the transaction
 * of what caused them, once per source event, never below zero, and never by an
 * edit to what the ledger already recorded.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const NOW = new Date("2026-12-15T12:00:00.000Z");
const PERIOD_START = new Date("2026-12-01T00:00:00.000Z");

let database: PrismaClient;
let userId: string;

const post = (entry: Parameters<typeof postCreditEntry>[1]) =>
  database.$transaction((tx) => postCreditEntry(tx, entry));

const grant = (amount: number, key = `admin:${randomUUID()}`) =>
  post({ userId, amount, reason: "ADJUSTMENT", idempotencyKey: key });

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING, max: 16 }),
  });
  await database.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  // As above: a credit entry left behind is a foreign key no later suite can
  // delete a user through, and the ledger refuses the DELETE that would clear it.
  await database.$executeRawUnsafe('TRUNCATE "User" CASCADE');
  await database.$disconnect();
});

beforeEach(async () => {
  // One statement, because the suites share a database and leave rows behind: a
  // mission or a partner node still pointing at a user from another file is what
  // a delete list has to chase. CASCADE from User reaches every table that
  // references one, and TRUNCATE is also the only way past the ledger's
  // append-only trigger, which refuses a DELETE by design.
  await database.$executeRawUnsafe('TRUNCATE "User" CASCADE');
  await database.auditLog.deleteMany();
  const user = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Customer", emailVerifiedAt: NOW },
  });
  userId = user.id;
});

describe("the credit ledger", () => {
  it("creates the account on the first entry and records the balance it produced", async () => {
    const result = await grant(120);

    expect(result).toEqual({ posted: true, balance: 120 });
    expect(await readCreditBalance(database, userId)).toBe(120);

    const entries = await database.creditLedger.findMany({ where: { userId } });
    expect(entries).toHaveLength(1);
    expect(entries[0].amount).toBe(120);
    expect(entries[0].balanceAfter).toBe(120);
  });

  it("reports zero for a customer who has never had a credit", async () => {
    expect(await readCreditBalance(database, userId)).toBe(0);
    expect(await database.creditAccount.findUnique({ where: { userId } })).toBeNull();
  });

  it("grants once for one source event, however many times it is recorded", async () => {
    const key = `renewal:${randomUUID()}:2026-12-01`;

    expect(await grant(120, key)).toEqual({ posted: true, balance: 120 });
    expect(await grant(120, key)).toEqual({ posted: false, reason: "DUPLICATE" });

    expect(await readCreditBalance(database, userId)).toBe(120);
    expect(await database.creditLedger.count({ where: { userId } })).toBe(1);
  });

  it("keys a period's grant on the period, so two sweep passes grant once", async () => {
    const subscription = { id: randomUUID(), userId, isDemo: false };

    const first = await database.$transaction((tx) =>
      grantSubscriptionMinutes(tx, subscription, PERIOD_START, 120),
    );
    const second = await database.$transaction((tx) =>
      grantSubscriptionMinutes(tx, subscription, PERIOD_START, 120),
    );

    expect(first).toEqual({ posted: true, balance: 120 });
    expect(second).toEqual({ posted: false, reason: "DUPLICATE" });
    expect(await readCreditBalance(database, userId)).toBe(120);

    const entry = await database.creditLedger.findFirstOrThrow({ where: { userId } });
    expect(entry.reason).toBe("SUBSCRIPTION_GRANT");
    expect(entry.idempotencyKey).toBe(
      `renewal:${subscription.id}:${PERIOD_START.toISOString()}`,
    );
  });

  it("refuses a spend the balance cannot cover, and writes nothing", async () => {
    await grant(30);

    const spent = await post({
      userId,
      amount: -45,
      reason: "MISSION_DEBIT",
      idempotencyKey: `booking:${randomUUID()}`,
    });

    expect(spent).toEqual({ posted: false, reason: "INSUFFICIENT_CREDITS" });
    expect(await readCreditBalance(database, userId)).toBe(30);
    expect(await database.creditLedger.count({ where: { userId } })).toBe(1);
  });

  it("spends the balance down and releases it back on a refund", async () => {
    const bookingId = randomUUID();
    await grant(120);

    expect(
      await post({
        userId,
        amount: -30,
        reason: "MISSION_DEBIT",
        idempotencyKey: `booking:${bookingId}`,
      }),
    ).toEqual({ posted: true, balance: 90 });

    expect(
      await post({
        userId,
        amount: 30,
        reason: "REFUND",
        idempotencyKey: `booking:${bookingId}:release`,
      }),
    ).toEqual({ posted: true, balance: 120 });

    expect(await readCreditBalance(database, userId)).toBe(120);
  });

  it("lets only one of two spends racing on one balance succeed", async () => {
    await grant(30);

    const results = await Promise.all([
      post({
        userId,
        amount: -30,
        reason: "MISSION_DEBIT",
        idempotencyKey: `booking:${randomUUID()}`,
      }),
      post({
        userId,
        amount: -30,
        reason: "MISSION_DEBIT",
        idempotencyKey: `booking:${randomUUID()}`,
      }),
    ]);

    expect(results.filter((result) => result.posted)).toHaveLength(1);
    expect(results).toContainEqual({ posted: false, reason: "INSUFFICIENT_CREDITS" });
    expect(await readCreditBalance(database, userId)).toBe(0);
  });

  it("is append-only: an entry cannot be edited or removed", async () => {
    await grant(120);
    const entry = await database.creditLedger.findFirstOrThrow({ where: { userId } });

    await expect(
      database.creditLedger.update({ where: { id: entry.id }, data: { amount: 9000 } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      database.creditLedger.delete({ where: { id: entry.id } }),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses to write a private-session debit in Phase 1", async () => {
    await expect(
      post({
        userId,
        amount: -30,
        reason: "PRIVATE_SESSION_DEBIT",
        idempotencyKey: `booking:${randomUUID()}`,
      }),
    ).rejects.toThrow(/PRIVATE_SESSION_DEBIT/);
  });

  it("audits every entry", async () => {
    await grant(120);

    const audited = await database.auditLog.findMany({
      where: { category: "SUBSCRIPTION" },
    });
    expect(audited).toHaveLength(1);
    expect(audited[0].action).toBe("CREDIT_ADJUSTMENT");
    expect(audited[0].entityId).toBe(userId);
  });

  it("starts with an empty plan catalogue: nothing is on sale until prices are set", async () => {
    expect(await database.subscriptionPlanConfig.count()).toBe(0);
  });
});
