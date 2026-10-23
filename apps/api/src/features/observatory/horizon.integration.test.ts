import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { zObservatoryHorizon } from "@darkview/contracts/zod";
import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

const { readObservatoryHorizon } = await import("@/features/observatory/horizon");

/**
 * Phase 6.2 -- the horizon mask, for the live room's sky chart. Against a real
 * PostgreSQL, because the claims are about which rows are read: this observatory's
 * envelope only, its mask in order, and nothing for one with no envelope.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const TBILISI = { latitude: 41.7151, longitude: 44.8271, timezone: "Asia/Tbilisi" };

let database: PrismaClient;

async function bookableObservatory(
  approvalStatus: "DRAFT" | "APPROVED" | "SUSPENDED" = "APPROVED",
) {
  const observatory = await database.observatory.create({
    data: {
      slug: `test-${randomUUID()}`,
      nameEn: "Test",
      nameKa: "Test",
      city: "Tbilisi",
      countryCode: "GE",
      ...TBILISI,
      status: "ONLINE",
    },
  });
  const telescope = await database.telescope.create({
    data: {
      observatoryId: observatory.id,
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
  const node = await database.observatoryNetworkNode.create({
    data: {
      ownerId: owner.id,
      observatoryId: observatory.id,
      primaryTelescopeId: telescope.id,
      kind: "PARTNER",
      approvalStatus,
      capabilities: [],
    },
  });
  return { observatoryId: observatory.id, nodeId: node.id };
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
  await database.bookingEntitlement.deleteMany();
  await database.emailNotification.deleteMany();
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
  await database.viewingForecastHour.deleteMany();
  await database.observatory.deleteMany();
  await database.user.deleteMany();
});

async function envelope(observatoryId: string, mask: [number, number][]) {
  await database.safetyEnvelope.create({
    data: {
      observatoryId,
      minAltitudeDegrees: 20,
      sunExclusionDegrees: 30,
      daylightLockSunAltitudeDegrees: -6,
      nudgeMaxDegrees: 2,
      nudgeRateDegreesPerSecond: 0.5,
      slewTimeoutSeconds: 120,
      heartbeatLossSeconds: 15,
      linkDeadSeconds: 60,
      refocusTemperatureDeltaC: 2,
      horizonMask: {
        create: mask.map(([azimuthDegrees, minAltitudeDegrees]) => ({
          azimuthDegrees,
          minAltitudeDegrees,
        })),
      },
    },
  });
}

describe("the horizon for the sky chart", () => {
  it("answers nothing for an observatory that is not bookable, or does not exist", async () => {
    const { observatoryId } = await bookableObservatory("SUSPENDED");
    await envelope(observatoryId, [[0, 25]]);

    expect(await readObservatoryHorizon(observatoryId)).toBeNull();
    expect(await readObservatoryHorizon(randomUUID())).toBeNull();
  });

  it("reads this observatory's minimum altitude and mask, in order of bearing", async () => {
    const { observatoryId } = await bookableObservatory();
    const other = await bookableObservatory();
    await envelope(observatoryId, [
      [270, 30],
      [90, 22.5],
      [0, 25],
    ]);
    await envelope(other.observatoryId, [[180, 60]]);

    const horizon = await readObservatoryHorizon(observatoryId);

    expect(zObservatoryHorizon.parse(horizon)).toEqual(horizon);
    expect(horizon).toEqual({
      observatoryId,
      minAltitudeDegrees: 20,
      mask: [
        { azimuthDegrees: 0, minAltitudeDegrees: 25 },
        { azimuthDegrees: 90, minAltitudeDegrees: 22.5 },
        { azimuthDegrees: 270, minAltitudeDegrees: 30 },
      ],
    });
  });

  it("states an observatory with no envelope as unknown, never as a flat horizon", async () => {
    const { observatoryId } = await bookableObservatory();

    expect(await readObservatoryHorizon(observatoryId)).toEqual({
      observatoryId,
      minAltitudeDegrees: null,
      mask: [],
    });
  });
});
