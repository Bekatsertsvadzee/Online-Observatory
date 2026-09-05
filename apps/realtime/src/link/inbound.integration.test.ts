import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@darkview/db";

import { AgentLink } from "@/link/agent-link";
import { AgentRelay } from "@/link/agent-relay";
import { createPrismaStore } from "@/link/prisma-store";
import { AgentLinkRegistry } from "@/link/registry";
import { PROTOCOL_VERSION } from "@/link/protocol";
import type { LinkStore, ObservatoryRecord } from "@/link/store";

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
let store: LinkStore;

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
