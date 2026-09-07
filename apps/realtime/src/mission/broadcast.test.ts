import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type {
  AgentCommandAck,
  AgentStateDelta,
  MissionChannelMessage,
} from "@darkview/contracts";

import { FakeLinkStore } from "@/link/fake-store";
import { MissionRelay } from "@/mission/broadcast";
import { MissionChannel } from "@/mission/channel";
import { MissionChannelRegistry } from "@/mission/registry";
import type { ChannelUser } from "@/mission/store";

const OBSERVATORY = "11111111-1111-4111-8111-111111111111";
const MISSION = "22222222-2222-4222-8222-222222222222";
const OTHER_MISSION = "33333333-3333-4333-8333-333333333333";

let store: FakeLinkStore;
let registry: MissionChannelRegistry;
let relay: MissionRelay;
let now: number;

/** A subscribed channel on `missionId`, and the messages it receives. */
async function subscriber(missionId: string, userId = randomUUID()) {
  const received: MissionChannelMessage[] = [];
  const sessionId = randomUUID();
  const user: ChannelUser = { id: userId, role: "USER" };

  store.setActiveSession(OBSERVATORY, {
    sessionId,
    missionId,
    userId,
    expiresAt: new Date(now + 30 * 60_000),
  });

  const channel = new MissionChannel(
    missionId,
    user,
    store,
    (message) => received.push(message),
    () => {},
    () => now,
  );

  await channel.receive(
    JSON.stringify({
      type: "CLIENT_SUBSCRIBE",
      messageId: randomUUID(),
      sentAt: new Date(now).toISOString(),
      missionId,
      sessionId,
    }),
  );
  received.length = 0; // drop the snapshot the subscribe delivers

  registry.add(missionId, channel);
  return { channel, received };
}

function stateDelta(missionId: string | null): AgentStateDelta {
  return {
    type: "AGENT_STATE_DELTA",
    messageId: randomUUID(),
    sentAt: new Date(now).toISOString(),
    missionId,
    telemetry: {
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
        updatedAt: new Date(now).toISOString(),
      },
      pointingEquatorial: { raHours: 5.5, decDegrees: -5.4, epoch: "J2000" },
      pointingHorizontal: { altitudeDegrees: 61.2, azimuthDegrees: 143.9 },
      tracking: true,
      parked: false,
      slewing: false,
      focuserPosition: 14_320,
      ambientTemperatureC: 9.5,
      agentVersion: "0.1.0",
      reportedAt: new Date(now).toISOString(),
    },
    missionState: "OBSERVING",
    failureReason: null,
    centeringIteration: 2,
    residualArcminutes: 0.8,
  } as AgentStateDelta;
}

beforeEach(() => {
  store = new FakeLinkStore();
  registry = new MissionChannelRegistry();
  relay = new MissionRelay(store, registry);
  now = Date.parse("2026-09-07T21:00:00.000Z");

  store.addMission(MISSION, { observatoryId: OBSERVATORY, state: "OBSERVING" });
  store.addMission(OTHER_MISSION, { observatoryId: OBSERVATORY, state: "OBSERVING" });
});

describe("fan-out", () => {
  it("delivers one event to every subscriber on the mission", async () => {
    // A set, not a single channel. The Observer Pack (DV-103) adds subscribers to
    // exactly this collection, and a one-per-mission map would have to be rewritten.
    const first = await subscriber(MISSION);
    const second = await subscriber(MISSION);

    relay.missionMoved({ missionId: MISSION, state: "CAPTURING", failureReason: null });

    expect(first.received).toHaveLength(1);
    expect(second.received).toHaveLength(1);
    expect(first.received[0]).toMatchObject({ type: "MISSION_STATE", state: "CAPTURING" });
  });

  it("delivers nothing to a subscriber on another mission", async () => {
    const watching = await subscriber(MISSION);
    const elsewhere = await subscriber(OTHER_MISSION);

    relay.missionMoved({ missionId: MISSION, state: "COMPLETE", failureReason: null });

    expect(watching.received).toHaveLength(1);
    expect(elsewhere.received).toEqual([]);
  });

  it("forgets a mission once its last subscriber leaves", async () => {
    const only = await subscriber(MISSION);
    expect(registry.size).toBe(1);

    registry.remove(MISSION, only.channel);

    // Missions are created constantly and never reused. A map that only grows is
    // a leak in a process meant to run for months.
    expect(registry.size).toBe(0);
    expect(registry.subscribers(MISSION)).toEqual([]);
  });
});

describe("telemetry narrowing", () => {
  it("carries the client-safe fields", async () => {
    const client = await subscriber(MISSION);

    relay.telemetryReported(MISSION, stateDelta(MISSION));

    expect(client.received[0]).toMatchObject({
      type: "MISSION_TELEMETRY",
      missionId: MISSION,
      mode: "SIMULATED",
      link: "ONLINE",
      tracking: true,
      centeringIteration: 2,
      residualArcminutes: 0.8,
      ambientTemperatureC: 9.5,
    });
  });

  it("drops device identity, driver state and pointing", async () => {
    // The contract calls MissionTelemetryUpdate "deliberately narrower than
    // ObservatoryTelemetry: no device identity, no driver state, no address".
    // This is that sentence as an assertion.
    const client = await subscriber(MISSION);

    relay.telemetryReported(MISSION, stateDelta(MISSION));

    const message = client.received[0] as Record<string, unknown>;
    for (const forbidden of [
      "mount",
      "camera",
      "focuser",
      "focuserPosition",
      "pointingEquatorial",
      "pointingHorizontal",
      "agentVersion",
      "telemetry",
    ]) {
      expect(message).not.toHaveProperty(forbidden);
    }
  });
});

describe("command results", () => {
  function ack(commandId: string, overrides: Partial<AgentCommandAck> = {}) {
    return {
      type: "AGENT_COMMAND_ACK",
      messageId: randomUUID(),
      sentAt: new Date(now).toISOString(),
      commandId,
      status: "REJECTED",
      rejectionReason: "SAFETY_ABOVE_MAX_ALTITUDE",
      detail: null,
      ...overrides,
    } as AgentCommandAck;
  }

  function mintCommand(missionId: string) {
    const commandId = randomUUID();
    store.addCommand({
      observatoryId: OBSERVATORY,
      envelope: {
        commandId,
        missionId,
        sessionId: randomUUID(),
        userId: randomUUID(),
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        type: "NUDGE",
        payload: {},
      } as never,
    });
    return commandId;
  }

  it("reaches the mission the cloud minted the command for", async () => {
    const client = await subscriber(MISSION);
    const commandId = mintCommand(MISSION);

    await relay.commandAnswered(ack(commandId));

    expect(client.received[0]).toMatchObject({
      type: "MISSION_COMMAND_RESULT",
      missionId: MISSION,
      commandId,
      status: "REJECTED",
      rejectionReason: "SAFETY_ABOVE_MAX_ALTITUDE",
    });
  });

  it("ignores the missionId the agent put on the ack", async () => {
    // The field is the agent's account of where the command came from. Routing a
    // fan-out on it would let one buggy agent deliver a rejection into a
    // stranger's session; the minted row cannot be wrong about which mission it
    // was for.
    const watching = await subscriber(MISSION);
    const elsewhere = await subscriber(OTHER_MISSION);
    const commandId = mintCommand(MISSION);

    await relay.commandAnswered(ack(commandId, { missionId: OTHER_MISSION }));

    expect(watching.received).toHaveLength(1);
    expect(elsewhere.received).toEqual([]);
  });

  it("says nothing about a command it cannot find", async () => {
    const client = await subscriber(MISSION);

    await relay.commandAnswered(ack(randomUUID()));

    expect(client.received).toEqual([]);
  });
});
