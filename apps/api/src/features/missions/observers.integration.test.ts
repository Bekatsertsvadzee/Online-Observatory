import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

const {
  MAX_OBSERVER_CAPACITY,
  detachAllObservers,
  listMissionObservers,
  releaseObserverSeat,
  setMissionObservation,
  takeObserverSeat,
} = await import("@/features/missions/observers");
const { zMission, zMissionObserver, zMissionObserverList } =
  await import("@darkview/contracts/zod");

/**
 * DV-100 against a real PostgreSQL instance.
 *
 * The claim worth testing is the cap. ADR-007 says "maximum five observers per
 * session ... a hard cap, enforced server-side", and a cap that is a count
 * followed by an insert is not enforced at all: two requests arriving together
 * both see four seats taken and both take the fifth. So the interesting test here
 * is the concurrent one, and it needs a real database for the same reason
 * DV-055's and DV-058's do.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const NOW = new Date("2026-07-15T20:00:00.000Z");

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

async function openToObservers(capacity = MAX_OBSERVER_CAPACITY) {
  await database.mission.update({
    where: { id: missionId },
    data: { joinPolicy: "OPEN", observerCapacity: capacity },
  });
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING, max: 32 }),
  });
  testDatabase.current = database;
  await database.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(async () => {
  // Order matters: ObservatoryCommand carries a foreign key to MissionSession, so
  // the commands go before the sessions or the delete is refused.
  // Captures first. Capture holds Restrict foreign keys to Mission, Target,
  // Telescope, Observatory and User, so a capture left behind by another suite
  // blocks every delete below it -- and these suites share one database.
  // ObservatoryNetworkNode holds Restrict foreign keys to Observatory and User
  // (ADR-013), so a node left behind blocks every later suite's cleanup.
  await database.networkAvailabilityWindow.deleteMany();
  await database.observatoryNetworkNode.deleteMany();
  await database.capture.deleteMany();
  await database.auditLog.deleteMany();
  await database.missionParticipant.deleteMany();
  await database.missionEvent.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
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

describe("the cap ADR-007 fixed at five", () => {
  it("is the database's rule, not a number the application promises", async () => {
    await expect(
      database.mission.update({
        where: { id: missionId },
        data: { observerCapacity: MAX_OBSERVER_CAPACITY + 1 },
      }),
    ).rejects.toThrow();
  });

  it("holds when five people join at once", async () => {
    await openToObservers();

    // Ten at once for five seats. Counting and then inserting would let more than
    // five through here, which is the whole reason the seat is taken under a lock
    // on the mission row.
    const contenders = await Promise.all(
      Array.from({ length: 10 }, (_, index) => createUser(`observer-${index}`)),
    );

    const results = await Promise.all(
      contenders.map((userId) => takeObserverSeat({ missionId, userId, now: NOW })),
    );

    const taken = results.filter((result) => result.ok);
    const refused = results.filter((result) => !result.ok);

    expect(taken).toHaveLength(MAX_OBSERVER_CAPACITY);
    expect(refused).toHaveLength(5);
    for (const result of refused) {
      if (result.ok) continue;
      expect(result.code).toBe("OBSERVER_CAPACITY_REACHED");
    }

    const seated = await database.missionParticipant.count({
      where: { missionId, status: "JOINED" },
    });
    expect(seated).toBe(MAX_OBSERVER_CAPACITY);
  });

  it("frees a seat when somebody leaves", async () => {
    await openToObservers(1);

    const first = await createUser("first");
    const second = await createUser("second");

    expect((await takeObserverSeat({ missionId, userId: first, now: NOW })).ok).toBe(
      true,
    );

    const refused = await takeObserverSeat({ missionId, userId: second, now: NOW });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("OBSERVER_CAPACITY_REACHED");

    await releaseObserverSeat({ missionId, userId: first, now: NOW });

    expect((await takeObserverSeat({ missionId, userId: second, now: NOW })).ok).toBe(
      true,
    );
  });

  it("lets an operator close a mission to observers with a capacity of zero", async () => {
    await openToObservers(0);
    const hopeful = await createUser("hopeful");

    const result = await takeObserverSeat({ missionId, userId: hopeful, now: NOW });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("OBSERVER_CAPACITY_REACHED");
  });
});

describe("who may take a seat", () => {
  it("refuses while the controller has not opted in", async () => {
    // ADR-007 rule 5, and the shipped default: sessions are private.
    const hopeful = await createUser("hopeful");

    const result = await takeObserverSeat({ missionId, userId: hopeful, now: NOW });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.code).toBe("MISSION_NOT_OBSERVABLE");
    }
  });

  it("refuses the controller a seat on their own session", async () => {
    await openToObservers();

    const result = await takeObserverSeat({
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
    const hopeful = await createUser("hopeful");

    const result = await takeObserverSeat({ missionId, userId: hopeful, now: NOW });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MISSION_NOT_ACTIVE");
  });

  it("gives a rejoining observer the same seat rather than a second", async () => {
    await openToObservers();
    const observer = await createUser("observer");

    const first = await takeObserverSeat({ missionId, userId: observer, now: NOW });
    const again = await takeObserverSeat({ missionId, userId: observer, now: NOW });

    expect(first.ok && again.ok).toBe(true);
    if (first.ok && again.ok) expect(again.value.id).toBe(first.value.id);
    expect(
      await database.missionParticipant.count({ where: { missionId, status: "JOINED" } }),
    ).toBe(1);
  });
});

describe("a seat that has been given back", () => {
  it("can be taken again by the same person", async () => {
    await openToObservers();
    const observer = await createUser("observer");

    await takeObserverSeat({ missionId, userId: observer, now: NOW });
    await releaseObserverSeat({ missionId, userId: observer, now: NOW });
    const again = await takeObserverSeat({ missionId, userId: observer, now: NOW });

    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.leftAt).toBeNull();
  });

  it("is not an error to give back twice", async () => {
    await openToObservers();
    const observer = await createUser("observer");
    await takeObserverSeat({ missionId, userId: observer, now: NOW });

    expect((await releaseObserverSeat({ missionId, userId: observer, now: NOW })).ok)
      .toBe(true);
    expect((await releaseObserverSeat({ missionId, userId: observer, now: NOW })).ok)
      .toBe(true);
  });
});

describe("closing a session", () => {
  it("detaches everyone watching, because consent withdrawn stops the watching", async () => {
    await openToObservers();
    for (let index = 0; index < 3; index += 1) {
      await takeObserverSeat({
        missionId,
        userId: await createUser(`observer-${index}`),
        now: NOW,
      });
    }

    const detached = await detachAllObservers({ missionId, now: NOW });

    expect(detached).toBe(3);
    expect(
      await database.missionParticipant.count({ where: { missionId, status: "JOINED" } }),
    ).toBe(0);
  });
});

describe("who may see the list", () => {
  it("shows the controller everyone watching", async () => {
    await openToObservers();
    const observer = await createUser("observer");
    await takeObserverSeat({ missionId, userId: observer, now: NOW });

    const result = await listMissionObservers({
      missionId,
      actor: { id: controllerId, role: "USER" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(1);
    expect(result.value.capacity).toBe(MAX_OBSERVER_CAPACITY);
    expect(() => zMissionObserverList.parse(result.value)).not.toThrow();
    expect(() => zMissionObserver.parse(result.value.items[0])).not.toThrow();
  });

  it("shows an observer the count and not who else is there", async () => {
    await openToObservers();
    const mine = await createUser("mine");
    const other = await createUser("other");
    await takeObserverSeat({ missionId, userId: mine, now: NOW });
    await takeObserverSeat({ missionId, userId: other, now: NOW });

    const result = await listMissionObservers({
      missionId,
      actor: { id: mine, role: "USER" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The contract: "Observers see only the count." Who else is watching is not
    // theirs to know, and the capacity tells them what they are entitled to.
    expect(result.value.items).toEqual([]);
    expect(result.value.capacity).toBe(MAX_OBSERVER_CAPACITY);
  });

  it("tells a stranger nothing, with the same 404 as a mission that does not exist", async () => {
    const stranger = await createUser("stranger");

    const result = await listMissionObservers({
      missionId,
      actor: { id: stranger, role: "USER" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("shows an operator any mission's observers", async () => {
    await openToObservers();
    const operator = await createUser("operator");

    const result = await listMissionObservers({
      missionId,
      actor: { id: operator, role: "OPERATOR" },
    });

    expect(result.ok).toBe(true);
  });
});

describe("the controller's consent (DV-101)", () => {
  it("is what makes a session observable, and it starts closed", async () => {
    const hopeful = await createUser("hopeful");

    // Shipped state: private. ADR-007 rule 5.
    const before = await takeObserverSeat({ missionId, userId: hopeful, now: NOW });
    expect(before.ok).toBe(false);

    const opened = await setMissionObservation({
      missionId,
      actor: { id: controllerId, role: "USER" },
      observable: true,
      now: NOW,
    });
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.value.observable).toBe(true);
      // A demo mission nobody bought. The contract's bookingId is nullable for
      // exactly this, and inventing one would be a fiction in the payment tables.
      expect(opened.value.bookingId).toBeNull();
      expect(() => zMission.parse(opened.value)).not.toThrow();
    }

    const after = await takeObserverSeat({ missionId, userId: hopeful, now: NOW });
    expect(after.ok).toBe(true);
  });

  it("detaches everyone watching when the controller closes it", async () => {
    await openToObservers();
    for (let index = 0; index < 3; index += 1) {
      await takeObserverSeat({
        missionId,
        userId: await createUser(`observer-${index}`),
        now: NOW,
      });
    }

    const closed = await setMissionObservation({
      missionId,
      actor: { id: controllerId, role: "USER" },
      observable: false,
      now: NOW,
    });

    expect(closed.ok).toBe(true);
    if (closed.ok) {
      expect(closed.value.observable).toBe(false);
      expect(closed.value.observerCount).toBe(0);
    }

    // Consent withdrawn stops the watching now, not for the next person to ask.
    expect(
      await database.missionParticipant.count({ where: { missionId, status: "JOINED" } }),
    ).toBe(0);
  });

  it("refuses an operator opening somebody else's session", async () => {
    const operator = await createUser("operator");

    const result = await setMissionObservation({
      missionId,
      actor: { id: operator, role: "OPERATOR" },
      observable: true,
      now: NOW,
    });

    // Nobody is watched without agreeing, and an operator is not the person whose
    // agreement this is. Deliberately not the usual operator escape hatch.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("refuses a mission that is not live", async () => {
    await database.mission.update({
      where: { id: missionId },
      data: { state: "COMPLETE" },
    });

    const result = await setMissionObservation({
      missionId,
      actor: { id: controllerId, role: "USER" },
      observable: true,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MISSION_NOT_ACTIVE");
  });

  it("writes the consent to the audit trail", async () => {
    await setMissionObservation({
      missionId,
      actor: { id: controllerId, role: "USER" },
      observable: true,
      now: NOW,
    });

    const rows = await database.auditLog.findMany({
      where: { missionId, category: "MISSION" },
      orderBy: { createdAt: "desc" },
    });
    expect(rows[0]?.action).toBe("MISSION_OPENED_TO_OBSERVERS");
  });
});
