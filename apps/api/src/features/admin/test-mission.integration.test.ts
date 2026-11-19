import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase, environment } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
  environment: {
    NODE_ENV: "test",
    DARKVIEW_DEPLOYMENT: "demo" as "production" | "demo",
    DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID: undefined as string | undefined,
  },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));
vi.mock("@/lib/validation/env", () => ({ getServerEnvironment: () => environment }));

const { scheduleTestMission } = await import("@/features/admin/test-mission");
const { startMissionSession } = await import("@/features/missions/session");
const { zTestMission } = await import("@darkview/contracts/zod");

/**
 * ADR-075 and ADR-082 against a real PostgreSQL instance: an operator's own free
 * session on the hardware test observatory or a first-party one.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const NOW = new Date("2026-07-15T20:00:42.500Z");

let database: PrismaClient;
let operatorId: string;
let targetId: string;

async function firstParty(row: { id: string }) {
  await database.observatoryNetworkNode.create({
    data: {
      ownerId: operatorId,
      observatoryId: row.id,
      kind: "FIRST_PARTY",
      approvalStatus: "APPROVED",
    },
  });
  return row;
}

async function observatory(slug: string, compatible = true) {
  const row = await database.observatory.create({
    data: {
      slug: `${slug}-${randomUUID()}`,
      nameEn: slug,
      nameKa: slug,
      city: "Tbilisi",
      countryCode: "GE",
      latitude: 41.7151,
      longitude: 44.8271,
      timezone: "Asia/Tbilisi",
      telescopes: {
        create: {
          name: "Main",
          manufacturer: "-",
          model: "8SE",
          apertureMm: 203,
          focalLengthMm: 2032,
        },
      },
    },
  });
  if (compatible) {
    await database.targetObservatory.create({
      data: { targetId, observatoryId: row.id },
    });
  }
  return row;
}

const schedule = (observatoryId: string, durationMinutes = 30, now = NOW) =>
  scheduleTestMission({
    observatoryId,
    actorUserId: operatorId,
    request: { targetId, durationMinutes },
    now,
  });

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING }),
  });
  testDatabase.current = database;
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(async () => {
  environment.DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID = undefined;
  // CASCADE: other files leave captures, bookings and missions behind, and a
  // deleteMany chain here would have to know every one of them.
  await database.$executeRawUnsafe(
    'TRUNCATE "AuditLog", "Observatory", "User", "Target" CASCADE',
  );

  const operator = await database.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      name: "Operator",
      role: "OPERATOR",
      emailVerifiedAt: NOW,
    },
  });
  operatorId = operator.id;

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

describe("an operator's test mission (ADR-075)", () => {
  it("writes a free confirmed booking from this minute and its scheduled mission", async () => {
    const test = await observatory("hardware-test");
    environment.DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID = test.id;

    const result = await schedule(test.id, 45);
    if (!result.ok) throw new Error(result.message);
    const body = zTestMission.parse(result.testMission);

    expect(body).toMatchObject({
      observatoryId: test.id,
      targetId,
      durationMinutes: 45,
      slotStartAt: "2026-07-15T20:00:00.000Z",
      mode: "SIMULATED",
    });
    const booking = await database.booking.findUniqueOrThrow({
      where: { id: body.bookingId },
    });
    expect(booking).toMatchObject({
      userId: operatorId,
      status: "CONFIRMED",
      priceMinor: 0,
      paymentId: null,
      missionId: body.missionId,
    });
    const mission = await database.mission.findUniqueOrThrow({
      where: { id: body.missionId },
    });
    expect(mission).toMatchObject({
      userId: operatorId,
      state: "SCHEDULED",
      mode: "SIMULATED",
    });
    const audit = await database.auditLog.findMany({
      where: { entityId: body.missionId },
    });
    expect(audit.map((row) => row.action)).toEqual(["MISSION_SCHEDULED"]);
  });

  it("refuses an observatory Stellar does not run", async () => {
    const partner = await observatory("partner");
    await database.observatoryNetworkNode.create({
      data: {
        ownerId: operatorId,
        observatoryId: partner.id,
        kind: "PARTNER",
        approvalStatus: "APPROVED",
      },
    });
    const unlisted = await observatory("unlisted");

    await expect(schedule(partner.id)).resolves.toMatchObject({ ok: false, status: 403 });
    await expect(schedule(unlisted.id)).resolves.toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await database.booking.count()).toBe(0);
  });

  it("gives an operator free time on a first-party observatory customers book", async () => {
    const demo = await firstParty(await observatory("demo"));

    const result = await schedule(demo.id, 60);
    if (!result.ok) throw new Error(result.message);
    const booking = await database.booking.findUniqueOrThrow({
      where: { id: result.testMission.bookingId },
    });
    expect(booking).toMatchObject({
      userId: operatorId,
      priceMinor: 0,
      status: "CONFIRMED",
    });
  });

  it("never takes a customer's booked time", async () => {
    const demo = await firstParty(await observatory("demo"));
    const customer = await database.user.create({
      data: {
        email: `${randomUUID()}@example.test`,
        name: "Customer",
        emailVerifiedAt: NOW,
      },
    });
    const telescope = await database.telescope.findFirstOrThrow({
      where: { observatoryId: demo.id },
    });
    await database.booking.create({
      data: {
        userId: customer.id,
        targetId,
        observatoryId: demo.id,
        telescopeId: telescope.id,
        slotStartAt: new Date("2026-07-15T20:15:00.000Z"),
        durationMinutes: 30,
        status: "CONFIRMED",
        priceMinor: 2000,
      },
    });

    await expect(schedule(demo.id, 30)).resolves.toMatchObject({
      ok: false,
      status: 409,
      code: "SLOT_UNAVAILABLE",
    });
    expect(await database.booking.count()).toBe(1);
  });

  it("chooses the brightest target that is up when none is named", async () => {
    const demo = await firstParty(await observatory("demo"));
    // Tbilisi at 20:00 UTC on 15 July: M13 is high, brighter Canopus never rises.
    const low = await database.target.create({
      data: {
        slug: `canopus-${randomUUID()}`,
        nameEn: "Canopus",
        nameKa: "Canopus",
        type: "DOUBLE_STAR",
        positionSource: "FIXED",
        rightAscensionHours: 6.3992,
        declinationDegrees: -52.6957,
        angularSizeArcmin: 1,
        magnitude: -0.7,
        opticalConfig: "F10_NATIVE",
        imagingProfile: "GLOBULAR_CLUSTER",
        minAltitudeDegrees: 25,
        expectedMissionMinutes: 30,
      },
    });
    await database.targetObservatory.create({
      data: { targetId: low.id, observatoryId: demo.id },
    });

    const result = await scheduleTestMission({
      observatoryId: demo.id,
      actorUserId: operatorId,
      request: { durationMinutes: 30 },
      now: NOW,
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.testMission.targetId).toBe(targetId);
  });

  it("answers 409 when nothing the observatory can observe is up", async () => {
    const demo = await firstParty(await observatory("demo"));
    // 07:00 in Tbilisi: M13 has set.
    const morning = new Date("2026-07-15T03:00:00.000Z");

    await expect(
      scheduleTestMission({
        observatoryId: demo.id,
        actorUserId: operatorId,
        request: { durationMinutes: 30 },
        now: morning,
      }),
    ).resolves.toMatchObject({ ok: false, status: 409, code: "SAFETY_REFUSED" });
    expect(await database.booking.count()).toBe(0);
  });

  it("hands back the operator's own session that is already live", async () => {
    const demo = await firstParty(await observatory("demo"));

    const first = await schedule(demo.id, 60);
    if (!first.ok) throw new Error(first.message);
    await database.mission.update({
      where: { id: first.testMission.missionId },
      data: { state: "OBSERVING" },
    });
    const later = new Date(NOW.getTime() + 20 * 60_000);

    await expect(schedule(demo.id, 30, later)).resolves.toEqual(first);
    expect(await database.booking.count()).toBe(1);
    expect(await database.mission.count()).toBe(1);
  });

  it("refuses a target the observatory cannot observe", async () => {
    const test = await observatory("hardware-test", false);
    environment.DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID = test.id;

    await expect(schedule(test.id)).resolves.toMatchObject({ ok: false, status: 422 });
  });

  it("replaces the operator's own test mission that never started", async () => {
    const test = await observatory("hardware-test");
    environment.DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID = test.id;

    const first = await schedule(test.id, 60);
    if (!first.ok) throw new Error(first.message);
    const later = new Date(NOW.getTime() + 20 * 60_000);
    const second = await schedule(test.id, 30, later);
    if (!second.ok) throw new Error(second.message);

    const old = await database.booking.findUniqueOrThrow({
      where: { id: first.testMission.bookingId },
      include: { mission: true },
    });
    expect(old.status).toBe("CANCELLED");
    expect(old.mission).toMatchObject({
      state: "CANCELLED",
      failureReason: "OPERATOR_ABORT",
    });
    const kept = await database.booking.findUniqueOrThrow({
      where: { id: second.testMission.bookingId },
    });
    expect(kept.status).toBe("CONFIRMED");
  });

  it("never replaces another operator's test mission", async () => {
    const test = await observatory("hardware-test");
    environment.DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID = test.id;

    await expect(schedule(test.id, 60)).resolves.toMatchObject({ ok: true });
    const other = await database.user.create({
      data: {
        email: `${randomUUID()}@example.test`,
        name: "Second operator",
        role: "OPERATOR",
        emailVerifiedAt: NOW,
      },
    });
    const later = new Date(NOW.getTime() + 20 * 60_000);
    await expect(
      scheduleTestMission({
        observatoryId: test.id,
        actorUserId: other.id,
        request: { targetId, durationMinutes: 30 },
        now: later,
      }),
    ).resolves.toMatchObject({ ok: false, status: 409 });
    expect(await database.booking.count()).toBe(1);
  });

  it("is started by the customer's start, which reaches the safety envelope", async () => {
    const test = await observatory("hardware-test");
    await database.observatory.update({
      where: { id: test.id },
      data: { status: "ONLINE" },
    });
    environment.DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID = test.id;

    const result = await schedule(test.id);
    if (!result.ok) throw new Error(result.message);

    // Not NOT_FOUND, not SESSION_NOT_OWNER, not "no booking": the next refusal is the
    // unmeasured altitude limit, as on the real observatory before RUNBOOK §5.
    await expect(
      startMissionSession({
        missionId: result.testMission.missionId,
        actor: { id: operatorId, role: "OPERATOR" },
        now: new Date(NOW.getTime() + 60_000),
      }),
    ).resolves.toMatchObject({ ok: false, code: "SAFETY_NOT_CONFIGURED" });
  });
});
