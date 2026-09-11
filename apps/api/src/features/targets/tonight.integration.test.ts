import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { zTonightTargetList } from "@darkview/contracts/zod";
import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

const { listTonightTargets } = await import("@/features/targets/tonight");

/**
 * DV-067 -- what is up tonight, at the telescope the customer chose.
 *
 * Against a real PostgreSQL instance, because the claim is that each observatory's
 * own site, envelope and state are read and no other's -- a scoping claim, which
 * only a database applying the WHERE clause can prove.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

/**
 * Midnight in Tbilisi (UTC+4) and five in the afternoon of a Santiago summer
 * (UTC-3). The Sun is far below one horizon and above the other, so any answer
 * that is not per-site shows up as the wrong sign on a number.
 */
const NOW = new Date("2026-12-15T20:00:00.000Z");

const TBILISI = { latitude: 41.7151, longitude: 44.8271, timezone: "Asia/Tbilisi" };
const SANTIAGO = { latitude: -33.45, longitude: -70.66, timezone: "America/Santiago" };

let database: PrismaClient;

async function bookableObservatory(
  site: typeof TBILISI,
  options: {
    approvalStatus?: "DRAFT" | "UNDER_REVIEW" | "APPROVED" | "SUSPENDED";
    measuredMaxAltitude?: number | null;
  } = {},
) {
  const observatory = await database.observatory.create({
    data: {
      slug: `test-${randomUUID()}`,
      nameEn: "Test",
      nameKa: "Test",
      city: "Test",
      countryCode: "GE",
      ...site,
      status: "ONLINE",
    },
  });

  const telescope = await database.telescope.create({
    data: {
      observatoryId: observatory.id,
      name: "NexStar 6SE",
      manufacturer: "Celestron",
      model: "NexStar 6SE",
      apertureMm: 150,
      focalLengthMm: 1500,
      status: "ONLINE",
    },
  });

  const owner = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Owner" },
  });

  await database.observatoryNetworkNode.create({
    data: {
      ownerId: owner.id,
      observatoryId: observatory.id,
      primaryTelescopeId: telescope.id,
      kind: "PARTNER",
      approvalStatus: options.approvalStatus ?? "APPROVED",
      capabilities: [],
    },
  });

  if (options.measuredMaxAltitude !== undefined) {
    await database.safetyEnvelope.create({
      data: {
        observatoryId: observatory.id,
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

  return observatory.id;
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
  await database.capture.deleteMany();
  await database.auditLog.deleteMany();
  await database.missionEvent.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  await database.networkAvailabilityWindow.deleteMany();
  await database.observatoryNetworkNode.deleteMany();
  await database.safetyEnvelope.deleteMany();
  await database.booking.deleteMany();
  await database.mission.deleteMany();
  await database.payment.deleteMany();
  await database.telescope.deleteMany();
  await database.target.deleteMany();
  await database.weatherState.deleteMany();
  await database.observatory.deleteMany();
  await database.user.deleteMany();

  await database.target.create({
    data: {
      slug: `m42-${randomUUID()}`,
      nameEn: "M42",
      nameKa: "M42",
      type: "BRIGHT_NEBULA",
      positionSource: "FIXED",
      rightAscensionHours: 5.588,
      declinationDegrees: -5.39,
      angularSizeArcmin: 65,
      magnitude: 4,
      opticalConfig: "F10_NATIVE",
      imagingProfile: "BRIGHT_NEBULA",
      minAltitudeDegrees: 20,
      expectedMissionMinutes: 30,
    },
  });
});

describe("tonight, at the chosen telescope", () => {
  it("evaluates each observatory at its own site", async () => {
    const tbilisi = await bookableObservatory(TBILISI, { measuredMaxAltitude: 70 });
    const santiago = await bookableObservatory(SANTIAGO, { measuredMaxAltitude: 70 });

    const atTbilisi = await listTonightTargets(tbilisi, NOW);
    const atSantiago = await listTonightTargets(santiago, NOW);

    // Before DV-067 both of these were Tbilisi's sky, whichever was asked for.
    expect(atTbilisi?.items[0].visibility.sunAltitudeDegrees).toBeLessThan(-18);
    expect(atSantiago?.items[0].visibility.sunAltitudeDegrees).toBeGreaterThan(0);
    expect(atSantiago?.items[0].visibility.blockReasons).toContain("SUN_TOO_HIGH");

    expect(atTbilisi?.observatoryId).toBe(tbilisi);
    expect(atSantiago?.observatoryId).toBe(santiago);
  });

  it("reads each observatory's own safety envelope, and no other's", async () => {
    // Tbilisi is measured and Santiago is not. Borrowing the first site's limits
    // for the second would offer targets on a telescope whose optical train has
    // never been measured against its mount.
    const tbilisi = await bookableObservatory(TBILISI, { measuredMaxAltitude: 70 });
    const santiago = await bookableObservatory(SANTIAGO);

    const measured = await listTonightTargets(tbilisi, NOW);
    const unmeasured = await listTonightTargets(santiago, NOW);

    expect(measured?.items[0].visibility.blockReasons).not.toContain(
      "SAFETY_ENVELOPE_UNMEASURED",
    );
    expect(unmeasured?.items[0].visibility.blockReasons).toContain(
      "SAFETY_ENVELOPE_UNMEASURED",
    );
  });

  it("produces a list the contract's own schema accepts", async () => {
    const tbilisi = await bookableObservatory(TBILISI, { measuredMaxAltitude: 70 });

    const list = await listTonightTargets(tbilisi, NOW);

    expect(zTonightTargetList.safeParse(list).success).toBe(true);
  });

  /**
   * The same rule and the same resolver as GET /slots. A caller probing ids must
   * not be able to tell a suspended partner node from a random uuid.
   */
  it.each(["DRAFT", "UNDER_REVIEW", "SUSPENDED"] as const)(
    "answers nothing for a %s node",
    async (approvalStatus) => {
      const hidden = await bookableObservatory(TBILISI, {
        approvalStatus,
        measuredMaxAltitude: 70,
      });

      expect(await listTonightTargets(hidden, NOW)).toBeNull();
    },
  );

  it("answers nothing for an id that is not an observatory", async () => {
    expect(await listTonightTargets(randomUUID(), NOW)).toBeNull();
  });
});
