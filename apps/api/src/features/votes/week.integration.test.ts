import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { zWeekVote } from "@darkview/contracts/zod";
import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

const { castVote, readWeekVote } = await import("@/features/votes/week");

/**
 * ADR-050 -- the week's vote, against a real PostgreSQL instance: the candidates are
 * judged from the observatory's own site and envelope, the counts are one per
 * customer, and a second vote moves the first rather than adding to it.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

/** A Thursday in mid-December, 20:00 UTC: midnight in Tbilisi, the week of Monday the 14th. */
const NOW = new Date("2026-12-17T20:00:00.000Z");
const WEEK = "2026-12-14";

const TBILISI = { latitude: 41.7151, longitude: 44.8271, timezone: "Asia/Tbilisi" };

let database: PrismaClient;

async function observatory(options: { measuredMaxAltitude?: number | null } = {}) {
  const row = await database.observatory.create({
    data: {
      slug: `test-${randomUUID()}`,
      nameEn: "Test",
      nameKa: "Test",
      city: "Test",
      countryCode: "GE",
      ...TBILISI,
      status: "ONLINE",
    },
  });
  const telescope = await database.telescope.create({
    data: {
      observatoryId: row.id,
      name: "NexStar 8SE",
      manufacturer: "Celestron",
      model: "NexStar 8SE",
      apertureMm: 203,
      focalLengthMm: 2032,
      status: "ONLINE",
    },
  });
  const owner = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Owner" },
  });
  await database.observatoryNetworkNode.create({
    data: {
      ownerId: owner.id,
      observatoryId: row.id,
      primaryTelescopeId: telescope.id,
      kind: "PARTNER",
      approvalStatus: "APPROVED",
      capabilities: [],
    },
  });
  if (options.measuredMaxAltitude !== undefined) {
    await database.safetyEnvelope.create({
      data: {
        observatoryId: row.id,
        minAltitudeDegrees: 15,
        maxAltitudeDegrees: options.measuredMaxAltitude,
        sunExclusionDegrees: 30,
        daylightLockSunAltitudeDegrees: -6,
        nudgeMaxDegrees: 0.5,
        nudgeRateDegreesPerSecond: 0.5,
        slewTimeoutSeconds: 120,
        heartbeatLossSeconds: 15,
        linkDeadSeconds: 60,
        refocusTemperatureDeltaC: 2,
      },
    });
  }
  return row.id;
}

/** Capella rides high over Tbilisi all December night; Canopus never rises there. */
async function targets() {
  const capella = await database.target.create({
    data: {
      slug: `capella-${randomUUID()}`,
      nameEn: "Capella",
      nameKa: "კაპელა",
      type: "DOUBLE_STAR",
      positionSource: "FIXED",
      rightAscensionHours: 5.278,
      declinationDegrees: 45.998,
      angularSizeArcmin: 0.1,
      magnitude: 0.1,
      opticalConfig: "F10_NATIVE",
      imagingProfile: "DOUBLE_STAR",
      minAltitudeDegrees: 20,
      expectedMissionMinutes: 10,
    },
  });
  const canopus = await database.target.create({
    data: {
      slug: `canopus-${randomUUID()}`,
      nameEn: "Canopus",
      nameKa: "კანოპუსი",
      type: "DOUBLE_STAR",
      positionSource: "FIXED",
      rightAscensionHours: 6.399,
      declinationDegrees: -52.696,
      angularSizeArcmin: 0.1,
      magnitude: -0.7,
      opticalConfig: "F10_NATIVE",
      imagingProfile: "DOUBLE_STAR",
      minAltitudeDegrees: 20,
      expectedMissionMinutes: 10,
    },
  });
  return { capella: capella.id, canopus: canopus.id };
}

async function customer() {
  return (
    await database.user.create({
      data: { email: `${randomUUID()}@example.test`, name: "Observer" },
    })
  ).id;
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
  // The order the other suites use: every Restrict foreign key cleared before the
  // row it points at, because these suites share one database.
  await database.vote.deleteMany();
  await database.capture.deleteMany();
  await database.auditLog.deleteMany();
  await database.missionEvent.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  await database.networkAvailabilityWindow.deleteMany();
  await database.observatoryNetworkNode.deleteMany();
  await database.safetyEnvelope.deleteMany();
  await database.observerPack.deleteMany();
  await database.booking.deleteMany();
  await database.mission.deleteMany();
  await database.payment.deleteMany();
  await database.telescope.deleteMany();
  await database.target.deleteMany();
  await database.weatherState.deleteMany();
  await database.observatory.deleteMany();
});

describe("the week's ballot", () => {
  it("lists what the observatory's sky allows that week, and nothing it does not", async () => {
    const observatoryId = await observatory({ measuredMaxAltitude: 85 });
    const { capella, canopus } = await targets();

    const result = await readWeekVote({ observatoryId, callerId: null, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const vote = zWeekVote.parse(result.vote);
    expect(vote.week).toBe(WEEK);
    expect(vote.locksAt).toBe("2026-12-20T13:00:00.000Z");
    expect(vote.candidates).toEqual([{ targetId: capella, votes: 0 }]);
    expect(vote.candidates.map((c) => c.targetId)).not.toContain(canopus);
    expect(vote.mine).toBeNull();
  });

  it("offers nothing while the safety envelope is unmeasured", async () => {
    const observatoryId = await observatory({ measuredMaxAltitude: null });
    await targets();
    const result = await readWeekVote({ observatoryId, callerId: null, now: NOW });
    expect(result.ok && result.vote.candidates).toEqual([]);
  });

  it("answers not-found for an observatory nobody may book, and refuses a week that is not a Monday", async () => {
    expect(await readWeekVote({ observatoryId: randomUUID(), callerId: null, now: NOW })).toEqual({
      ok: false,
      refusal: { kind: "not-found" },
    });
    const observatoryId = await observatory({ measuredMaxAltitude: 85 });
    expect(
      await readWeekVote({ observatoryId, week: "2026-12-15", callerId: null, now: NOW }),
    ).toEqual({ ok: false, refusal: { kind: "not-monday" } });
  });
});

describe("casting", () => {
  it("counts each customer once, moves a second vote, and shows the caller theirs", async () => {
    const observatoryId = await observatory({ measuredMaxAltitude: 85 });
    const { capella } = await targets();
    const [ana, giorgi] = await Promise.all([customer(), customer()]);

    const first = await castVote({ observatoryId, week: WEEK, targetId: capella, userId: ana, now: NOW });
    expect(first.ok && first.vote.candidates).toEqual([{ targetId: capella, votes: 1 }]);
    expect(first.ok && first.vote.mine).toBe(capella);

    await castVote({ observatoryId, week: WEEK, targetId: capella, userId: giorgi, now: NOW });
    const again = await castVote({ observatoryId, week: WEEK, targetId: capella, userId: ana, now: NOW });
    expect(again.ok && again.vote.candidates).toEqual([{ targetId: capella, votes: 2 }]);

    const read = await readWeekVote({ observatoryId, week: WEEK, callerId: giorgi, now: NOW });
    expect(read.ok && read.vote.mine).toBe(capella);
    expect(await database.vote.count()).toBe(2);
  });

  it("refuses a target off the ballot, and any vote once the week has locked", async () => {
    const observatoryId = await observatory({ measuredMaxAltitude: 85 });
    const { capella, canopus } = await targets();
    const userId = await customer();

    expect(
      await castVote({ observatoryId, week: WEEK, targetId: canopus, userId, now: NOW }),
    ).toEqual({ ok: false, refusal: { kind: "not-a-candidate" } });
    expect(
      await castVote({
        observatoryId,
        week: WEEK,
        targetId: capella,
        userId,
        now: new Date("2026-12-20T13:00:00.000Z"),
      }),
    ).toEqual({ ok: false, refusal: { kind: "locked" } });
    expect(await database.vote.count()).toBe(0);
  });
});
