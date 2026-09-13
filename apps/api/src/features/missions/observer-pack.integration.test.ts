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

const {
  OBSERVER_PACK_HOLD_MINUTES,
  PROVISIONAL_OBSERVER_PACK_PRICE_MINOR,
  purchaseObserverPack,
} = await import("@/features/missions/observer-pack");
const { releaseObserverSeat, takeObserverSeat } =
  await import("@/features/missions/observers");
const { settlePayment } = await import("@/features/payments/settle");
const { zObserverPack, zObserverPackWithPaymentIntent } =
  await import("@darkview/contracts/zod");

/**
 * DV-102 against a real PostgreSQL instance.
 *
 * The claim worth testing is the one that needs locks: ADR-007's five seats are a
 * count followed by an insert, and a count followed by an insert is not a cap.
 * Twenty people buying at once is the test that separates a lock from a hope, and
 * a mocked client has no locks to exercise.
 *
 * The second claim is about money arriving late. DV-056 decided that being late
 * to pay costs the customer their slot only if somebody else took it; the same
 * has to hold for a seat, and both halves of it are exercised below.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const POOL_SIZE = 32;
const CONTENDERS = 20;
const CAPACITY = 5;

const NOW = new Date("2026-07-15T20:00:00.000Z");
const AFTER_HOLD = new Date(NOW.getTime() + (OBSERVER_PACK_HOLD_MINUTES + 1) * 60_000);

let database: PrismaClient;
let observatoryId: string;
let telescopeId: string;
let targetId: string;
let missionId: string;
let controllerId: string;

async function createUser(label: string): Promise<string> {
  const user = await database.user.create({
    data: {
      email: `${label}-${randomUUID()}@example.test`,
      name: label,
      emailVerifiedAt: NOW,
    },
  });
  return user.id;
}

async function openToObservers(capacity = CAPACITY) {
  await database.mission.update({
    where: { id: missionId },
    data: { joinPolicy: "OPEN", observerCapacity: capacity },
  });
}

async function buy(userId: string, now = NOW) {
  const result = await purchaseObserverPack({ missionId, userId, now });
  if (!result.ok) throw new Error(`fixture purchase failed: ${result.message}`);
  return result.value;
}

function captured(paymentId: string, overrides: Record<string, unknown> = {}) {
  return {
    paymentId,
    providerRef: `sbx_${paymentId.slice(0, 8)}`,
    result: "CAPTURED" as const,
    amountMinor: PROVISIONAL_OBSERVER_PACK_PRICE_MINOR,
    currency: "GEL" as const,
    failureReason: null,
    ...overrides,
  };
}

async function auditActions(entityId: string) {
  const rows = await database.auditLog.findMany({
    where: { entityId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => row.action);
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING, max: POOL_SIZE }),
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
  await database.auditLog.deleteMany();
  await database.missionParticipant.deleteMany();
  await database.missionEvent.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  await database.observerPack.deleteMany();
  await database.booking.deleteMany();
  await database.mission.deleteMany();
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

  controllerId = await createUser("controller");

  const mission = await database.mission.create({
    data: {
      userId: controllerId,
      targetId,
      observatoryId,
      telescopeId,
      state: "OBSERVING",
    },
  });
  missionId = mission.id;
});

describe("buying a seat", () => {
  it("holds it and opens a payment intent for it", async () => {
    await openToObservers();
    const buyer = await createUser("buyer");

    const result = await purchaseObserverPack({ missionId, userId: buyer, now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(() => zObserverPackWithPaymentIntent.parse(result.value)).not.toThrow();
    expect(() => zObserverPack.parse(result.value.observerPack)).not.toThrow();

    expect(result.value.observerPack).toMatchObject({
      missionId,
      userId: buyer,
      status: "PENDING_PAYMENT",
      priceMinor: PROVISIONAL_OBSERVER_PACK_PRICE_MINOR,
      currency: "GEL",
    });
    expect(result.value.paymentIntent).toMatchObject({
      provider: "SANDBOX",
      status: "PENDING",
    });

    const payment = await database.payment.findUniqueOrThrow({
      where: { id: result.value.paymentIntent.paymentId },
    });
    // The settlement path branches on this rather than on which relation is null.
    expect(payment.purpose).toBe("OBSERVER_PACK");
    expect(payment.amountMinor).toBe(PROVISIONAL_OBSERVER_PACK_PRICE_MINOR);

    expect(await auditActions(result.value.observerPack.id)).toEqual([
      "OBSERVER_PACK_RESERVED",
    ]);
  });

  it("is priced below a full session, as ADR-007 rule 6 requires", async () => {
    const { PROVISIONAL_SLOT_PRICE_MINOR } = await import("@/lib/slots/generate");
    expect(PROVISIONAL_OBSERVER_PACK_PRICE_MINOR).toBeLessThan(
      PROVISIONAL_SLOT_PRICE_MINOR,
    );
  });

  it("returns the same pack and payment when somebody asks twice", async () => {
    await openToObservers();
    const buyer = await createUser("buyer");

    const first = await buy(buyer);
    const again = await buy(buyer);

    expect(again.observerPack.id).toBe(first.observerPack.id);
    expect(again.paymentIntent.paymentId).toBe(first.paymentIntent.paymentId);
    expect(await database.payment.count({ where: { userId: buyer } })).toBe(1);
  });

  it("refuses a session the controller has not opened", async () => {
    const buyer = await createUser("buyer");

    const result = await purchaseObserverPack({ missionId, userId: buyer, now: NOW });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.code).toBe("MISSION_NOT_OBSERVABLE");
    }
    // Nothing was sold, so nothing was charged.
    expect(await database.payment.count()).toBe(0);
  });

  it("refuses the controller a seat on their own session", async () => {
    await openToObservers();

    const result = await purchaseObserverPack({
      missionId,
      userId: controllerId,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });

  it("refuses a mission that is not live", async () => {
    await openToObservers();
    await database.mission.update({
      where: { id: missionId },
      data: { state: "COMPLETE" },
    });
    const buyer = await createUser("buyer");

    const result = await purchaseObserverPack({ missionId, userId: buyer, now: NOW });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MISSION_NOT_ACTIVE");
  });
});

describe("ADR-007's five seats, under contention", () => {
  it("sells exactly five when twenty people buy at once", async () => {
    await openToObservers();

    const contenders = await Promise.all(
      Array.from({ length: CONTENDERS }, (_, index) => createUser(`buyer-${index}`)),
    );

    const results = await Promise.all(
      contenders.map((userId) =>
        purchaseObserverPack({ missionId, userId, now: NOW }),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(CAPACITY);
    for (const result of results.filter((result) => !result.ok)) {
      if (result.ok) continue;
      expect(result.code).toBe("OBSERVER_CAPACITY_REACHED");
    }

    expect(
      await database.observerPack.count({
        where: { missionId, status: { in: ["PENDING_PAYMENT", "PAID"] } },
      }),
    ).toBe(CAPACITY);
    // And exactly five payments were opened: nobody was charged for a seat the
    // cap was always going to refuse.
    expect(await database.payment.count()).toBe(CAPACITY);
  });

  it("does not put a bought seat back on sale when its buyer leaves", async () => {
    // The reason capacity is counted on packs and not on attached observers. A
    // seat that returned to sale the moment somebody disconnected would sell
    // their session out from under them while they reconnect.
    await openToObservers(1);
    const buyer = await createUser("buyer");
    const latecomer = await createUser("latecomer");

    const { paymentIntent } = await buy(buyer);
    await settlePayment({
      provider: "SANDBOX",
      outcome: captured(paymentIntent.paymentId),
      now: NOW,
    });

    expect((await takeObserverSeat({ missionId, userId: buyer, now: NOW })).ok).toBe(
      true,
    );
    await releaseObserverSeat({ missionId, userId: buyer, now: NOW });

    // Nobody is attached, and the seat is still not for sale.
    const refused = await purchaseObserverPack({
      missionId,
      userId: latecomer,
      now: NOW,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("OBSERVER_CAPACITY_REACHED");

    // And the buyer can come back to it.
    expect((await takeObserverSeat({ missionId, userId: buyer, now: NOW })).ok).toBe(
      true,
    );
  });

  it("puts a seat back on sale when its hold lapses", async () => {
    await openToObservers(1);
    const abandoner = await createUser("abandoner");
    const latecomer = await createUser("latecomer");

    await buy(abandoner);

    const blocked = await purchaseObserverPack({
      missionId,
      userId: latecomer,
      now: NOW,
    });
    expect(blocked.ok).toBe(false);

    const after = await purchaseObserverPack({
      missionId,
      userId: latecomer,
      now: AFTER_HOLD,
    });

    expect(after.ok).toBe(true);
    expect(
      await database.observerPack.findFirstOrThrow({ where: { userId: abandoner } }),
    ).toMatchObject({ status: "EXPIRED", holdExpiresAt: null });
  });
});

describe("settling the payment", () => {
  it("makes the seat the buyer's, and attaches nobody", async () => {
    await openToObservers();
    const buyer = await createUser("buyer");
    const { observerPack, paymentIntent } = await buy(buyer);

    const result = await settlePayment({
      provider: "SANDBOX",
      outcome: captured(paymentIntent.paymentId),
      now: NOW,
    });

    expect(result).toMatchObject({ ok: true, applied: true, missionId });

    const paid = await database.observerPack.findUniqueOrThrow({
      where: { id: observerPack.id },
    });
    expect(paid).toMatchObject({ status: "PAID", paidAt: NOW, holdExpiresAt: null });

    // Settlement does not put anybody in the session. The customer decides when
    // to attach, and DV-103 fans telemetry out to exactly that collection.
    expect(await database.missionParticipant.count({ where: { missionId } })).toBe(0);

    expect(await auditActions(observerPack.id)).toEqual([
      "OBSERVER_PACK_RESERVED",
      "OBSERVER_PACK_CAPTURED",
    ]);
  });

  it("lets the buyer attach once, and only then", async () => {
    await openToObservers();
    const buyer = await createUser("buyer");
    const { paymentIntent } = await buy(buyer);

    const before = await takeObserverSeat({ missionId, userId: buyer, now: NOW });
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.status).toBe(402);

    await settlePayment({
      provider: "SANDBOX",
      outcome: captured(paymentIntent.paymentId),
      now: NOW,
    });

    const after = await takeObserverSeat({ missionId, userId: buyer, now: NOW });
    expect(after.ok).toBe(true);
  });

  it("puts the seat back on sale when the payment fails", async () => {
    await openToObservers(1);
    const buyer = await createUser("buyer");
    const latecomer = await createUser("latecomer");
    const { observerPack, paymentIntent } = await buy(buyer);

    await settlePayment({
      provider: "SANDBOX",
      outcome: captured(paymentIntent.paymentId, {
        result: "FAILED",
        failureReason: "CARD_DECLINED",
      }),
      now: NOW,
    });

    expect(
      await database.observerPack.findUniqueOrThrow({ where: { id: observerPack.id } }),
    ).toMatchObject({ status: "CANCELLED", holdExpiresAt: null });

    // The seat is on sale again the moment that transaction commits.
    const next = await purchaseObserverPack({ missionId, userId: latecomer, now: NOW });
    expect(next.ok).toBe(true);

    expect(await auditActions(observerPack.id)).toEqual([
      "OBSERVER_PACK_RESERVED",
      "OBSERVER_PACK_PAYMENT_FAILED",
    ]);
  });

  it("is a no-op when the provider sends the same callback twice", async () => {
    await openToObservers();
    const buyer = await createUser("buyer");
    const { observerPack, paymentIntent } = await buy(buyer);
    const outcome = captured(paymentIntent.paymentId);

    const first = await settlePayment({ provider: "SANDBOX", outcome, now: NOW });
    const second = await settlePayment({ provider: "SANDBOX", outcome, now: NOW });

    expect(first).toMatchObject({ ok: true, applied: true });
    expect(second).toMatchObject({ ok: true, applied: false, missionId });
    expect(await auditActions(observerPack.id)).toEqual([
      "OBSERVER_PACK_RESERVED",
      "OBSERVER_PACK_CAPTURED",
    ]);
  });

  it("refuses a callback reporting a different sum from the intent", async () => {
    await openToObservers();
    const buyer = await createUser("buyer");
    const { observerPack, paymentIntent } = await buy(buyer);

    const result = await settlePayment({
      provider: "SANDBOX",
      outcome: captured(paymentIntent.paymentId, { amountMinor: 1 }),
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(
      await database.observerPack.findUniqueOrThrow({ where: { id: observerPack.id } }),
    ).toMatchObject({ status: "PENDING_PAYMENT" });
  });
});

describe("money that arrives after the hold lapsed", () => {
  it("is honoured while the session still has room", async () => {
    await openToObservers();
    const buyer = await createUser("buyer");
    const { observerPack, paymentIntent } = await buy(buyer);

    // Somebody else's purchase sweeps the lapsed hold to EXPIRED, then the bank
    // finally answers. Nobody took the seat, so being late cost nothing.
    await buy(await createUser("other"), AFTER_HOLD);
    expect(
      await database.observerPack.findUniqueOrThrow({ where: { id: observerPack.id } }),
    ).toMatchObject({ status: "EXPIRED" });

    const result = await settlePayment({
      provider: "SANDBOX",
      outcome: captured(paymentIntent.paymentId),
      now: AFTER_HOLD,
    });

    expect(result).toMatchObject({ ok: true, applied: true, missionId });
    expect(
      await database.observerPack.findUniqueOrThrow({ where: { id: observerPack.id } }),
    ).toMatchObject({ status: "PAID" });
  });

  it("is recorded without a seat when the session filled up, for DV-111", async () => {
    await openToObservers(1);
    const buyer = await createUser("buyer");
    const { observerPack, paymentIntent } = await buy(buyer);

    // The one seat goes to somebody else after the hold lapses.
    await buy(await createUser("other"), AFTER_HOLD);

    const result = await settlePayment({
      provider: "SANDBOX",
      outcome: captured(paymentIntent.paymentId),
      now: AFTER_HOLD,
    });

    expect(result).toMatchObject({ ok: true, applied: true });

    // The money moved, so the record says so. Nothing here refunds it.
    expect(
      await database.payment.findUniqueOrThrow({ where: { id: paymentIntent.paymentId } }),
    ).toMatchObject({ status: "CAPTURED" });
    expect(
      await database.observerPack.findUniqueOrThrow({ where: { id: observerPack.id } }),
    ).toMatchObject({ status: "EXPIRED" });

    expect(await auditActions(observerPack.id)).toEqual([
      "OBSERVER_PACK_RESERVED",
      "OBSERVER_PACK_CAPTURED_WITHOUT_SEAT",
    ]);

    // And the seat that was sold is still the other buyer's.
    const seated = await takeObserverSeat({ missionId, userId: buyer, now: AFTER_HOLD });
    expect(seated.ok).toBe(false);
    if (!seated.ok) expect(seated.status).toBe(402);
  });
});
