import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { zObservatoryUptime } from "@darkview/contracts/zod";
import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

const { readObservatoryUptime } = await import("@/features/observatory/uptime");

/**
 * Phase 6.0 -- thirty days of link uptime, read from the AGENT_LINK audit rows the
 * realtime service writes. Against a real PostgreSQL, because the claims are about
 * which rows count: only this observatory's link events, and only up and lost.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const TBILISI = { latitude: 41.7151, longitude: 44.8271, timezone: "Asia/Tbilisi" };
/** Noon in Tbilisi on 16 December. */
const NOW = new Date("2026-12-16T08:00:00.000Z");

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

async function link(observatoryId: string, action: string, at: string) {
  await database.auditLog.create({
    data: {
      category: "AGENT_LINK",
      action,
      entityType: "Observatory",
      entityId: observatoryId,
      createdAt: new Date(at),
    },
  });
}

describe("thirty days of link uptime", () => {
  it("answers nothing for an observatory that is not bookable, or does not exist", async () => {
    const { observatoryId } = await bookableObservatory("SUSPENDED");
    await link(observatoryId, "AGENT_LINK_UP", "2026-12-01T00:00:00.000Z");

    expect(await readObservatoryUptime(observatoryId, NOW)).toBeNull();
    expect(await readObservatoryUptime(randomUUID(), NOW)).toBeNull();
  });

  it("counts only this observatory's link-up and link-lost rows", async () => {
    const { observatoryId } = await bookableObservatory();
    const other = await bookableObservatory();
    await link(observatoryId, "AGENT_LINK_UP", "2026-11-01T00:00:00.000Z");
    await link(observatoryId, "AGENT_LINK_LOST", "2026-12-14T19:00:00.000Z");
    // A posture change is AGENT_LINK too, and says nothing about the link.
    await link(observatoryId, "AGENT_POSTURE_CHANGED", "2026-12-14T20:00:00.000Z");
    await link(observatoryId, "AGENT_LINK_UP", "2026-12-14T21:00:00.000Z");
    await link(other.observatoryId, "AGENT_LINK_LOST", "2026-12-10T00:00:00.000Z");

    const uptime = await readObservatoryUptime(observatoryId, NOW);

    expect(zObservatoryUptime.parse(uptime)).toEqual(uptime);
    expect(uptime?.days[0]).toMatchObject({ date: "2026-11-17", uptimePercent: 100 });
    expect(uptime?.days.find((day) => day.date === "2026-12-14")).toMatchObject({
      onlineSeconds: 86_400 - 3600,
    });
    expect(uptime?.incidents).toEqual([
      { lostAt: "2026-12-14T19:00:00.000Z", restoredAt: "2026-12-14T21:00:00.000Z" },
    ]);
  });
});
