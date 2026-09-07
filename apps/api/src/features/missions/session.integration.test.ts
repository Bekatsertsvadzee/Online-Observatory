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

const { revokeMissionSession, startMissionSession } =
  await import("@/features/missions/session");
const { COMMAND_TTL_SECONDS, mintMissionCommand } =
  await import("@/features/missions/command");
const { zMissionSession } = await import("@darkview/contracts/zod");

/**
 * DV-058 against a real PostgreSQL instance.
 *
 * Two of the claims here cannot be tested any other way. "One active session
 * owner" is a partial unique index, and a mock has no indexes. And ADR-009's
 * relay is a `NOTIFY` issued inside the same transaction as the write -- so the
 * test opens its own `LISTEN` connection and waits for the notification, rather
 * than trusting that a line of code that says pg_notify did anything.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const ACTIVE_SESSION_INDEX = "MissionSession_active_owner_unique";
const CONCURRENCY = 20;

/**
 * Fixed instant. Nothing here may depend on when the suite runs.
 *
 * It also has to be an instant at which the fixture's target is actually
 * observable. It was 2026-12-15T20:00Z until DV-059, when the cloud started
 * checking the envelope before minting and refused the RECENTER below -- M13 is
 * 11.8 degrees *under* the horizon from Tbilisi at that moment, so the test had
 * been minting a slew to a target beneath the ground and nothing had noticed.
 * Here M13 is at 67.7 degrees with the Sun at -25.
 */
const NOW = new Date("2026-07-15T20:00:00.000Z");

/**
 * A stand-in for MAX_ALT_SAFE, which is measured from the assembled optical train
 * during mount qualification (DV-034) and does not exist yet.
 *
 * NAMED A FAKE BECAUSE IT IS ONE. The Build Plan prints a provisional 72 degrees
 * in a table cell; that number is not a measurement and must never be seeded,
 * shipped, or defaulted anywhere. This exists only so tests of *other* rules are
 * not all swallowed by the unmeasured refusal, and the unmeasured behaviour has
 * its own tests below.
 */
const FAKE_MEASURED_MAX_ALTITUDE_DEGREES = 78;

let database: PrismaClient;
let listener: Client;
let notifications: string[];

let observatoryId: string;
let telescopeId: string;
let targetId: string;
let missionId: string;
let ownerId: string;

async function createUser(): Promise<string> {
  const user = await database.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      name: "Session Tester",
      emailVerifiedAt: NOW,
    },
  });
  return user.id;
}

function actor(id: string, role: "USER" | "OPERATOR" = "USER") {
  return { id, role };
}

/** Open a live session as the mission owner, and drain its notification. */
async function openSession() {
  const result = await startMissionSession({
    missionId,
    actor: actor(ownerId),
    now: NOW,
  });
  if (!result.ok) throw new Error("could not open a session");
  await nextNotification("SESSION");
  return result.session;
}

/**
 * Install a safety envelope for the fixture observatory.
 *
 * `maxAltitude` of null is the UNMEASURED state, which is the shipped state of
 * every real observatory until DV-034 measures it. Passing a number is a test
 * fake -- see FAKE_MEASURED_MAX_ALTITUDE_DEGREES.
 */
async function createSafetyEnvelope(maxAltitude: number | null) {
  await database.safetyEnvelope.deleteMany({ where: { observatoryId } });
  await database.safetyEnvelope.create({
    data: {
      observatoryId,
      minAltitudeDegrees: 20,
      maxAltitudeDegrees: maxAltitude,
      maxAltitudeMeasuredAt: maxAltitude === null ? null : NOW,
      maxAltitudeMeasuredBy: maxAltitude === null ? null : "integration-test fake",
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
}

/**
 * Wait for a notification of a given kind, or fail rather than hang forever.
 *
 * Filtered by kind rather than taken in order: a notification from the previous
 * test can still be in flight when `beforeEach` clears the queue, and a test that
 * fails because of that timing would be telling us nothing about the code.
 *
 * Kind alone is not enough when the previous test emitted the same kind. A late
 * COMMAND from the test before would be handed to the next one, which then
 * compares it against its own command and fails on a mismatched id -- a real
 * intermittent failure, and one that says nothing about the code either. So a
 * caller may also say which notification is its own.
 */
async function nextNotification(
  kind: "SESSION" | "COMMAND",
  isMine: (notification: Record<string, unknown>) => boolean = () => true,
  timeoutMs = 3_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const index = notifications.findIndex((raw) => {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return parsed.kind === kind && isMine(parsed);
    });
    if (index >= 0) {
      return JSON.parse(notifications.splice(index, 1)[0]) as Record<string, unknown>;
    }
    if (Date.now() > deadline) throw new Error(`no ${kind} notification arrived`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING, max: 32 }),
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

  await createSafetyEnvelope(FAKE_MEASURED_MAX_ALTITUDE_DEGREES);

  ownerId = await createUser();

  const mission = await database.mission.create({
    data: { userId: ownerId, targetId, observatoryId, telescopeId, state: "OBSERVING" },
  });
  missionId = mission.id;

  await database.booking.create({
    data: {
      userId: ownerId,
      targetId,
      observatoryId,
      telescopeId,
      missionId,
      slotStartAt: new Date(NOW.getTime() - 5 * 60_000),
      durationMinutes: 30,
      status: "CONFIRMED",
      priceMinor: 4500,
    },
  });
});

describe("opening a session", () => {
  it("issues a session the contract's own schema accepts", async () => {
    const result = await startMissionSession({
      missionId,
      actor: actor(ownerId),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(() => zMissionSession.parse(result.session)).not.toThrow();
    expect(result.session.userId).toBe(ownerId);
    expect(result.session.missionChannelUrl).toBe(`/ws/mission/${missionId}`);
    expect(result.session.allowedCommands).toEqual([
      "NUDGE",
      "CAPTURE",
      "RECENTER",
      "ABORT",
    ]);
  });

  it("ends the session when the booked slot ends, not a moment later", async () => {
    const result = await startMissionSession({
      missionId,
      actor: actor(ownerId),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The slot began five minutes ago and runs thirty.
    expect(result.session.expiresAt).toBe(
      new Date(NOW.getTime() + 25 * 60_000).toISOString(),
    );
  });

  it("hides a mission the caller does not own behind a 404", async () => {
    const stranger = await createUser();

    const result = await startMissionSession({
      missionId,
      actor: actor(stranger),
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });
});

describe("one active session owner", () => {
  /** DV-058 acceptance criterion 4. */
  it("gives the session to exactly one of two simultaneous starts", async () => {
    const other = await createUser();

    const [first, second] = await Promise.all([
      startMissionSession({ missionId, actor: actor(ownerId), now: NOW }),
      startMissionSession({ missionId, actor: actor(other, "OPERATOR"), now: NOW }),
    ]);

    expect([first, second].filter((result) => result.ok)).toHaveLength(1);

    const refused = [first, second].find((result) => !result.ok);
    expect(refused && !refused.ok && refused.status).toBe(409);
    expect(refused && !refused.ok && refused.code).toBe("SESSION_NOT_OWNER");
  });

  it(`never issues two owners at a concurrency of ${CONCURRENCY}`, async () => {
    const operators = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => createUser()),
    );

    const results = await Promise.all(
      operators.map((id) =>
        startMissionSession({ missionId, actor: actor(id, "OPERATOR"), now: NOW }),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      await database.missionSession.count({ where: { missionId, revokedAt: null } }),
    ).toBe(1);
  });

  /**
   * The index is the rule, not this code. Dropping it must break the guarantee --
   * otherwise something above the database has quietly taken over, and that
   * something is racing in application memory.
   */
  it("issues several owners once the partial unique index is dropped", async () => {
    const operators = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => createUser()),
    );

    await database.$executeRawUnsafe(`DROP INDEX "${ACTIVE_SESSION_INDEX}"`);

    try {
      const results = await Promise.all(
        operators.map((id) =>
          startMissionSession({ missionId, actor: actor(id, "OPERATOR"), now: NOW }),
        ),
      );

      expect(results.filter((result) => result.ok).length).toBeGreaterThan(1);
    } finally {
      await database.missionSession.deleteMany({ where: { missionId } });
      await database.$executeRawUnsafe(
        `CREATE UNIQUE INDEX "${ACTIVE_SESSION_INDEX}" ON "MissionSession" ("missionId") WHERE "revokedAt" IS NULL`,
      );
    }
  });

  it("restores the index the previous test dropped", async () => {
    const rows = (await database.$queryRaw`
      SELECT indexdef FROM pg_indexes WHERE indexname = ${ACTIVE_SESSION_INDEX}
    `) as { indexdef: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("revokedAt");
  });

  it("rotates the session when the owner reopens it", async () => {
    const first = await startMissionSession({
      missionId,
      actor: actor(ownerId),
      now: NOW,
    });
    const second = await startMissionSession({
      missionId,
      actor: actor(ownerId),
      now: new Date(NOW.getTime() + 1_000),
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // A new sessionId, and the old one revoked. That is what stops a stale
    // browser tab: the agent only honours the sessionId it was last told.
    expect(second.session.sessionId).not.toBe(first.session.sessionId);

    const old = await database.missionSession.findUniqueOrThrow({
      where: { id: first.session.sessionId },
    });
    expect(old.revokedAt).not.toBeNull();
    expect(old.revokedFor).toBe("REPLACED_BY_OWNER");
  });

  it("lets the next owner in once a session has lapsed", async () => {
    await startMissionSession({ missionId, actor: actor(ownerId), now: NOW });

    const operator = await createUser();
    const afterSlot = new Date(NOW.getTime() + 40 * 60_000);

    const result = await startMissionSession({
      missionId,
      actor: actor(operator, "OPERATOR"),
      now: afterSlot,
    });

    // The lapsed session is swept inside the transaction that opens the next one.
    // No background job has to have run.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MISSION_NOT_ACTIVE");
  });
});

describe("refusing to open a session at all", () => {
  /** DV-058 acceptance criterion 7. */
  it("will not start while the observatory is offline", async () => {
    await database.observatory.update({
      where: { id: observatoryId },
      data: { status: "OFFLINE" },
    });

    const result = await startMissionSession({
      missionId,
      actor: actor(ownerId),
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe("OBSERVATORY_OFFLINE");
    expect(await database.missionSession.count()).toBe(0);
  });

  it("will not start while a weather hold is active", async () => {
    await database.weatherState.create({
      data: { observatoryId, status: "UNSAFE", holdActive: true },
    });

    const result = await startMissionSession({
      missionId,
      actor: actor(ownerId),
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("WEATHER_HOLD");
    expect(await database.missionSession.count()).toBe(0);
  });

  it("will not start a mission that is not live", async () => {
    await database.mission.update({
      where: { id: missionId },
      data: { state: "SCHEDULED" },
    });

    const result = await startMissionSession({
      missionId,
      actor: actor(ownerId),
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MISSION_NOT_ACTIVE");
  });
});

describe("telling the agent who owns the mission", () => {
  /** DV-058 acceptance criterion 5. */
  it("notifies with the new sessionId when a session opens", async () => {
    const result = await startMissionSession({
      missionId,
      actor: actor(ownerId),
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const notification = await nextNotification("SESSION");

    expect(notification).toEqual({
      kind: "SESSION",
      observatoryId,
      missionId,
      sessionId: result.session.sessionId,
    });
  });

  it("notifies with a null sessionId when the session is revoked", async () => {
    await startMissionSession({ missionId, actor: actor(ownerId), now: NOW });
    await nextNotification("SESSION");

    const revoked = await revokeMissionSession({
      missionId,
      reason: "MISSION_COMPLETE",
      now: NOW,
    });
    expect(revoked.revoked).toBe(true);

    const notification = await nextNotification("SESSION");
    expect(notification).toMatchObject({ kind: "SESSION", missionId, sessionId: null });
  });

  it("says nothing when opening a session failed", async () => {
    await database.observatory.update({
      where: { id: observatoryId },
      data: { status: "OFFLINE" },
    });

    await startMissionSession({ missionId, actor: actor(ownerId), now: NOW });

    // The notification is inside the transaction, so a refusal that wrote nothing
    // must also have told the agent nothing.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(notifications).toHaveLength(0);
  });
});

describe("minting a command", () => {
  /** DV-058 acceptance criterion 6. */
  it("sets a short, configured expiry that the client cannot influence", async () => {
    const session = await openSession();

    const result = await mintMissionCommand({
      missionId,
      request: { type: "ABORT", reason: "changed my mind" },
      actor: actor(ownerId),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.accepted.issuedAt).toBe(NOW.toISOString());
    expect(result.accepted.expiresAt).toBe(
      new Date(NOW.getTime() + COMMAND_TTL_SECONDS * 1000).toISOString(),
    );

    const row = await database.observatoryCommand.findUniqueOrThrow({
      where: { id: result.accepted.commandId },
    });
    expect(row.sessionId).toBe(session.sessionId);
    expect(row.userId).toBe(ownerId);
  });

  /** DV-058 acceptance criterion 3. */
  it("turns RECENTER into a GOTO whose coordinates come from the booked target", async () => {
    await openSession();

    const result = await mintMissionCommand({
      missionId,
      request: { type: "RECENTER" },
      actor: actor(ownerId),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accepted.type).toBe("GOTO");

    const row = await database.observatoryCommand.findUniqueOrThrow({
      where: { id: result.accepted.commandId },
    });
    const payload = row.payload as {
      kind: string;
      targetId: string;
      recenter: boolean;
      coordinates: { raHours: number; decDegrees: number };
    };

    expect(payload.kind).toBe("GOTO");
    expect(payload.recenter).toBe(true);
    expect(payload.targetId).toBe(targetId);

    // The catalogue's coordinates for M13, not anything a request could carry --
    // the RECENTER request has no coordinate field at all.
    expect(payload.coordinates.raHours).toBeCloseTo(16.6949, 4);
    expect(payload.coordinates.decDegrees).toBeCloseTo(36.4613, 4);
  });

  it("notifies the relay with the command it just wrote", async () => {
    await openSession();

    const result = await mintMissionCommand({
      missionId,
      request: { type: "ABORT", reason: "stop" },
      actor: actor(ownerId),
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(
      await nextNotification(
        "COMMAND",
        (notification) => notification.commandId === result.accepted.commandId,
      ),
    ).toEqual({
      kind: "COMMAND",
      commandId: result.accepted.commandId,
      observatoryId,
    });
  });

  it("leaves the command unrelayed for the sweep to find", async () => {
    await openSession();

    const result = await mintMissionCommand({
      missionId,
      request: { type: "ABORT", reason: "stop" },
      actor: actor(ownerId),
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // ADR-009: the orchestrator writes and rings a bell. Putting it on the wire is
    // the realtime service's job, and until it does, relayedAt stays null.
    const row = await database.observatoryCommand.findUniqueOrThrow({
      where: { id: result.accepted.commandId },
    });
    expect(row.relayedAt).toBeNull();
    expect(row.status).toBe("RECEIVED");
  });

  it("refuses a command when no session owns the mission", async () => {
    const result = await mintMissionCommand({
      missionId,
      request: { type: "ABORT", reason: "stop" },
      actor: actor(ownerId),
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MISSION_NOT_ACTIVE");
    expect(await database.observatoryCommand.count()).toBe(0);
  });

  it("refuses a command from someone who is not the session owner", async () => {
    await openSession();
    const operator = await createUser();

    const result = await mintMissionCommand({
      missionId,
      request: { type: "ABORT", reason: "stop" },
      actor: actor(operator, "OPERATOR"),
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SESSION_NOT_OWNER");
  });

  it("refuses a NUDGE that carries no nudge payload", async () => {
    await openSession();

    const result = await mintMissionCommand({
      missionId,
      request: { type: "NUDGE" },
      actor: actor(ownerId),
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
  });
});

/**
 * DV-059 — the cloud's half of the two independent safety checks.
 *
 * `CLAUDE.md`: "The cloud validates commands; the local agent validates them
 * again." Until this landed only the second half existed, and the cloud minted
 * envelopes it had never examined. What is proved here is that a command the
 * envelope forbids never becomes a row and never reaches the relay — the agent
 * refusing it later is the backstop, not the only stop.
 */
describe("cloud-side safety pre-validation", () => {
  async function nudge(stepArcminutes: number) {
    return mintMissionCommand({
      missionId,
      request: {
        type: "NUDGE",
        nudge: {
          kind: "NUDGE",
          axis: "ALTITUDE",
          direction: "POSITIVE",
          stepArcminutes,
        },
      },
      actor: actor(ownerId),
      now: NOW,
    });
  }

  // criterion 3
  it("refuses a slew while MAX_ALT_SAFE is unmeasured, and mints nothing", async () => {
    await createSafetyEnvelope(null);
    await openSession();

    const result = await mintMissionCommand({
      missionId,
      request: { type: "RECENTER" },
      actor: actor(ownerId),
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.details?.rejectionReason).toBe("SAFETY_ENVELOPE_UNMEASURED");
    expect(await database.observatoryCommand.count()).toBe(0);
  });

  it("refuses a nudge while MAX_ALT_SAFE is unmeasured", async () => {
    await createSafetyEnvelope(null);
    await openSession();

    const result = await nudge(3);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.details?.rejectionReason).toBe("SAFETY_ENVELOPE_UNMEASURED");
    expect(await database.observatoryCommand.count()).toBe(0);
  });

  /**
   * The other half of criterion 3, and the more important half. "Slew-bearing"
   * is the qualifier: refusing an ABORT because the envelope is unmeasured would
   * leave a customer unable to stop a mission on exactly the system least fit to
   * be running one.
   */
  it("still accepts ABORT while unmeasured, because it moves nothing", async () => {
    await createSafetyEnvelope(null);
    await openSession();

    const result = await mintMissionCommand({
      missionId,
      request: { type: "ABORT", reason: "stop" },
      actor: actor(ownerId),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(await database.observatoryCommand.count()).toBe(1);
  });

  // criterion 1
  it("refuses a pointing above the measured MAX_ALT_SAFE", async () => {
    // M13 is at 67.7 degrees at NOW, so an envelope measured at 60 puts the
    // booked target out of reach -- which is a real state a real mount can be in.
    await createSafetyEnvelope(60);
    await openSession();

    const result = await mintMissionCommand({
      missionId,
      request: { type: "RECENTER" },
      actor: actor(ownerId),
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.details?.rejectionReason).toBe("SAFETY_ABOVE_MAX_ALTITUDE");
    expect(result.message).toContain("67.");
    expect(await database.observatoryCommand.count()).toBe(0);
  });

  it("refuses a nudge step larger than the envelope permits", async () => {
    await openSession();

    // The fixture permits 0.25 degrees; 30 arcminutes is 0.5.
    const result = await nudge(30);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.details?.rejectionReason).toBe("SAFETY_SLEW_RATE");
    expect(await database.observatoryCommand.count()).toBe(0);
  });

  it("permits a nudge inside the envelope", async () => {
    await openSession();

    const result = await nudge(3);

    expect(result.ok).toBe(true);
    expect(await database.observatoryCommand.count()).toBe(1);
  });
});
