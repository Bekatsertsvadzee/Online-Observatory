import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

const { setObservatoryMode, setWeatherHold } = await import(
  "@/features/admin/observatory"
);
const { issueOperatorOverride } = await import("@/features/admin/override");
const { listAllMissions, cancelMissionAsOperator } = await import(
  "@/features/admin/missions"
);
const { updateTargetAsOperator } = await import("@/features/admin/targets");
const { setSafetyEnvelope } = await import("@/features/admin/safety-envelope");
const { zMissionPage, zTarget, zWeatherState } = await import("@darkview/contracts/zod");

/**
 * DV-063 against a real PostgreSQL instance.
 *
 * Most of what an operator endpoint promises is a database fact: that a mode
 * switch and its audit row share a transaction, that cancelling a mission actually
 * releases Mission_active_per_observatory_unique so the next booking can run, and
 * that an override reaches the command table in a shape the agent would accept.
 * None of those can be shown against a fake.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

/** Night over Tbilisi, so a GOTO is not refused by the daylight lock. */
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

async function openSession() {
  return database.missionSession.create({
    data: {
      missionId,
      userId: ownerId,
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 30 * 60_000),
    },
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
  await database.capture.deleteMany();
  await database.auditLog.deleteMany();
  await database.missionEvent.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  // ObservatoryNetworkNode holds Restrict foreign keys to Observatory and User
  // (ADR-013), so a node left behind blocks every later suite's cleanup.
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
});

describe("switching the observatory to real hardware", () => {
  it("refuses REAL without an attending operator", async () => {
    // CLAUDE.md: real-hardware mode requires an explicit, attended operator action.
    // The field exists so a human has to assert their own presence; nothing here
    // can infer it, and nothing may default it.
    //
    // The mission is ended first so the attendance check is the ONLY thing that
    // can refuse this. With a live mission the mode guard refuses it anyway, and
    // the test would pass with the attendance requirement deleted.
    await database.mission.update({
      where: { id: missionId },
      data: { state: "COMPLETE" },
    });

    const result = await setObservatoryMode({
      observatoryId,
      request: {
        mode: "REAL",
        reason: "first light attempt",
        attendedOperatorPresent: false,
      },
      actorUserId: operatorId,
    });

    expect(result.ok).toBe(false);
    const observatory = await database.observatory.findUniqueOrThrow({
      where: { id: observatoryId },
    });
    expect(observatory.mode).toBe("SIMULATED");
  });

  it("applies REAL when an operator states they are present, and records why", async () => {
    await database.mission.update({
      where: { id: missionId },
      data: { state: "COMPLETE" },
    });

    const result = await setObservatoryMode({
      observatoryId,
      request: {
        mode: "REAL",
        reason: "mount qualification Q4, operator at the pier",
        attendedOperatorPresent: true,
      },
      actorUserId: operatorId,
    });

    expect(result.ok).toBe(true);
    const observatory = await database.observatory.findUniqueOrThrow({
      where: { id: observatoryId },
    });
    expect(observatory.mode).toBe("REAL");

    const audit = await database.auditLog.findFirstOrThrow({
      where: { action: "OBSERVATORY_MODE_CHANGED" },
    });
    expect(audit.category).toBe("OBSERVATORY_MODE");
    expect(audit.actorUserId).toBe(operatorId);
    // Verbatim. A mode switch with no stated cause is indistinguishable
    // afterwards from an accident.
    expect(audit.metadata).toMatchObject({
      from: "SIMULATED",
      to: "REAL",
      reason: "mount qualification Q4, operator at the pier",
      attendedOperatorPresent: true,
    });
  });

  it("refuses to change mode under a live mission", async () => {
    // A session that began against the simulator must not finish against a
    // telescope. The capture it produced could then be honestly labelled neither.
    const result = await setObservatoryMode({
      observatoryId,
      request: { mode: "REAL", reason: "midway switch", attendedOperatorPresent: true },
      actorUserId: operatorId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(
      (await database.observatory.findUniqueOrThrow({ where: { id: observatoryId } }))
        .mode,
    ).toBe("SIMULATED");
  });

  it("writes no audit row when the switch was refused", async () => {
    await database.mission.update({
      where: { id: missionId },
      data: { state: "COMPLETE" },
    });

    await setObservatoryMode({
      observatoryId,
      request: { mode: "REAL", reason: "not present", attendedOperatorPresent: false },
      actorUserId: operatorId,
    });

    expect(await database.auditLog.count({ where: { category: "OBSERVATORY_MODE" } })).toBe(
      0,
    );
  });
});

describe("the operator weather hold", () => {
  it("sets a hold and records it under SAFETY", async () => {
    const result = await setWeatherHold({
      observatoryId,
      request: { holdActive: true, status: "UNSAFE", note: "cloud and rain" },
      actorUserId: operatorId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(zWeatherState.safeParse(result.weather).success).toBe(true);
    // The only writer in Phase 1 is a person. No sensor is fitted.
    expect(result.weather.source).toBe("OPERATOR");

    const audit = await database.auditLog.findFirstOrThrow({
      where: { action: "WEATHER_HOLD_SET" },
    });
    expect(audit.category).toBe("SAFETY");
  });

  it("stops the mission that is already running", async () => {
    // A hold that only refused the next customer would leave the one holding the
    // telescope observing under the sky the operator just called unsafe.
    const session = await openSession();

    const result = await setWeatherHold({
      observatoryId,
      request: { holdActive: true, status: "UNSAFE", note: "rain" },
      actorUserId: operatorId,
      now: NOW,
    });
    expect(result.ok).toBe(true);

    const mission = await database.mission.findUniqueOrThrow({ where: { id: missionId } });
    expect(mission.state).toBe("WEATHER_HOLD");
    expect(mission.failureReason).toBe("WEATHER_UNSAFE");

    const revoked = await database.missionSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(revoked.revokedAt).toEqual(NOW);
  });

  it("parks the mount, naming the session that still owns it", async () => {
    // The Park is minted while the session is still valid. The agent refuses any
    // envelope whose sessionId is not the owner it holds, so a Park issued after
    // the revocation would be refused -- and the mount would keep tracking.
    const session = await openSession();

    await setWeatherHold({
      observatoryId,
      request: { holdActive: true, status: "UNSAFE", note: null },
      actorUserId: operatorId,
      now: NOW,
    });

    const command = await database.observatoryCommand.findFirstOrThrow({
      where: { missionId },
    });
    expect(command.type).toBe("PARK");
    expect(command.sessionId).toBe(session.id);
    expect(command.userId).toBe(ownerId);
  });

  it("files the hold as the cloud's act, with weather as the reason", async () => {
    await openSession();

    await setWeatherHold({
      observatoryId,
      request: { holdActive: true, status: "UNSAFE", note: "cloud closing in" },
      actorUserId: operatorId,
      now: NOW,
    });

    const event = await database.missionEvent.findFirstOrThrow({ where: { missionId } });
    expect(event.source).toBe("CLOUD");
    expect(event.state).toBe("WEATHER_HOLD");
    expect(event.failureReason).toBe("WEATHER_UNSAFE");
    expect(event.message).toBe("cloud closing in");

    const audit = await database.auditLog.findFirstOrThrow({
      where: { action: "WEATHER_HOLD_SET" },
    });
    expect(audit.missionId).toBe(missionId);
    expect(audit.metadata).toMatchObject({ heldMission: missionId });
  });

  it("holds the mission even when no session owns it", async () => {
    // No session means no envelope the agent would accept, so no Park is minted.
    // The mission is still held, and the agent's own idle park takes the mount.
    const result = await setWeatherHold({
      observatoryId,
      request: { holdActive: true, status: "UNSAFE", note: null },
      actorUserId: operatorId,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(
      (await database.mission.findUniqueOrThrow({ where: { id: missionId } })).state,
    ).toBe("WEATHER_HOLD");
    expect(await database.observatoryCommand.count()).toBe(0);
  });

  it("does not stop a running mission when the hold is being cleared", async () => {
    // An operator clearing a hold that is already clear -- a second click, a
    // client retry -- must not take down the session that started since. Only
    // setting a hold reaches a running mission.
    await openSession();

    await setWeatherHold({
      observatoryId,
      request: { holdActive: false, status: "CLEAR", note: null },
      actorUserId: operatorId,
      now: NOW,
    });

    const mission = await database.mission.findUniqueOrThrow({ where: { id: missionId } });
    expect(mission.state).toBe("OBSERVING");
    expect(await database.observatoryCommand.count()).toBe(0);
    expect(await database.missionSession.count({ where: { revokedAt: null } })).toBe(1);
  });

  it("leaves a finished mission alone", async () => {
    await database.mission.update({
      where: { id: missionId },
      data: { state: "COMPLETE" },
    });

    await setWeatherHold({
      observatoryId,
      request: { holdActive: true, status: "UNSAFE", note: null },
      actorUserId: operatorId,
      now: NOW,
    });

    expect(
      (await database.mission.findUniqueOrThrow({ where: { id: missionId } })).state,
    ).toBe("COMPLETE");
    expect(await database.missionEvent.count()).toBe(0);
  });

  it("does not resume anything when the hold is lifted", async () => {
    // Clearing a hold says the sky is safe again. It does not say the customer
    // still wants their session, that their slot has time left, or that the mount
    // is where it was. Resuming is a decision, and nobody has made it.
    await openSession();
    await setWeatherHold({
      observatoryId,
      request: { holdActive: true, status: "UNSAFE", note: null },
      actorUserId: operatorId,
      now: NOW,
    });

    await setWeatherHold({
      observatoryId,
      request: { holdActive: false, status: "CLEAR", note: null },
      actorUserId: operatorId,
      now: NOW,
    });

    const mission = await database.mission.findUniqueOrThrow({ where: { id: missionId } });
    expect(mission.state).toBe("WEATHER_HOLD");
  });

  it("clears a hold and says so distinctly", async () => {
    await setWeatherHold({
      observatoryId,
      request: { holdActive: true, status: "UNSAFE", note: null },
      actorUserId: operatorId,
    });

    await setWeatherHold({
      observatoryId,
      request: { holdActive: false, status: "CLEAR", note: null },
      actorUserId: operatorId,
    });

    const state = await database.weatherState.findUniqueOrThrow({
      where: { observatoryId },
    });
    expect(state.holdActive).toBe(false);
    expect(state.status).toBe("CLEAR");
    expect(await database.auditLog.count({ where: { action: "WEATHER_HOLD_CLEARED" } })).toBe(
      1,
    );
  });
});

describe("the operator override", () => {
  it("relays a PARK even while the safety envelope is UNMEASURED", async () => {
    // The whole point. Park is the answer to every unresolved condition; refusing
    // it because the envelope is unmeasured would strand a telescope in exactly
    // the situation Park exists to resolve. This is also the state the observatory
    // ships in, so if this failed the emergency stop would never have worked.
    await setSafetyEnvelope({
      observatoryId,
      envelope: envelopeFor(null),
      actorUserId: operatorId,
    });
    await openSession();

    const result = await issueOperatorOverride({
      request: {
        missionId,
        type: "PARK",
        payload: { kind: "PARK" },
        reason: "mount making a noise, stopping now",
      },
      operator: { id: operatorId },
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const command = await database.observatoryCommand.findUniqueOrThrow({
      where: { id: result.accepted.commandId },
    });
    expect(command.type).toBe("PARK");
    expect(command.observatoryId).toBe(observatoryId);
  });

  it("names the session's owner as userId, and the operator separately", async () => {
    // The agent refuses any envelope whose userId is not the session owner it
    // holds. An override that put the operator's id there would be refused at the
    // observatory -- which is the opposite of what an emergency stop must do.
    await setSafetyEnvelope({
      observatoryId,
      envelope: envelopeFor(FAKE_MEASURED_MAX_ALTITUDE_DEGREES),
      actorUserId: operatorId,
    });
    const session = await openSession();

    const result = await issueOperatorOverride({
      request: {
        missionId,
        type: "PARK",
        payload: { kind: "PARK" },
        reason: "stopping the mount",
      },
      operator: { id: operatorId },
      now: NOW,
    });
    if (!result.ok) throw new Error("expected the override to be relayed");

    const command = await database.observatoryCommand.findUniqueOrThrow({
      where: { id: result.accepted.commandId },
    });
    expect(command.userId).toBe(ownerId);
    expect(command.sessionId).toBe(session.id);

    const audit = await database.auditLog.findFirstOrThrow({
      where: { action: "OPERATOR_OVERRIDE_ISSUED" },
    });
    expect(audit.category).toBe("OPERATOR_OVERRIDE");
    expect(audit.actorUserId).toBe(operatorId);
    expect(audit.commandId).toBe(result.accepted.commandId);
    expect(audit.metadata).toMatchObject({
      outcome: "RELAYED",
      reason: "stopping the mount",
      sessionOwnerId: ownerId,
    });
  });

  it("refuses a GOTO that points at the Sun, and records the refusal", async () => {
    // The Sun exclusion is never overridable. There is no flag on this path that
    // reaches it, and the agent would refuse it independently regardless.
    await setSafetyEnvelope({
      observatoryId,
      envelope: envelopeFor(FAKE_MEASURED_MAX_ALTITUDE_DEGREES),
      actorUserId: operatorId,
    });
    await openSession();

    // The Sun's own position at NOW, in equatorial coordinates: mid-July, so the
    // Sun sits near 7.6h RA and +21.5 deg declination.
    const result = await issueOperatorOverride({
      request: {
        missionId,
        type: "GOTO",
        payload: {
          kind: "GOTO",
          targetId,
          coordinates: { raHours: 7.6, decDegrees: 21.5, epoch: "J2000" },
          opticalConfig: "F10_NATIVE",
          imagingProfile: "GLOBULAR_CLUSTER",
        },
        reason: "operator insists on this pointing",
      },
      operator: { id: operatorId },
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.details?.rejectionReason).toBe("SAFETY_SUN_EXCLUSION");
    expect(await database.observatoryCommand.count()).toBe(0);

    // A refused override leaves no command row, so without the audit the only
    // trace would be an HTTP status nobody kept.
    const audit = await database.auditLog.findFirstOrThrow({
      where: { action: "OPERATOR_OVERRIDE_ISSUED" },
    });
    expect(audit.metadata).toMatchObject({ outcome: "REFUSED_BY_CLOUD" });
  });

  it("refuses a PARK carrying a GOTO payload", async () => {
    // The contract requires payload.kind to equal type. Without that check, the
    // recovery exemption -- which exists so a Park is never refused on envelope
    // grounds -- would wave a slew past the safety pre-check under a Park's name.
    // An operator override is the one path that takes both fields from a request.
    await setSafetyEnvelope({
      observatoryId,
      envelope: envelopeFor(FAKE_MEASURED_MAX_ALTITUDE_DEGREES),
      actorUserId: operatorId,
    });
    await openSession();

    const result = await issueOperatorOverride({
      request: {
        missionId,
        type: "PARK",
        payload: {
          kind: "GOTO",
          targetId,
          coordinates: { raHours: 7.6, decDegrees: 21.5, epoch: "J2000" },
          opticalConfig: "F10_NATIVE",
          imagingProfile: "GLOBULAR_CLUSTER",
        },
        reason: "a slew wearing a park's name",
      },
      operator: { id: operatorId },
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(await database.observatoryCommand.count()).toBe(0);
  });

  it("refuses a standalone override rather than inventing an envelope for it", async () => {
    // OperatorOverrideRequest.missionId is nullable; CommandEnvelope requires a
    // missionId and a sessionId, and the agent rejects an envelope naming neither.
    // A contract conflict, reported rather than filled in with a sentinel.
    const result = await issueOperatorOverride({
      request: {
        missionId: null,
        type: "PARK",
        payload: { kind: "PARK" },
        reason: "maintenance park with no mission",
      },
      operator: { id: operatorId },
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(result.details?.contractConflict).toBeDefined();
    expect(await database.observatoryCommand.count()).toBe(0);
  });

  it("refuses an override on a mission that is not live", async () => {
    await database.mission.update({
      where: { id: missionId },
      data: { state: "COMPLETE" },
    });

    const result = await issueOperatorOverride({
      request: {
        missionId,
        type: "PARK",
        payload: { kind: "PARK" },
        reason: "too late for this one",
      },
      operator: { id: operatorId },
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
  });
});

describe("cancelling a mission by hand", () => {
  it("releases the observatory so the next mission can run", async () => {
    // Mission_active_per_observatory_unique allows one live mission per
    // observatory and there is deliberately no automatic timeout. Before the
    // cancel the index refuses a second; afterwards it does not. That is the
    // actual thing this endpoint exists to do.
    await expect(
      database.mission.create({
        data: { userId: ownerId, targetId, observatoryId, telescopeId, state: "OBSERVING" },
      }),
    ).rejects.toThrow();

    const result = await cancelMissionAsOperator({
      missionId,
      request: { reason: "customer asked to stop", resolution: "REFUND" },
      operatorId,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    const next = await database.mission.create({
      data: { userId: ownerId, targetId, observatoryId, telescopeId, state: "OBSERVING" },
    });
    expect(next.id).toBeDefined();
  });

  it("revokes the session so the agent stops accepting its commands", async () => {
    const session = await openSession();

    await cancelMissionAsOperator({
      missionId,
      request: { reason: "hardware fault", resolution: "RESCHEDULE" },
      operatorId,
      now: NOW,
    });

    const revoked = await database.missionSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(revoked.revokedAt).toEqual(NOW);
  });

  it("files the cancellation as the operator's act, not the agent's", async () => {
    await cancelMissionAsOperator({
      missionId,
      request: { reason: "roof stuck", resolution: "NONE" },
      operatorId,
      now: NOW,
    });

    const event = await database.missionEvent.findFirstOrThrow({ where: { missionId } });
    expect(event.source).toBe("OPERATOR");
    expect(event.state).toBe("CANCELLED");
    expect(event.failureReason).toBe("OPERATOR_ABORT");

    const audit = await database.auditLog.findFirstOrThrow({
      where: { action: "OPERATOR_MISSION_CANCELLED" },
    });
    expect(audit.metadata).toMatchObject({
      from: "OBSERVING",
      reason: "roof stuck",
      resolution: "NONE",
      wasLive: true,
    });
  });

  it("leaves a mission that already finished exactly as it finished", async () => {
    await database.mission.update({
      where: { id: missionId },
      data: { state: "COMPLETE" },
    });

    const result = await cancelMissionAsOperator({
      missionId,
      request: { reason: "too late", resolution: "NONE" },
      operatorId,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    const mission = await database.mission.findUniqueOrThrow({ where: { id: missionId } });
    expect(mission.state).toBe("COMPLETE");
    expect(await database.auditLog.count({ where: { action: "OPERATOR_MISSION_CANCELLED" } })).toBe(
      0,
    );
  });

  it("lists every mission regardless of who owns it", async () => {
    const page = await listAllMissions({ limit: 20 });

    expect(zMissionPage.safeParse(page).success).toBe(true);
    expect(page.items.map((mission) => mission.id)).toContain(missionId);
  });

  it("filters by state", async () => {
    const observing = await listAllMissions({ state: "OBSERVING", limit: 20 });
    const complete = await listAllMissions({ state: "COMPLETE", limit: 20 });

    expect(observing.items).toHaveLength(1);
    expect(complete.items).toHaveLength(0);
  });
});

describe("tuning a catalogue target", () => {
  it("changes only the fields named", async () => {
    const result = await updateTargetAsOperator({
      targetId,
      request: { enabled: false },
      operatorId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(zTarget.safeParse(result.target).success).toBe(true);
    expect(result.target.enabled).toBe(false);
    // Untouched, and it must be: an operator flipping `enabled` must not silently
    // reset the imaging profile beside it.
    expect(result.target.imagingProfile).toBe("GLOBULAR_CLUSTER");
    expect(result.target.minAltitudeDegrees).toBe(25);
  });

  it("records both sides of every field that moved", async () => {
    await updateTargetAsOperator({
      targetId,
      request: { enabled: false, minAltitudeDegrees: 35 },
      operatorId,
    });

    const audit = await database.auditLog.findFirstOrThrow({
      where: { action: "OPERATOR_TARGET_UPDATED" },
    });
    expect(audit.metadata).toMatchObject({
      changed: {
        enabled: { from: true, to: false },
        minAltitudeDegrees: { from: 25, to: 35 },
      },
    });
  });

  it("refuses an empty body rather than logging a change that was not one", async () => {
    const result = await updateTargetAsOperator({ targetId, request: {}, operatorId });

    expect(result.ok).toBe(false);
    expect(await database.auditLog.count({ where: { action: "OPERATOR_TARGET_UPDATED" } })).toBe(
      0,
    );
  });
});
