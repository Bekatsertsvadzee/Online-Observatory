import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@darkview/db";

import { type ForecastSource, refreshViewingConditions } from "@/conditions/forecast";
import { openMeteoSource } from "@/conditions/open-meteo";

/**
 * DV-110 against a real PostgreSQL instance: what a refresh stores, for whom, and
 * that it never touches a weather hold. Open-Meteo is answered from the response
 * recorded on 2026-09-16; no test calls a weather API.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const recorded = readFileSync(
  path.resolve(import.meta.dirname, "fixtures/open-meteo-tbilisi-2026-09-16.json"),
  "utf8",
);
const recordedOpenMeteo = openMeteoSource({
  fetchImpl: async () => new Response(recorded, { status: 200 }),
});
const failingMeteoblue: ForecastSource = {
  name: "METEOBLUE",
  fetchHours: async () => {
    throw new Error("meteoblue answered 503");
  },
};
const failingOpenMeteo: ForecastSource = {
  name: "OPEN_METEO",
  fetchHours: async () => {
    throw new Error("open-meteo answered 503");
  },
};

const NOW = new Date("2026-09-16T12:00:00.000Z");

let database: PrismaClient;

async function observatory(approvalStatus: "DRAFT" | "APPROVED" | "SUSPENDED") {
  const row = await database.observatory.create({
    data: {
      slug: `test-${randomUUID()}`,
      nameEn: "Test",
      nameKa: "Test",
      city: "Tbilisi",
      countryCode: "GE",
      latitude: 41.7151,
      longitude: 44.8271,
      timezone: "Asia/Tbilisi",
    },
  });
  const owner = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Owner" },
  });
  await database.observatoryNetworkNode.create({
    data: {
      ownerId: owner.id,
      observatoryId: row.id,
      kind: "PARTNER",
      approvalStatus,
      capabilities: [],
    },
  });
  return row.id;
}

beforeAll(async () => {
  database = new PrismaClient({ adapter: new PrismaPg({ connectionString: CONNECTION_STRING }) });
  await database.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(async () => {
  await database.bookingEntitlement.deleteMany();
  await database.emailNotification.deleteMany();
  await database.networkAvailabilityWindow.deleteMany();
  await database.observatoryNetworkNode.deleteMany();
  await database.capture.deleteMany();
  await database.auditLog.deleteMany();
  await database.missionParticipant.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  await database.missionEvent.deleteMany();
  await database.observerPack.deleteMany();
  await database.booking.deleteMany();
  await database.mission.deleteMany();
  await database.payment.deleteMany();
  await database.safetyEnvelope.deleteMany();
  await database.telescope.deleteMany();
  await database.target.deleteMany();
  await database.weatherState.deleteMany();
  await database.agentMessage.deleteMany();
  await database.viewingForecastHour.deleteMany();
  await database.observatory.deleteMany();
  await database.user.deleteMany();
});

describe("refreshing viewing conditions", () => {
  it("stores every forecast hour for an approved observatory, naming the source", async () => {
    const observatoryId = await observatory("APPROVED");

    const result = await refreshViewingConditions(database, {
      sources: [recordedOpenMeteo],
      now: NOW,
    });

    expect(result).toMatchObject({ refreshed: 1, unavailable: 0 });
    const rows = await database.viewingForecastHour.findMany({
      where: { observatoryId },
      orderBy: { at: "asc" },
    });
    expect(rows).toHaveLength(48);
    expect(rows[0]).toMatchObject({
      at: new Date("2026-09-16T00:00:00.000Z"),
      source: "OPEN_METEO",
      fetchedAt: NOW,
      cloudCoverPercent: 100,
      cloudCoverLowPercent: 70,
      windSpeedMetresPerSecond: 3.13,
      seeingArcseconds: null,
    });
  });

  it("falls back to Open-Meteo when meteoblue fails", async () => {
    const observatoryId = await observatory("APPROVED");

    const result = await refreshViewingConditions(database, {
      sources: [failingMeteoblue, recordedOpenMeteo],
      now: NOW,
    });

    expect(result.failures).toEqual([`${observatoryId} METEOBLUE: meteoblue answered 503`]);
    expect(
      await database.viewingForecastHour.count({ where: { observatoryId, source: "OPEN_METEO" } }),
    ).toBe(48);
  });

  it("fetches nothing for a node that is not approved", async () => {
    await observatory("DRAFT");
    await observatory("SUSPENDED");

    const result = await refreshViewingConditions(database, {
      sources: [recordedOpenMeteo],
      now: NOW,
    });

    expect(result.refreshed).toBe(0);
    expect(await database.viewingForecastHour.count()).toBe(0);
  });

  it("overwrites the hours a later fetch covers, and never duplicates them", async () => {
    const observatoryId = await observatory("APPROVED");
    await refreshViewingConditions(database, { sources: [recordedOpenMeteo], now: NOW });

    const later = new Date(NOW.getTime() + 3_600_000);
    await refreshViewingConditions(database, { sources: [recordedOpenMeteo], now: later });

    const rows = await database.viewingForecastHour.findMany({ where: { observatoryId } });
    expect(rows).toHaveLength(48);
    expect(rows.every((row) => row.fetchedAt.getTime() === later.getTime())).toBe(true);
  });

  it("writes nothing when every source fails, so what was stored ages rather than refreshes", async () => {
    const observatoryId = await observatory("APPROVED");
    await refreshViewingConditions(database, { sources: [recordedOpenMeteo], now: NOW });

    const result = await refreshViewingConditions(database, {
      sources: [failingMeteoblue, failingOpenMeteo],
      now: new Date(NOW.getTime() + 3_600_000),
    });

    expect(result).toMatchObject({ refreshed: 0, unavailable: 1 });
    const rows = await database.viewingForecastHour.findMany({ where: { observatoryId } });
    expect(rows.every((row) => row.fetchedAt.getTime() === NOW.getTime())).toBe(true);
  });

  it("deletes hours more than two days past", async () => {
    const observatoryId = await observatory("APPROVED");
    await database.viewingForecastHour.create({
      data: {
        observatoryId,
        at: new Date("2026-09-13T20:00:00.000Z"),
        source: "OPEN_METEO",
        fetchedAt: new Date("2026-09-13T12:00:00.000Z"),
      },
    });

    await refreshViewingConditions(database, { sources: [recordedOpenMeteo], now: NOW });

    expect(
      await database.viewingForecastHour.count({
        where: { observatoryId, at: new Date("2026-09-13T20:00:00.000Z") },
      }),
    ).toBe(0);
  });

  it("never sets or clears a weather hold, whatever the forecast says", async () => {
    const held = await observatory("APPROVED");
    const clear = await observatory("APPROVED");
    await database.weatherState.create({
      data: { observatoryId: held, status: "CLEAR", holdActive: true, note: "operator" },
    });
    await database.weatherState.create({
      data: { observatoryId: clear, status: "CLEAR", holdActive: false },
    });
    const before = await database.weatherState.findMany({ orderBy: { observatoryId: "asc" } });

    // The recorded night is fully overcast in its first hours.
    await refreshViewingConditions(database, { sources: [recordedOpenMeteo], now: NOW });

    expect(await database.weatherState.findMany({ orderBy: { observatoryId: "asc" } })).toEqual(
      before,
    );
  });
});
