import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { zViewingConditions } from "@darkview/contracts/zod";
import { PrismaClient } from "@darkview/db";

import { nightWindow } from "@/lib/slots/darkness";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

const { readViewingConditions } = await import("@/features/observatory/conditions");

/**
 * DV-110 -- tonight's viewing forecast, read from what the realtime service stored.
 *
 * Against a real PostgreSQL instance, because the claims are about which stored
 * rows count: only this observatory's, only tonight's hours, and only fresh ones.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const TBILISI = { latitude: 41.7151, longitude: 44.8271, timezone: "Asia/Tbilisi" };
const SITE = { latitudeDegrees: TBILISI.latitude, longitudeDegrees: TBILISI.longitude };

/** Midnight in Tbilisi on 16 December: tonight is still the night that began on the 15th. */
const MIDNIGHT = new Date("2026-12-15T20:00:00.000Z");
/** Two in the afternoon on the 16th: last night has ended, tonight begins this evening. */
const AFTERNOON = new Date("2026-12-16T10:00:00.000Z");

const MAX_AGE_MINUTES = 180;
const HOUR_MS = 3_600_000;

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

async function forecastEveryHour(
  observatoryId: string,
  from: Date,
  to: Date,
  fetchedAt: Date,
  values: { cloudCoverPercent?: number; seeingArcseconds?: number | null } = {},
) {
  const first = Math.floor(from.getTime() / HOUR_MS) * HOUR_MS;
  await database.viewingForecastHour.createMany({
    data: Array.from({ length: Math.ceil((to.getTime() - first) / HOUR_MS) }, (_, index) => ({
      observatoryId,
      at: new Date(first + index * HOUR_MS),
      source: "OPEN_METEO" as const,
      fetchedAt,
      cloudCoverPercent: values.cloudCoverPercent ?? 20,
      cloudCoverLowPercent: 5,
      cloudCoverMidPercent: 10,
      cloudCoverHighPercent: 20,
      precipitationProbabilityPercent: 0,
      relativeHumidityPercent: 70,
      windSpeedMetresPerSecond: 2.5,
      seeingArcseconds: values.seeingArcseconds ?? null,
    })),
  });
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

describe("tonight's viewing conditions", () => {
  it("answers nothing for an observatory that is not bookable, or does not exist", async () => {
    const { observatoryId } = await bookableObservatory("SUSPENDED");
    const night = nightWindow("2026-12-15", TBILISI.timezone, SITE)!;
    await forecastEveryHour(observatoryId, night.duskAt, night.dawnAt, MIDNIGHT);

    expect(await readViewingConditions(observatoryId, MIDNIGHT, MAX_AGE_MINUTES)).toBeNull();
    expect(await readViewingConditions(randomUUID(), MIDNIGHT, MAX_AGE_MINUTES)).toBeNull();
  });

  it("covers every hour of the night still in progress, known, in a body the contract accepts", async () => {
    const { observatoryId } = await bookableObservatory();
    const night = nightWindow("2026-12-15", TBILISI.timezone, SITE)!;
    await forecastEveryHour(observatoryId, night.duskAt, night.dawnAt, MIDNIGHT, {
      seeingArcseconds: 1.4,
    });

    const conditions = await readViewingConditions(observatoryId, MIDNIGHT, MAX_AGE_MINUTES);

    expect(zViewingConditions.parse(conditions)).toEqual(conditions);
    expect(conditions?.date).toBe("2026-12-15");
    const items = conditions!.items;
    expect(new Date(items[0].at).getTime()).toBeLessThanOrEqual(night.duskAt.getTime());
    expect(new Date(items[0].at).getTime()).toBeGreaterThan(night.duskAt.getTime() - HOUR_MS);
    expect(new Date(items.at(-1)!.at).getTime()).toBeLessThan(night.dawnAt.getTime());
    for (let index = 1; index < items.length; index += 1) {
      expect(new Date(items[index].at).getTime() - new Date(items[index - 1].at).getTime()).toBe(
        HOUR_MS,
      );
    }
    expect(items.every((item) => item.status === "KNOWN")).toBe(true);
    expect(items[0]).toMatchObject({
      source: "OPEN_METEO",
      fetchedAt: MIDNIGHT.toISOString(),
      cloudCoverPercent: 20,
      seeingArcseconds: 1.4,
    });
  });

  it("moves to tonight once last night's dawn has passed", async () => {
    const { observatoryId } = await bookableObservatory();

    const conditions = await readViewingConditions(observatoryId, AFTERNOON, MAX_AGE_MINUTES);

    const tonight = nightWindow("2026-12-16", TBILISI.timezone, SITE)!;
    expect(conditions?.date).toBe("2026-12-16");
    expect(new Date(conditions!.items.at(-1)!.at).getTime()).toBeLessThan(
      tonight.dawnAt.getTime(),
    );
    expect(new Date(conditions!.items[0].at).getTime()).toBeGreaterThan(
      tonight.duskAt.getTime() - HOUR_MS,
    );
  });

  it("reports an hour with no stored forecast as unknown, with every value null", async () => {
    const { observatoryId } = await bookableObservatory();

    const conditions = await readViewingConditions(observatoryId, MIDNIGHT, MAX_AGE_MINUTES);

    expect(conditions!.items.length).toBeGreaterThan(0);
    for (const item of conditions!.items) {
      expect(item).toEqual({
        at: item.at,
        status: "UNKNOWN",
        source: null,
        fetchedAt: null,
        cloudCoverPercent: null,
        cloudCoverLowPercent: null,
        cloudCoverMidPercent: null,
        cloudCoverHighPercent: null,
        precipitationProbabilityPercent: null,
        relativeHumidityPercent: null,
        windSpeedMetresPerSecond: null,
        seeingArcseconds: null,
      });
    }
  });

  it("reports a forecast older than the maximum age as unknown, never as clear", async () => {
    const { observatoryId } = await bookableObservatory();
    const night = nightWindow("2026-12-15", TBILISI.timezone, SITE)!;
    const stale = new Date(MIDNIGHT.getTime() - (MAX_AGE_MINUTES + 1) * 60_000);
    await forecastEveryHour(observatoryId, night.duskAt, night.dawnAt, stale, {
      cloudCoverPercent: 0,
    });

    const conditions = await readViewingConditions(observatoryId, MIDNIGHT, MAX_AGE_MINUTES);

    expect(conditions!.items.every((item) => item.status === "UNKNOWN")).toBe(true);
    expect(conditions!.items.every((item) => item.cloudCoverPercent === null)).toBe(true);
  });

  it("reads only this observatory's forecast", async () => {
    const { observatoryId } = await bookableObservatory();
    const other = await bookableObservatory();
    const night = nightWindow("2026-12-15", TBILISI.timezone, SITE)!;
    await forecastEveryHour(other.observatoryId, night.duskAt, night.dawnAt, MIDNIGHT);

    const conditions = await readViewingConditions(observatoryId, MIDNIGHT, MAX_AGE_MINUTES);

    expect(conditions!.items.every((item) => item.status === "UNKNOWN")).toBe(true);
  });

  it("covers only the hours the owner offers", async () => {
    const { observatoryId, nodeId } = await bookableObservatory();
    // 20:00 to 22:00 local on the evening of Tuesday 15 December.
    await database.networkAvailabilityWindow.create({
      data: { nodeId, weekday: 2, startMinute: 20 * 60, endMinute: 22 * 60, enabled: true },
    });

    const conditions = await readViewingConditions(observatoryId, MIDNIGHT, MAX_AGE_MINUTES);

    expect(conditions!.items.map((item) => item.at)).toEqual([
      "2026-12-15T16:00:00.000Z",
      "2026-12-15T17:00:00.000Z",
    ]);
  });

  it("is unaffected by a weather hold, and reads no hold into the forecast", async () => {
    const { observatoryId } = await bookableObservatory();
    const night = nightWindow("2026-12-15", TBILISI.timezone, SITE)!;
    await forecastEveryHour(observatoryId, night.duskAt, night.dawnAt, MIDNIGHT, {
      cloudCoverPercent: 0,
    });
    await database.weatherState.create({
      data: { observatoryId, status: "CLOUDY", holdActive: true, note: "operator" },
    });

    const conditions = await readViewingConditions(observatoryId, MIDNIGHT, MAX_AGE_MINUTES);

    expect(conditions!.items.every((item) => item.status === "KNOWN")).toBe(true);
    expect(conditions!.items.every((item) => item.cloudCoverPercent === 0)).toBe(true);
    expect(await database.weatherState.findUniqueOrThrow({ where: { observatoryId } })).toMatchObject({
      holdActive: true,
      status: "CLOUDY",
    });
  });
});
