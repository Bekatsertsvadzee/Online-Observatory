import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

const { getMissionWatchView } = await import("@/features/missions/watch");
const { zMissionWatchView } = await import("@darkview/contracts/zod");

/**
 * #150: the watch view against a real PostgreSQL instance, one test per access
 * case (ADR-034). Every refusal is a null -- the same null as for a mission that
 * does not exist -- so the route can answer each with one indistinguishable 404.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const NOW = new Date("2026-07-15T20:00:00.000Z");

let database: PrismaClient;
let observatoryId: string;
let missionId: string;
let ownerId: string;
let strangerId: string;

async function createUser(label: string): Promise<string> {
  const user = await database.user.create({
    data: { email: `${label}-${randomUUID()}@example.test`, name: label, emailVerifiedAt: NOW },
  });
  return user.id;
}

async function seat(userId: string, status: "JOINED" | "LEFT" = "JOINED") {
  return database.missionParticipant.create({
    data: {
      missionId,
      userId,
      status,
      joinedAt: NOW,
      leftAt: status === "LEFT" ? NOW : null,
    },
  });
}

/** A pack for this mission, paid or still held, with the payment it needs. */
async function pack(
  userId: string,
  options: {
    status: "PAID" | "PENDING_PAYMENT";
    refundedMinor?: number;
    refundOwedMinor?: number;
  },
) {
  const paid = options.status === "PAID";
  const payment = await database.payment.create({
    data: {
      userId,
      purpose: "OBSERVER_PACK",
      provider: "SANDBOX",
      status: paid ? "CAPTURED" : "PENDING",
      amountMinor: 1000,
      capturedAt: paid ? NOW : null,
    },
  });
  return database.observerPack.create({
    data: {
      missionId,
      userId,
      paymentId: payment.id,
      status: options.status,
      priceMinor: 1000,
      paidAt: paid ? NOW : null,
      holdExpiresAt: paid ? null : new Date(NOW.getTime() + 5 * 60_000),
      refundedMinor: options.refundedMinor ?? null,
      refundedAt: options.refundedMinor === undefined ? null : NOW,
      refundOwedMinor: options.refundOwedMinor ?? null,
    },
  });
}

async function setMission(data: { joinPolicy?: "OPEN" | "DISABLED"; state?: "OBSERVING" | "COMPLETE" }) {
  await database.mission.update({ where: { id: missionId }, data });
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING }),
  });
  testDatabase.current = database;
  await database.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(async () => {
  // The same order the other mission suites use: these suites share one database,
  // and a Restrict foreign key left behind blocks every later cleanup.
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

  ownerId = await createUser("Controller");
  strangerId = await createUser("Stranger");

  const mission = await database.mission.create({
    data: {
      userId: ownerId,
      targetId: target.id,
      observatoryId,
      telescopeId: telescope.id,
      state: "OBSERVING",
      startedAt: NOW,
    },
  });
  missionId = mission.id;
});

describe("the owner", () => {
  it("reads their private session, and it matches the contract", async () => {
    const view = await getMissionWatchView({ missionId, actorId: ownerId });

    expect(view).not.toBeNull();
    expect(zMissionWatchView.parse(view)).toEqual(view);
    expect(view?.mission.id).toBe(missionId);
    expect(view?.mission.observable).toBe(false);
    expect(view?.target.nameEn).toBe("M13");
    expect(view?.observatory).toMatchObject({
      id: observatoryId,
      kind: "FIRST_PARTY",
      telescope: { manufacturer: "Celestron", apertureMm: 150 },
    });
    expect(view?.ownerDisplayName).toBe("Controller");
    expect(view?.myObserverSeat).toBeNull();
    expect(view?.myObserverPack).toBeNull();
  });

  it("reads their session after it has ended", async () => {
    await setMission({ state: "COMPLETE" });
    expect(await getMissionWatchView({ missionId, actorId: ownerId })).not.toBeNull();
  });
});

describe("a seated observer", () => {
  it("reads the session, with their own seat and the seat count", async () => {
    await setMission({ joinPolicy: "OPEN" });
    const observerId = await createUser("Observer");
    const mine = await seat(observerId);
    await seat(await createUser("Another"));

    const view = await getMissionWatchView({ missionId, actorId: observerId });

    expect(zMissionWatchView.parse(view)).toEqual(view);
    expect(view?.myObserverSeat).toMatchObject({ id: mine.id, userId: observerId, leftAt: null });
    expect(view?.observerCount).toBe(2);
    expect(view?.mission.observerCount).toBe(2);
  });

  it("keeps reading once the mission has ended", async () => {
    const observerId = await createUser("Observer");
    await seat(observerId);
    await setMission({ state: "COMPLETE" });

    expect(await getMissionWatchView({ missionId, actorId: observerId })).not.toBeNull();
  });

  it("carries no captures and nothing to save (ADR-007)", async () => {
    const observerId = await createUser("Observer");
    await seat(observerId);
    const view = await getMissionWatchView({ missionId, actorId: observerId });

    // myObserverPack (ADR-045) is the caller's purchase: a price and a refund, no capture.
    expect(Object.keys(view ?? {}).sort()).toEqual([
      "mission",
      "myObserverPack",
      "myObserverSeat",
      "observatory",
      "observerCount",
      "ownerDisplayName",
      "target",
    ]);
  });
});

describe("any other signed-in user", () => {
  it("reads a live session the owner opened, holding no seat", async () => {
    await setMission({ joinPolicy: "OPEN" });

    const view = await getMissionWatchView({ missionId, actorId: strangerId });

    expect(zMissionWatchView.parse(view)).toEqual(view);
    expect(view?.mission.observable).toBe(true);
    expect(view?.myObserverSeat).toBeNull();
    expect(view?.observerCount).toBe(0);
  });

  it("gets nothing for a private session", async () => {
    expect(await getMissionWatchView({ missionId, actorId: strangerId })).toBeNull();
  });

  it("gets nothing for a private session even with the legacy PUBLIC sharingMode", async () => {
    await database.mission.update({ where: { id: missionId }, data: { sharingMode: "PUBLIC" } });
    expect(await getMissionWatchView({ missionId, actorId: strangerId })).toBeNull();
  });

  it("gets nothing for an opened session that is no longer live", async () => {
    await setMission({ joinPolicy: "OPEN", state: "COMPLETE" });
    expect(await getMissionWatchView({ missionId, actorId: strangerId })).toBeNull();
  });

  it("gets nothing for a private session they left", async () => {
    await seat(strangerId, "LEFT");
    expect(await getMissionWatchView({ missionId, actorId: strangerId })).toBeNull();
  });

  it("gets the same nothing as for a mission that does not exist", async () => {
    expect(await getMissionWatchView({ missionId: randomUUID(), actorId: strangerId })).toBeNull();
  });
});

/**
 * ADR-045 (#169): a buyer who paid for a seat keeps reading the session after the
 * owner closes it or it ends, so the watch page can say what they paid and what the
 * close gave back.
 */
describe("a buyer with a paid seat", () => {
  it("reads a closed session after their seat was ended, with the refund issued", async () => {
    await setMission({ joinPolicy: "DISABLED" });
    const buyerId = await createUser("Buyer");
    const bought = await pack(buyerId, { status: "PAID", refundedMinor: 400 });
    await seat(buyerId, "LEFT");

    const view = await getMissionWatchView({ missionId, actorId: buyerId });

    expect(zMissionWatchView.parse(view)).toEqual(view);
    expect(view?.myObserverSeat).toBeNull();
    expect(view?.myObserverPack).toMatchObject({
      id: bought.id,
      status: "PAID",
      priceMinor: 1000,
      refundedMinor: 400,
      refundOwedMinor: null,
    });
  });

  it("says a refund the provider cannot yet issue is owed, never refunded", async () => {
    const buyerId = await createUser("Buyer");
    await pack(buyerId, { status: "PAID", refundOwedMinor: 400 });

    const view = await getMissionWatchView({ missionId, actorId: buyerId });

    expect(view?.myObserverPack).toMatchObject({
      refundedMinor: null,
      refundOwedMinor: 400,
    });
  });

  it("keeps reading once the session has ended", async () => {
    const buyerId = await createUser("Buyer");
    await pack(buyerId, { status: "PAID" });
    await setMission({ state: "COMPLETE" });

    expect(await getMissionWatchView({ missionId, actorId: buyerId })).not.toBeNull();
  });

  it("is a seat holder's own pack, shown to the observer watching", async () => {
    await setMission({ joinPolicy: "OPEN" });
    const buyerId = await createUser("Buyer");
    const bought = await pack(buyerId, { status: "PAID" });
    await seat(buyerId);

    const view = await getMissionWatchView({ missionId, actorId: buyerId });

    expect(view?.myObserverPack?.id).toBe(bought.id);
  });
});

describe("a buyer whose seat is not paid for", () => {
  it("gets nothing for a private session: a hold grants no read", async () => {
    const holderId = await createUser("Holder");
    await pack(holderId, { status: "PENDING_PAYMENT" });

    expect(await getMissionWatchView({ missionId, actorId: holderId })).toBeNull();
  });

  it("sees their own held pack on a live session the owner opened", async () => {
    await setMission({ joinPolicy: "OPEN" });
    const holderId = await createUser("Holder");
    await pack(holderId, { status: "PENDING_PAYMENT" });

    const view = await getMissionWatchView({ missionId, actorId: holderId });

    expect(zMissionWatchView.parse(view)).toEqual(view);
    expect(view?.myObserverPack).toMatchObject({
      status: "PENDING_PAYMENT",
      refundedMinor: null,
    });
  });
});
