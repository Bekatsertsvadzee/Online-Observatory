import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

const { setSafetyEnvelope, provenanceGapsOf } =
  await import("@/features/admin/safety-envelope");
const { loadSafetyEnvelope } = await import("@/lib/safety/store");
const { zSafetyEnvelopeConfig } = await import("@darkview/contracts/zod");

/**
 * DV-059 criterion 4 — recording a measured envelope.
 *
 * `maxAltitudeDegrees` is MAX_ALT_SAFE: a number read off the assembled optical
 * train by raising altitude in five-degree steps with the power off and watching
 * the rear of the camera train against the fork base. Its provenance is part of
 * the value. A number with no measuredAt and no measuredBy is somebody's guess,
 * and a guess here is how an optical train meets a fork arm.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const NOW = new Date("2026-07-15T20:00:00.000Z");

/** A test fake for MAX_ALT_SAFE, stated at every call site. */
const MEASURED = 78;

let database: PrismaClient;
let listener: Client;
let notifications: string[];
let observatoryId: string;
let operatorId: string;

/**
 * MAX_ALT_SAFE is stated by every caller. There is no default for it anywhere in
 * this repository, fixtures included: `agent/tests/test_no_default_max_altitude.py`
 * fails the build on one, because a fixture default is how an unmeasured value
 * ends up looking measured. The numbers below are test fakes.
 */
function envelopeFor(
  maxAltitude: number | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    observatoryId,
    minAltitudeDegrees: 20,
    maxAltitudeDegrees: maxAltitude,
    maxAltitudeMeasuredAt: null,
    maxAltitudeMeasuredBy: null,
    maxAltitudeMeasurementNote: null,
    horizonMask: [
      { azimuthDegrees: 0, minAltitudeDegrees: 22 },
      { azimuthDegrees: 180, minAltitudeDegrees: 26 },
    ],
    forbiddenAzimuthSectors: [{ fromDegrees: 350, toDegrees: 10 }],
    sunExclusionDegrees: 30,
    daylightLockSunAltitudeDegrees: -6,
    nudgeMaxDegrees: 1,
    nudgeRateDegreesPerSecond: 0.25,
    slewTimeoutSeconds: 120,
    heartbeatLossSeconds: 15,
    linkDeadSeconds: 60,
    refocusTemperatureDeltaC: 1.5,
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

/**
 * Wait for this observatory's ENVELOPE notification.
 *
 * Scoped to the observatory, not just the kind. Every test creates a fresh
 * observatory, so a late notification from the previous one is a different id --
 * and taking the first ENVELOPE of any observatory would hand a test its
 * predecessor's and fail on the mismatch.
 */
async function nextEnvelopeNotification(timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const index = notifications.findIndex((raw) => {
      const parsed = JSON.parse(raw) as { kind?: string; observatoryId?: string };
      return parsed.kind === "ENVELOPE" && parsed.observatoryId === observatoryId;
    });
    if (index >= 0) return JSON.parse(notifications.splice(index, 1)[0]);
    if (Date.now() > deadline) throw new Error("no ENVELOPE notification arrived");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING }),
  });
  testDatabase.current = database;
  await database.$queryRaw`SELECT 1`;

  listener = new Client({ connectionString: CONNECTION_STRING });
  await listener.connect();
  await listener.query("LISTEN darkview_agent");
  listener.on("notification", (message) => {
    if (message.payload) notifications.push(message.payload);
  });
});

afterAll(async () => {
  await listener.end();
  await database.$disconnect();
});

beforeEach(async () => {
  notifications = [];

  // Captures first. Capture holds Restrict foreign keys to Mission, Target,
  // Telescope, Observatory and User, so a capture left behind by another suite
  // blocks every delete below it -- and these suites share one database.
  await database.capture.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  await database.missionEvent.deleteMany();
  await database.booking.deleteMany();
  await database.mission.deleteMany();
  await database.safetyEnvelope.deleteMany();
  await database.telescope.deleteMany();
  await database.weatherState.deleteMany();
  await database.observatory.deleteMany();

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

  // The audit row DV-062 writes carries the operator who made the call, and
  // AuditLog.actorUserId is a foreign key, so the operator has to be real.
  //
  // Created, never swept. This suite does not clear Payment, and Payment.user is
  // onDelete: Restrict -- so a `user.deleteMany()` here fails outright whenever
  // the booking suite happened to run first and leave a payment behind. Vitest
  // does not fix the order between files, which made that an intermittent failure
  // of all nine tests in this file rather than an obvious one. The email is
  // already unique per run, so there is nothing to sweep.
  const operator = await database.user.create({
    data: {
      email: `operator-${randomUUID()}@example.test`,
      name: "Test Operator",
      role: "OPERATOR",
      emailVerifiedAt: NOW,
    },
  });
  operatorId = operator.id;
});

describe("recording a measured maximum altitude", () => {
  // criterion 4
  it("refuses a measurement with no measuredAt and no measuredBy", async () => {
    const result = await setSafetyEnvelope({
      observatoryId,
      envelope: envelopeFor(MEASURED),
      actorUserId: operatorId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(result.details?.missing).toEqual([
      "maxAltitudeMeasuredAt",
      "maxAltitudeMeasuredBy",
    ]);

    // And nothing was stored: a refused measurement leaves the system UNMEASURED
    // rather than half-recorded.
    expect(await loadSafetyEnvelope(observatoryId)).toBeNull();
  });

  it.each([
    ["measuredAt", { maxAltitudeMeasuredBy: "Beka" }],
    ["measuredBy", { maxAltitudeMeasuredAt: NOW.toISOString() }],
  ])("refuses a measurement missing only %s", async (_label, provenance) => {
    const result = await setSafetyEnvelope({
      observatoryId,
      envelope: envelopeFor(MEASURED, provenance),
      actorUserId: operatorId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
  });

  it("accepts null without provenance, because unmeasured is the shipped state", async () => {
    const result = await setSafetyEnvelope({
      observatoryId,
      envelope: envelopeFor(null),
      actorUserId: operatorId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.maxAltitudeDegrees).toBeNull();
  });

  it("accepts a measurement that carries its provenance", async () => {
    const result = await setSafetyEnvelope({
      observatoryId,
      envelope: envelopeFor(MEASURED, {
        maxAltitudeMeasuredAt: NOW.toISOString(),
        maxAltitudeMeasuredBy: "Beka Tsertsvadze",
        maxAltitudeMeasurementNote: "Clearance 21 mm at 78 degrees, power off.",
      }),
      actorUserId: operatorId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.maxAltitudeDegrees).toBe(MEASURED);
    expect(result.envelope.maxAltitudeMeasuredBy).toBe("Beka Tsertsvadze");
    expect(() => zSafetyEnvelopeConfig.parse(result.envelope)).not.toThrow();
  });

  it("names both gaps at once rather than one at a time", () => {
    expect(provenanceGapsOf(envelopeFor(MEASURED) as never)).toEqual([
      "maxAltitudeMeasuredAt",
      "maxAltitudeMeasuredBy",
    ]);
  });
});

describe("storing the survey", () => {
  it("replaces the mask wholesale instead of merging surveys", async () => {
    await setSafetyEnvelope({
      observatoryId,
      envelope: envelopeFor(null),
      actorUserId: operatorId,
    });

    await setSafetyEnvelope({
      observatoryId,
      envelope: envelopeFor(null, {
        horizonMask: [{ azimuthDegrees: 90, minAltitudeDegrees: 31 }],
        forbiddenAzimuthSectors: [],
      }),
      actorUserId: operatorId,
    });

    const stored = await loadSafetyEnvelope(observatoryId);
    // One bearing, not three. A survey is one document, and a horizon built from
    // two of them describes a site that does not exist.
    expect(stored?.horizonMask).toEqual([{ azimuthDegrees: 90, minAltitudeDegrees: 31 }]);
    expect(stored?.forbiddenAzimuthSectors).toEqual([]);
  });

  it("tells the agent, inside the same transaction as the write", async () => {
    await setSafetyEnvelope({
      observatoryId,
      envelope: envelopeFor(null),
      actorUserId: operatorId,
    });

    const notification = await nextEnvelopeNotification();
    expect(notification).toEqual({ kind: "ENVELOPE", observatoryId });
  });

  it("refuses an envelope for an observatory that does not exist", async () => {
    const result = await setSafetyEnvelope({
      observatoryId: randomUUID(),
      envelope: envelopeFor(null),
      actorUserId: operatorId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });
});
