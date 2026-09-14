import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ObservatoryTelemetry } from "@darkview/contracts";
import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

const { readOperatorObservatoryState } = await import("@/features/admin/observatory-state");
const { zOperatorObservatoryState } = await import("@darkview/contracts/zod");

/**
 * ADR-017 §3 and §4 against a real PostgreSQL instance: the envelope, the live
 * mission and its session come from the database, and the realtime answer is a
 * fake fetch. Every way the realtime answer can be missing is a 503.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const NOW = new Date("2026-09-14T20:00:00.000Z");
const REALTIME = { url: "http://realtime.internal:4001", secret: "s".repeat(32) };

const telemetry: ObservatoryTelemetry = {
  mode: "SIMULATED",
  link: "ONLINE",
  mount: { health: "OK", detail: null },
  camera: { health: "OK", detail: null },
  focuser: { health: "NOT_CONFIGURED", detail: null },
  weather: {
    status: "CLEAR",
    source: "OPERATOR",
    holdActive: false,
    note: null,
    updatedAt: "2026-09-14T19:00:00.000Z",
  },
  reportedAt: "2026-09-14T19:59:59.000Z",
};

let database: PrismaClient;
let observatoryId: string;
let missionId: string;
let sessionId: string;

function answering(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

const snapshot = () => ({
  observatoryId,
  telemetry,
  lastHeartbeatAt: "2026-09-14T19:59:58.000Z",
});

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
  await database.capture.deleteMany();
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

  // UNMEASURED on purpose: this read reports the envelope, it does not slew.
  await database.safetyEnvelope.create({
    data: {
      observatoryId,
      minAltitudeDegrees: 20,
      maxAltitudeDegrees: null,
      sunExclusionDegrees: 30,
      daylightLockSunAltitudeDegrees: -6,
      nudgeMaxDegrees: 1,
      nudgeRateDegreesPerSecond: 0.25,
      slewTimeoutSeconds: 120,
      heartbeatLossSeconds: 15,
      linkDeadSeconds: 60,
      refocusTemperatureDeltaC: 1.5,
    },
  });

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
  const user = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Owner", emailVerifiedAt: NOW },
  });

  const mission = await database.mission.create({
    data: {
      userId: user.id,
      targetId: target.id,
      observatoryId,
      telescopeId: telescope.id,
      state: "OBSERVING",
    },
  });
  missionId = mission.id;

  const session = await database.missionSession.create({
    data: {
      missionId,
      userId: user.id,
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 20 * 60_000),
    },
  });
  sessionId = session.id;
});

const read = (fetchImpl: typeof fetch, realtime: { url?: string; secret?: string } = REALTIME) =>
  readOperatorObservatoryState({ observatoryId, realtime, now: NOW, fetchImpl });

describe("assembling the operator's view", () => {
  it("joins live telemetry to the envelope, the live mission and its session", async () => {
    const fetchImpl = answering(200, snapshot());

    const result = await read(fetchImpl as unknown as typeof fetch);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => zOperatorObservatoryState.parse(result.state)).not.toThrow();
    expect(result.state).toMatchObject({
      observatoryId,
      telemetry,
      activeMissionId: missionId,
      activeSessionId: sessionId,
      linkLatencyMs: null,
      lastHeartbeatAt: "2026-09-14T19:59:58.000Z",
      updatedAt: telemetry.reportedAt,
    });
    expect(result.state.safetyEnvelope.maxAltitudeDegrees).toBeNull();
  });

  it("asks the realtime service for this observatory, with the secret", async () => {
    const fetchImpl = answering(200, snapshot());

    await read(fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      `http://realtime.internal:4001/internal/observatories/${observatoryId}/state`,
    );
    expect(init.headers).toEqual({ authorization: `Bearer ${REALTIME.secret}` });
  });

  it("reports no active session once the owner's session has been revoked", async () => {
    await database.missionSession.update({
      where: { id: sessionId },
      data: { revokedAt: NOW },
    });

    const result = await read(answering(200, snapshot()) as unknown as typeof fetch);

    expect(result).toMatchObject({ ok: true, state: { activeMissionId: missionId, activeSessionId: null } });
  });
});

describe("no telemetry is a 503, never an invented reading", () => {
  const offline = { ok: false, status: 503, code: "OBSERVATORY_OFFLINE" };

  it("when the realtime service is not configured", async () => {
    const fetchImpl = answering(200, snapshot());
    await expect(read(fetchImpl as unknown as typeof fetch, {})).resolves.toMatchObject(offline);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("when the realtime service has no sample", async () => {
    await expect(read(answering(404, {}) as unknown as typeof fetch)).resolves.toMatchObject(offline);
  });

  it("when the realtime service cannot be reached", async () => {
    const unreachable = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(read(unreachable as unknown as typeof fetch)).resolves.toMatchObject(offline);
  });

  it("when the answer is not the contract's shape", async () => {
    await expect(
      read(answering(200, { observatoryId, telemetry: { mode: "SIMULATED" } }) as unknown as typeof fetch),
    ).resolves.toMatchObject(offline);
  });

  it("when the answer is for another observatory", async () => {
    await expect(
      read(answering(200, { ...snapshot(), observatoryId: randomUUID() }) as unknown as typeof fetch),
    ).resolves.toMatchObject(offline);
  });

  it("says SAFETY_NOT_CONFIGURED when no envelope has been recorded", async () => {
    await database.safetyEnvelope.deleteMany({ where: { observatoryId } });

    await expect(read(answering(200, snapshot()) as unknown as typeof fetch)).resolves.toMatchObject({
      ok: false,
      status: 503,
      code: "SAFETY_NOT_CONFIGURED",
    });
  });
});
