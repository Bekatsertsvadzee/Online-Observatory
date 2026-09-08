import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

const { startMissionSession, revokeMissionSession } =
  await import("@/features/missions/session");
const { mintMissionCommand } = await import("@/features/missions/command");
const { setSafetyEnvelope } = await import("@/features/admin/safety-envelope");
const { listAuditEvents } = await import("@/features/audit/logs");
const { listMissionEvents } = await import("@/features/missions/events");
const { zAuditEventPage, zMissionEventPage } = await import("@darkview/contracts/zod");

/**
 * DV-062 against a real PostgreSQL instance.
 *
 * What cannot be tested any other way: that the audit row and the fact it
 * describes share a transaction, that a keyset cursor pages an append-only table
 * without repeating or skipping, and that the foreign keys hold.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

/** The same instant the DV-058 suite uses, and for the same reason: M13 is up. */
const NOW = new Date("2026-07-15T20:00:00.000Z");

/** A stand-in for MAX_ALT_SAFE, which DV-034 measures. NAMED A FAKE BECAUSE IT IS ONE. */
const FAKE_MEASURED_MAX_ALTITUDE_DEGREES = 78;

let database: PrismaClient;
let observatoryId: string;
let telescopeId: string;
let targetId: string;
let missionId: string;
let ownerId: string;
let operatorId: string;

function envelopeFor(maxAltitude: number | null) {
  return {
    observatoryId,
    minAltitudeDegrees: 20,
    maxAltitudeDegrees: maxAltitude,
    maxAltitudeMeasuredAt: maxAltitude === null ? null : NOW.toISOString(),
    maxAltitudeMeasuredBy: maxAltitude === null ? null : "integration-test fake",
    maxAltitudeMeasurementNote: null,
    horizonMask: [],
    forbiddenAzimuthSectors: [],
    sunExclusionDegrees: 30,
    daylightLockSunAltitudeDegrees: -6,
    nudgeMaxDegrees: 1,
    nudgeRateDegreesPerSecond: 0.25,
    slewTimeoutSeconds: 120,
    heartbeatLossSeconds: 15,
    linkDeadSeconds: 60,
    refocusTemperatureDeltaC: 1.5,
    updatedAt: NOW.toISOString(),
  } as never;
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
  // Captures first. Capture holds Restrict foreign keys to Mission, Target,
  // Telescope, Observatory and User, so a capture left behind by another suite
  // blocks every delete below it -- and these suites share one database.
  await database.capture.deleteMany();
  await database.auditLog.deleteMany();
  await database.missionEvent.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  await database.safetyEnvelope.deleteMany();
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
      name: "NexStar 6SE",
      manufacturer: "Celestron",
      model: "NexStar 6SE",
      apertureMm: 150,
      focalLengthMm: 1500,
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

  const owner = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Owner", emailVerifiedAt: NOW },
  });
  ownerId = owner.id;

  const operator = await database.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      name: "Operator",
      role: "OPERATOR",
      emailVerifiedAt: NOW,
    },
  });
  operatorId = operator.id;

  const mission = await database.mission.create({
    data: { userId: ownerId, targetId, observatoryId, telescopeId, state: "OBSERVING" },
  });
  missionId = mission.id;

  await setSafetyEnvelope({
    observatoryId,
    envelope: envelopeFor(FAKE_MEASURED_MAX_ALTITUDE_DEGREES),
    actorUserId: operatorId,
  });
  await database.auditLog.deleteMany();
});

describe("what the cloud writes down while a mission runs", () => {
  it("records the session, the command and their correlation", async () => {
    const session = await startMissionSession({
      missionId,
      actor: { id: ownerId, role: "USER" },
      now: NOW,
    });
    expect(session.ok).toBe(true);

    const minted = await mintMissionCommand({
      missionId,
      request: {
        type: "NUDGE",
        nudge: { kind: "NUDGE", axis: "ALTITUDE", stepArcminutes: 5 },
      } as never,
      actor: { id: ownerId, role: "USER" },
      now: NOW,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const page = await listAuditEvents({ missionId, limit: 20 });
    expect(() => zAuditEventPage.parse(page)).not.toThrow();

    // Newest first: the command, then the session that authorised it.
    expect(page.items.map((event) => event.action)).toEqual([
      "COMMAND_MINTED",
      "MISSION_SESSION_OPENED",
    ]);
    expect(page.items[0]?.commandId).toBe(minted.accepted.commandId);
    expect(page.items[0]?.actorUserId).toBe(ownerId);
  });

  it("records a command the cloud refused, which never became a row of its own", async () => {
    await startMissionSession({
      missionId,
      actor: { id: ownerId, role: "USER" },
      now: NOW,
    });

    // Unmeasured: while MAX_ALT_SAFE is null every slew is refused, by the cloud
    // and independently by the agent.
    await setSafetyEnvelope({
      observatoryId,
      envelope: envelopeFor(null),
      actorUserId: operatorId,
    });

    const refused = await mintMissionCommand({
      missionId,
      request: { type: "RECENTER" } as never,
      actor: { id: ownerId, role: "USER" },
      now: NOW,
    });
    expect(refused.ok).toBe(false);

    const page = await listAuditEvents({ missionId, category: "SAFETY", limit: 20 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.action).toBe("COMMAND_REFUSED_BY_CLOUD");
    expect(page.items[0]?.detail).toMatchObject({
      rejectionReason: "SAFETY_ENVELOPE_UNMEASURED",
    });

    // And no command row exists, which is the whole reason the refusal needed a
    // row of its own: otherwise the only trace would be an HTTP status.
    expect(await database.observatoryCommand.count()).toBe(0);
  });

  it("names how the measured maximum altitude moved", async () => {
    await setSafetyEnvelope({
      observatoryId,
      envelope: envelopeFor(null),
      actorUserId: operatorId,
    });
    await setSafetyEnvelope({
      observatoryId,
      envelope: envelopeFor(FAKE_MEASURED_MAX_ALTITUDE_DEGREES),
      actorUserId: operatorId,
    });

    const page = await listAuditEvents({ category: "SAFETY", limit: 20 });
    expect(page.items.map((event) => event.detail?.measurementTransition)).toEqual([
      "UNMEASURED_TO_MEASURED",
      "MEASURED_TO_UNMEASURED",
    ]);
    expect(page.items[0]?.actorUserId).toBe(operatorId);
  });

  it("records the revocation that ends the session", async () => {
    await startMissionSession({
      missionId,
      actor: { id: ownerId, role: "USER" },
      now: NOW,
    });
    await revokeMissionSession({ missionId, reason: "OPERATOR_ABORT", now: NOW });

    const page = await listAuditEvents({ missionId, category: "MISSION", limit: 20 });
    expect(page.items.map((event) => event.action)).toEqual([
      "MISSION_SESSION_REVOKED",
      "MISSION_SESSION_OPENED",
    ]);
  });
});

describe("paging the trail", () => {
  it("walks an append-only table without repeating or skipping a row", async () => {
    for (let index = 0; index < 7; index += 1) {
      await database.auditLog.create({
        data: {
          category: "AGENT_LINK",
          action: "AGENT_LINK_UP",
          entityType: "Observatory",
          entityId: observatoryId,
          metadata: { index },
        },
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await listAuditEvents({ limit: 3, cursor });
      seen.push(...page.items.map((event) => event.id));
      if (!page.page.hasMore) break;
      cursor = page.page.nextCursor ?? undefined;
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });
});

describe("a mission's own trail", () => {
  it("reads back in the observatory's order, with its correlations intact", async () => {
    const session = await database.missionSession.create({
      data: {
        missionId,
        userId: ownerId,
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30 * 60_000),
      },
    });

    const command = await database.observatoryCommand.create({
      data: {
        id: randomUUID(),
        missionId,
        sessionId: session.id,
        userId: ownerId,
        observatoryId,
        type: "NUDGE",
        status: "COMPLETED",
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30_000),
      },
    });

    // Written out of order on purpose: the trail is ordered by the observatory's
    // clock, not by the moment the cloud happened to receive each event.
    await database.missionEvent.create({
      data: {
        missionId,
        state: "CENTERING",
        source: "AGENT",
        commandId: command.id,
        occurredAt: new Date(NOW.getTime() + 60_000),
      },
    });
    await database.missionEvent.create({
      data: { missionId, state: "SLEWING", source: "AGENT", occurredAt: NOW },
    });

    const result = await listMissionEvents({
      missionId,
      actor: { id: ownerId, role: "USER" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => zMissionEventPage.parse(result.page)).not.toThrow();
    expect(result.page.items.map((event) => event.state)).toEqual([
      "SLEWING",
      "CENTERING",
    ]);
    expect(result.page.items[1]?.commandId).toBe(command.id);
  });
});
