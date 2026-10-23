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
  // APP_URL: a seat's sandbox payment carries a checkout redirect built from it (#170).
  getServerEnvironment: () => ({
    NODE_ENV: process.env.NODE_ENV ?? "test",
    APP_URL: "https://darkview.test",
  }),
}));

const { readTonight, setMissionBroadcast, SPECTATOR_CAPACITY } =
  await import("@/features/missions/broadcast");
const { zTonight, zMission } = await import("@darkview/contracts/zod");

/**
 * Clients ADR-066 against a real PostgreSQL: the owner opens a session to Tonight,
 * live, and GET /tonight names the target and never a person.
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

/**
 * Give somebody the paid seat DV-102 now requires before they may attach.
 *
 * DV-100 could take a seat with nothing behind it, because Observer Pack payment
 * did not exist and the route refused rather than hand out free ones. It exists
 * now, and `takeObserverSeat` reads it: every test below that expects to attach
 * has to buy first, which is the point.
 */

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
      name: "NexStar 8SE",
      manufacturer: "Celestron",
      model: "NexStar 8SE",
      apertureMm: 203,
      focalLengthMm: 2032,
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

describe("Tonight, live (clients ADR-066)", () => {
  it("is empty until an owner opens a live session", async () => {
    expect(zTonight.parse(await readTonight())).toEqual({ live: null });
  });

  it("lets only the owner open it, and names the session without the person", async () => {
    const stranger = await createUser("stranger");
    expect(
      await setMissionBroadcast({ missionId, userId: stranger, broadcast: true }),
    ).toMatchObject({
      ok: false,
      status: 404,
    });

    const opened = await setMissionBroadcast({
      missionId,
      userId: controllerId,
      broadcast: true,
    });
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(zMission.parse(opened.value).broadcast).toBe(true);

    const tonight = zTonight.parse(await readTonight());
    expect(tonight.live).toMatchObject({
      missionId,
      observatoryId,
      target: { nameEn: "M13", type: "GLOBULAR_CLUSTER" },
      state: "OBSERVING",
      spectatorCapacity: SPECTATOR_CAPACITY,
      streamPath: `/stream/mission/${missionId}/spectate`,
      endsAt: null,
    });
    expect(JSON.stringify(tonight)).not.toContain(controllerId);

    const audit = await database.auditLog.findMany({ where: { missionId } });
    expect(audit.map((row) => row.action)).toEqual(["MISSION_OPENED_TO_TONIGHT"]);
  });

  it("is idempotent, and closing ends it", async () => {
    await setMissionBroadcast({ missionId, userId: controllerId, broadcast: true });
    await setMissionBroadcast({ missionId, userId: controllerId, broadcast: true });
    expect(await database.auditLog.count({ where: { missionId } })).toBe(1);

    await setMissionBroadcast({ missionId, userId: controllerId, broadcast: false });
    expect(await readTonight()).toEqual({ live: null });
  });

  it("cannot be opened once the mission has ended, but can always be closed", async () => {
    await setMissionBroadcast({ missionId, userId: controllerId, broadcast: true });
    await database.mission.update({
      where: { id: missionId },
      data: { state: "COMPLETE" },
    });

    expect(await readTonight()).toEqual({ live: null });
    expect(
      await setMissionBroadcast({ missionId, userId: controllerId, broadcast: true }),
    ).toMatchObject({ ok: false, status: 409, code: "MISSION_NOT_ACTIVE" });
    expect(
      (await setMissionBroadcast({ missionId, userId: controllerId, broadcast: false }))
        .ok,
    ).toBe(true);
  });
});
