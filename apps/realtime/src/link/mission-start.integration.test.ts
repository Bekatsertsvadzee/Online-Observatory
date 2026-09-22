import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@darkview/db";

import { AgentLink } from "@/link/agent-link";
import { AGENT_CHANNEL } from "@/link/command-listener";
import { FAKE_STORAGE } from "@/link/fake-storage";
import { createPrismaStore, type RealtimeStore } from "@/link/prisma-store";
import { PROTOCOL_VERSION } from "@/link/protocol";
import type { ObservatoryRecord } from "@/link/store";
import { RecordingBroadcast } from "@/mission/fake-broadcast";

/**
 * ADR-018 §3 and §4 against a real PostgreSQL instance.
 *
 * What only a database can show: that a refused start actually leaves
 * Mission_active_per_observatory_unique, so the next mission can go live; that the
 * agent is told nobody owns the mission on the same commit; and that a no-show is
 * closed by the conditional update rather than by a read.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const NOW = new Date("2026-12-15T20:00:00.000Z");

let database: PrismaClient;
let store: RealtimeStore;
let listener: Client;
let notifications: string[];

let observatory: ObservatoryRecord;
let telescopeId: string;
let targetId: string;
let ownerId: string;

function makeLink() {
  return new AgentLink(
    observatory,
    store,
    () => {},
    () => {},
    new RecordingBroadcast(),
    FAKE_STORAGE,
    () => NOW.getTime(),
  );
}

async function onlineLink() {
  const link = makeLink();
  await link.receive(
    JSON.stringify({
      type: "AGENT_HELLO",
      messageId: randomUUID(),
      sentAt: NOW.toISOString(),
      protocolVersion: PROTOCOL_VERSION,
      observatoryId: observatory.id,
      agentVersion: "0.1.0",
      mode: "SIMULATED",
      posture: "SIMULATED",
      bootedAt: NOW.toISOString(),
      safetyEnvelopeConfigured: true,
      resumeMissionId: null,
    }),
  );
  return link;
}

function mission(state: "SCHEDULED" | "PREPARING") {
  return database.mission.create({
    data: { userId: ownerId, targetId, observatoryId: observatory.id, telescopeId, state },
  });
}

async function bookedMission(slotStartAt: Date, durationMinutes = 30) {
  const row = await mission("SCHEDULED");
  await database.booking.create({
    data: {
      userId: ownerId,
      targetId,
      observatoryId: observatory.id,
      telescopeId,
      slotStartAt,
      durationMinutes,
      status: "CONFIRMED",
      priceMinor: 4500,
      currency: "GEL",
      missionId: row.id,
    },
  });
  return row.id;
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING }),
  });
  await database.$queryRaw`SELECT 1`;
  store = createPrismaStore(CONNECTION_STRING);

  listener = new Client({ connectionString: CONNECTION_STRING });
  await listener.connect();
  await listener.query(`LISTEN ${AGENT_CHANNEL}`);
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

  // The same order as inbound.integration.test.ts, for the same Restrict keys.
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
    data: { email: `${randomUUID()}@example.test`, name: "Start Tester", emailVerifiedAt: NOW },
  });
  ownerId = user.id;
});

describe("a start the agent refuses", () => {
  it("fails the mission, revokes the session, tells the agent and frees the observatory", async () => {
    const started = await mission("PREPARING");
    const session = await database.missionSession.create({
      data: {
        missionId: started.id,
        userId: ownerId,
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30 * 60_000),
      },
    });
    const commandId = randomUUID();
    await database.observatoryCommand.create({
      data: {
        id: commandId,
        missionId: started.id,
        sessionId: session.id,
        userId: ownerId,
        observatoryId: observatory.id,
        type: "GOTO",
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30_000),
        payload: {
          kind: "GOTO",
          targetId,
          coordinates: { raHours: 16.6949, decDegrees: 36.4613, epoch: "J2000" },
          opticalConfig: "F10_NATIVE",
          imagingProfile: "GLOBULAR_CLUSTER",
          recenter: false,
        },
      },
    });

    const link = await onlineLink();
    await link.receive(
      JSON.stringify({
        type: "AGENT_COMMAND_ACK",
        messageId: randomUUID(),
        sentAt: new Date("2026-12-15T20:00:03.000Z").toISOString(),
        commandId,
        missionId: started.id,
        status: "REJECTED",
        rejectionReason: "SAFETY_HORIZON_MASK",
        detail: "target is behind the rooftop mask",
      }),
    );

    const failed = await database.mission.findUniqueOrThrow({ where: { id: started.id } });
    expect(failed.state).toBe("FAILED");
    expect(failed.failureReason).toBe("SAFETY_REFUSED");

    const revoked = await database.missionSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.revokedFor).toBe("START_REFUSED_BY_AGENT");

    const event = await database.missionEvent.findFirstOrThrow({
      where: { missionId: started.id, state: "FAILED" },
    });
    expect(event).toMatchObject({ source: "CLOUD", commandId });

    expect(
      await database.auditLog.count({
        where: { action: "MISSION_START_REFUSED_BY_AGENT", missionId: started.id },
      }),
    ).toBe(1);

    const deadline = Date.now() + 3_000;
    while (!notifications.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(notifications.map((raw) => JSON.parse(raw))).toContainEqual({
      kind: "SESSION",
      observatoryId: observatory.id,
      missionId: started.id,
      sessionId: null,
    });

    // The index no longer holds the refused mission, so another one can go live.
    await expect(mission("PREPARING")).resolves.toBeDefined();
  });
});

describe("a slot nobody started", () => {
  it("cancels the mission whose slot has ended, and only that one", async () => {
    const ended = await bookedMission(new Date(NOW.getTime() - 60 * 60_000));
    const current = await bookedMission(new Date(NOW.getTime() - 10 * 60_000));

    await expect(store.closeUnstartedMissions(NOW)).resolves.toEqual([ended]);

    const closed = await database.mission.findUniqueOrThrow({ where: { id: ended } });
    expect(closed).toMatchObject({ state: "CANCELLED", failureReason: "SESSION_EXPIRED" });
    expect(closed.completedAt).toEqual(NOW);
    expect(
      await database.missionEvent.count({
        where: { missionId: ended, state: "CANCELLED", source: "CLOUD" },
      }),
    ).toBe(1);
    expect(
      await database.auditLog.count({ where: { action: "MISSION_NOT_STARTED", missionId: ended } }),
    ).toBe(1);

    // The booking keeps its money; what happens to it is the refund engine's.
    const booking = await database.booking.findFirstOrThrow({ where: { missionId: ended } });
    expect(booking.status).toBe("CONFIRMED");

    expect((await database.mission.findUniqueOrThrow({ where: { id: current } })).state).toBe(
      "SCHEDULED",
    );
  });

  it("closes nothing twice", async () => {
    await bookedMission(new Date(NOW.getTime() - 60 * 60_000));
    await store.closeUnstartedMissions(NOW);

    await expect(store.closeUnstartedMissions(NOW)).resolves.toEqual([]);
  });
});
