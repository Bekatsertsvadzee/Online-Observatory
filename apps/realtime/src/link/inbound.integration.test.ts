import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@darkview/db";

import { AgentLink } from "@/link/agent-link";
import { AgentRelay } from "@/link/agent-relay";
import { createPrismaStore, type RealtimeStore } from "@/link/prisma-store";
import { AgentLinkRegistry } from "@/link/registry";
import { PROTOCOL_VERSION } from "@/link/protocol";
import type { ObservatoryRecord } from "@/link/store";
import { RecordingBroadcast } from "@/mission/fake-broadcast";

/**
 * Issues #25, #26 and #27 against a real PostgreSQL instance.
 *
 * The claim that matters cannot be tested any other way. It is not "the state
 * column is updated" -- it is that a mission left in a live state occupies
 * Mission_active_per_observatory_unique, a partial unique index, and that the
 * observatory then refuses every later mission. A fake store has no indexes, so
 * only this suite can show the lockout, and only this suite fails if the state
 * update is taken back out.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

/** Fixed instant. Nothing here may depend on when the suite runs. */
const NOW = new Date("2026-12-15T20:00:00.000Z");

let database: PrismaClient;
// Both surfaces: the link's, and the mission channel's, which DV-103 reads here.
let store: RealtimeStore;
let broadcast: RecordingBroadcast;

let observatory: ObservatoryRecord;
let telescopeId: string;
let targetId: string;
let ownerId: string;
let missionId: string;

let sent: unknown[];

function makeLink() {
  return new AgentLink(
    observatory,
    store,
    (message) => sent.push(message),
    () => {},
    broadcast,
    () => NOW.getTime(),
  );
}

function hello(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "AGENT_HELLO",
    messageId: randomUUID(),
    sentAt: NOW.toISOString(),
    protocolVersion: PROTOCOL_VERSION,
    observatoryId: observatory.id,
    agentVersion: "0.1.0",
    mode: "SIMULATED",
    bootedAt: NOW.toISOString(),
    safetyEnvelopeConfigured: true,
    resumeMissionId: null,
    ...overrides,
  });
}

/** A second mission at the same observatory, in a state the index covers. */
function startAnotherMission() {
  return database.mission.create({
    data: {
      userId: ownerId,
      targetId,
      observatoryId: observatory.id,
      telescopeId,
      state: "PREPARING",
    },
  });
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING }),
  });
  await database.$queryRaw`SELECT 1`;
  store = createPrismaStore(CONNECTION_STRING);
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(async () => {
  sent = [];
  broadcast = new RecordingBroadcast();

  await database.missionParticipant.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  await database.missionEvent.deleteMany();
  await database.booking.deleteMany();
  await database.mission.deleteMany();
  await database.payment.deleteMany();
  await database.telescope.deleteMany();
  await database.target.deleteMany();
  await database.weatherState.deleteMany();
  await database.agentMessage.deleteMany();
  await database.observatory.deleteMany();
  await database.user.deleteMany();

  const record = await database.observatory.create({
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
  observatory = { id: record.id, slug: record.slug, mode: record.mode };

  const telescope = await database.telescope.create({
    data: {
      observatoryId: observatory.id,
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

  const user = await database.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      name: "Inbound Tester",
      emailVerifiedAt: NOW,
    },
  });
  ownerId = user.id;

  const mission = await database.mission.create({
    data: {
      userId: ownerId,
      targetId,
      observatoryId: observatory.id,
      telescopeId,
      state: "CAPTURING",
    },
  });
  missionId = mission.id;
});

// #25 criterion 6
describe("a completed mission releases the observatory", () => {
  it("lets the next mission start once the agent reports COMPLETE", async () => {
    const link = makeLink();
    await link.receive(hello());

    // Before: the index is occupied and the observatory is shut.
    await expect(startAnotherMission()).rejects.toMatchObject({ code: "P2002" });

    await link.receive(
      JSON.stringify({
        type: "AGENT_MISSION_EVENT",
        messageId: randomUUID(),
        sentAt: NOW.toISOString(),
        missionId,
        state: "COMPLETE",
        failureReason: null,
        occurredAt: NOW.toISOString(),
        commandId: null,
        detail: "stack finished",
      }),
    );

    const after = await database.mission.findUniqueOrThrow({ where: { id: missionId } });
    expect(after.state).toBe("COMPLETE");

    const second = await startAnotherMission();
    expect(second.id).not.toBe(missionId);
  });

  it("writes the event on the agent's clock, not the cloud's", async () => {
    const link = makeLink();
    await link.receive(hello());

    const duringTheOutage = new Date("2026-12-15T19:38:00.000Z");
    await link.receive(
      JSON.stringify({
        type: "AGENT_MISSION_EVENT",
        messageId: randomUUID(),
        sentAt: NOW.toISOString(),
        missionId,
        state: "PROCESSING",
        failureReason: null,
        occurredAt: duringTheOutage.toISOString(),
        commandId: null,
        detail: null,
      }),
    );

    const event = await database.missionEvent.findFirstOrThrow({
      where: { missionId, source: "AGENT" },
    });
    expect(event.occurredAt).toEqual(duringTheOutage);
    // The mission is SIMULATED, so its events are too. `CLAUDE.md`: simulator
    // output is never presented as real telescope output.
    expect(event.simulated).toBe(true);
  });
});

// #26 criterion 6
describe("an agent that restarted mid-mission", () => {
  it("ends the mission it was holding and frees the observatory", async () => {
    const session = await database.missionSession.create({
      data: {
        missionId,
        userId: ownerId,
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30 * 60_000),
      },
    });

    await expect(startAnotherMission()).rejects.toMatchObject({ code: "P2002" });

    const link = makeLink();
    await link.receive(hello({ resumeMissionId: missionId }));

    const after = await database.mission.findUniqueOrThrow({ where: { id: missionId } });
    expect(after.state).toBe("FAILED");
    expect(after.failureReason).toBe("AGENT_LINK_LOST");

    const revoked = await database.missionSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(revoked.revokedAt).toEqual(NOW);
    expect(revoked.revokedFor).toBe("AGENT_LINK_LOST");

    // Who resolved it is part of the trail: the agent reported the id, the cloud
    // decided the outcome.
    const event = await database.missionEvent.findFirstOrThrow({ where: { missionId } });
    expect(event.source).toBe("CLOUD");

    const second = await startAnotherMission();
    expect(second.id).not.toBe(missionId);
  });

  it("is welcomed with expectedMissionId null, and told it owns nothing", async () => {
    const link = makeLink();
    await link.receive(hello({ resumeMissionId: missionId }));

    expect(sent.at(0)).toMatchObject({
      type: "CLOUD_WELCOME",
      expectedMissionId: null,
    });
    expect(sent.at(1)).toMatchObject({
      type: "CLOUD_SESSION_UPDATE",
      missionId,
      sessionId: null,
    });
  });
});

// #27 criterion 6
describe("a command the agent refuses", () => {
  it("carries the refusal and its reason back onto the cloud's row", async () => {
    const session = await database.missionSession.create({
      data: {
        missionId,
        userId: ownerId,
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30 * 60_000),
      },
    });

    const commandId = randomUUID();
    await database.observatoryCommand.create({
      data: {
        id: commandId,
        missionId,
        sessionId: session.id,
        userId: ownerId,
        observatoryId: observatory.id,
        type: "NUDGE",
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30_000),
        payload: {
          kind: "NUDGE",
          axis: "ALTITUDE",
          direction: "POSITIVE",
          stepArcminutes: 3,
        },
      },
    });

    const registry = new AgentLinkRegistry();
    const link = makeLink();
    registry.admit(observatory.id, link);
    await link.receive(hello());

    const relay = new AgentRelay(store, registry, () => NOW);
    expect(await relay.relayCommand(commandId)).toBe("SENT");

    const relayed = await database.observatoryCommand.findUniqueOrThrow({
      where: { id: commandId },
    });
    expect(relayed.status).toBe("EXECUTING");

    // The agent's own envelope check refuses it. The cloud approved this command;
    // the second, independent validation is what stops it.
    const decidedAt = new Date("2026-12-15T20:00:04.000Z");
    await link.receive(
      JSON.stringify({
        type: "AGENT_COMMAND_ACK",
        messageId: randomUUID(),
        sentAt: decidedAt.toISOString(),
        commandId,
        missionId,
        status: "REJECTED",
        rejectionReason: "SAFETY_ABOVE_MAX_ALTITUDE",
        detail: "82.4 deg exceeds MAX_ALT_SAFE 78.0 deg",
      }),
    );

    const refused = await database.observatoryCommand.findUniqueOrThrow({
      where: { id: commandId },
    });
    expect(refused.status).toBe("REJECTED");
    expect(refused.completedAt).toEqual(decidedAt);
    expect(refused.result).toMatchObject({
      status: "REJECTED",
      rejectionReason: "SAFETY_ABOVE_MAX_ALTITUDE",
      detail: "82.4 deg exceeds MAX_ALT_SAFE 78.0 deg",
      decidedAt: decidedAt.toISOString(),
    });
  });
});

/**
 * DV-103's admission rule, against the real join.
 *
 * `hasObserverSeat` reads the seat and the mission's consent in one query, and
 * the half worth proving here is the relation filter: a seat left behind by a
 * controller who closed the session must not admit anybody. The fake mirrors this
 * logic, so only a real database can tell me the SQL agrees with it.
 */
describe("who holds an observer seat", () => {
  async function seatFor(userId: string) {
    await database.missionParticipant.create({
      data: { missionId, userId, status: "JOINED" },
    });
  }

  async function anotherUser() {
    const user = await database.user.create({
      data: {
        email: `${randomUUID()}@example.test`,
        name: "Observer",
        emailVerifiedAt: NOW,
      },
    });
    return user.id;
  }

  it("is nobody while the mission is private, which is how it ships", async () => {
    const observer = await anotherUser();
    await seatFor(observer);

    expect(await store.hasObserverSeat(missionId, observer)).toBe(false);
  });

  it("is the seat holder once the controller opens the session", async () => {
    const observer = await anotherUser();
    await seatFor(observer);
    await database.mission.update({
      where: { id: missionId },
      data: { joinPolicy: "OPEN" },
    });

    expect(await store.hasObserverSeat(missionId, observer)).toBe(true);
  });

  it("is nobody again the moment consent is withdrawn", async () => {
    const observer = await anotherUser();
    await seatFor(observer);
    await database.mission.update({
      where: { id: missionId },
      data: { joinPolicy: "OPEN" },
    });
    expect(await store.hasObserverSeat(missionId, observer)).toBe(true);

    await database.mission.update({
      where: { id: missionId },
      data: { joinPolicy: "DISABLED" },
    });

    // The seat row is still JOINED here on purpose. DV-101 marks them LEFT when
    // it closes a session; this proves the channel would refuse even if a seat
    // survived that sweep by racing it.
    expect(await store.hasObserverSeat(missionId, observer)).toBe(false);
  });

  it("is not somebody who left", async () => {
    const observer = await anotherUser();
    await seatFor(observer);
    await database.mission.update({
      where: { id: missionId },
      data: { joinPolicy: "OPEN" },
    });
    await database.missionParticipant.updateMany({
      where: { missionId, userId: observer },
      data: { status: "LEFT", leftAt: NOW },
    });

    expect(await store.hasObserverSeat(missionId, observer)).toBe(false);
  });

  it("is not somebody holding a seat on a different mission", async () => {
    const observer = await anotherUser();
    // SCHEDULED, not live: Mission_active_per_observatory_unique allows exactly
    // one live mission per observatory and the fixture already holds it. What
    // this test is about is mission scoping, not liveness.
    const other = await database.mission.create({
      data: {
        userId: ownerId,
        targetId,
        observatoryId: observatory.id,
        telescopeId,
        state: "SCHEDULED",
      },
    });
    await database.missionParticipant.create({
      data: { missionId: other.id, userId: observer, status: "JOINED" },
    });
    await database.mission.updateMany({ data: { joinPolicy: "OPEN" } });

    expect(await store.hasObserverSeat(missionId, observer)).toBe(false);
    expect(await store.hasObserverSeat(other.id, observer)).toBe(true);
  });
});

/**
 * DV-032's stream check, against the real queries.
 *
 * `mayWatchMission` is asked on **every** live-view request, and it is the only
 * one of the three checks there that can withdraw entitlement mid-stream: the
 * cookie and the signed token both keep saying yes until they lapse. A wrong
 * filter here is a customer still watching a session they no longer hold, so the
 * SQL has to be shown to agree with the fake rather than assumed to.
 */
describe("who may still watch a live view", () => {
  async function anotherUser(name = "Viewer") {
    const user = await database.user.create({
      data: {
        email: `${randomUUID()}@example.test`,
        name,
        emailVerifiedAt: NOW,
      },
    });
    return user.id;
  }

  function sessionFor(userId: string, overrides: Record<string, unknown> = {}) {
    return database.missionSession.create({
      data: {
        missionId,
        userId,
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30 * 60_000),
        ...overrides,
      },
    });
  }

  it("admits the controller holding a live session", async () => {
    await sessionFor(ownerId);

    expect(await store.mayWatchMission(missionId, ownerId, NOW)).toBe(true);
  });

  it("refuses the controller once the session is revoked", async () => {
    await sessionFor(ownerId, { revokedAt: NOW });

    expect(await store.mayWatchMission(missionId, ownerId, NOW)).toBe(false);
  });

  it("refuses the controller once the session has lapsed", async () => {
    const session = await sessionFor(ownerId);

    expect(await store.mayWatchMission(missionId, ownerId, session.expiresAt)).toBe(
      false,
    );
  });

  it("refuses somebody with no session and no seat", async () => {
    const stranger = await anotherUser("Stranger");
    await sessionFor(ownerId);

    expect(await store.mayWatchMission(missionId, stranger, NOW)).toBe(false);
  });

  it("admits an observer holding a seat on an open mission", async () => {
    const observer = await anotherUser("Observer");
    await database.missionParticipant.create({
      data: { missionId, userId: observer, status: "JOINED" },
    });
    await database.mission.update({
      where: { id: missionId },
      data: { joinPolicy: "OPEN" },
    });

    expect(await store.mayWatchMission(missionId, observer, NOW)).toBe(true);
  });

  it("refuses that observer the moment the controller closes the mission", async () => {
    // The seat is untouched. Consent is what was withdrawn, and ADR-007 rule 5
    // says a withdrawn consent is not entitlement.
    const observer = await anotherUser("Observer");
    await database.missionParticipant.create({
      data: { missionId, userId: observer, status: "JOINED" },
    });
    await database.mission.update({
      where: { id: missionId },
      data: { joinPolicy: "OPEN" },
    });
    expect(await store.mayWatchMission(missionId, observer, NOW)).toBe(true);

    await database.mission.update({
      where: { id: missionId },
      data: { joinPolicy: "DISABLED" },
    });

    expect(await store.mayWatchMission(missionId, observer, NOW)).toBe(false);
  });

  it("does not let a session on one mission open another mission's view", async () => {
    const other = await database.mission.create({
      data: {
        userId: ownerId,
        targetId,
        observatoryId: observatory.id,
        telescopeId,
        state: "SCHEDULED",
      },
    });
    await sessionFor(ownerId);

    expect(await store.mayWatchMission(missionId, ownerId, NOW)).toBe(true);
    expect(await store.mayWatchMission(other.id, ownerId, NOW)).toBe(false);
  });
});
