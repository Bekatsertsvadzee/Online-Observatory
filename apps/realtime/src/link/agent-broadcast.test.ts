import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { CloudToAgentMessage } from "@darkview/contracts";

import { AgentLink } from "@/link/agent-link";
import { FakeLinkStore } from "@/link/fake-store";
import { PROTOCOL_VERSION } from "@/link/protocol";
import type { ObservatoryRecord } from "@/link/store";
import { RecordingBroadcast } from "@/mission/fake-broadcast";
import { FAKE_STORAGE } from "@/link/fake-storage";

/**
 * What the agent link passes on to the watching customers.
 *
 * The link's own rules live in `agent-link.test.ts`. This file is about the step
 * after them: an event that was applied to the database and then went nowhere is
 * exactly what issues #25 and #27 recorded, and nothing failed at the time
 * because nothing asserted the onward step existed.
 */
const observatory: ObservatoryRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "tbilisi",
  mode: "SIMULATED",
};

const MISSION = "22222222-2222-4222-8222-222222222222";
const ANOTHER_OBSERVATORYS_MISSION = "33333333-3333-4333-8333-333333333333";

let store: FakeLinkStore;
let broadcast: RecordingBroadcast;
let sent: CloudToAgentMessage[];
let now: number;

async function onlineLink() {
  const link = new AgentLink(
    observatory,
    store,
    (message) => sent.push(message),
    () => {},
    broadcast,
    FAKE_STORAGE,
    () => now,
  );

  await link.receive(
    JSON.stringify({
      type: "AGENT_HELLO",
      messageId: randomUUID(),
      sentAt: new Date(now).toISOString(),
      protocolVersion: PROTOCOL_VERSION,
      observatoryId: observatory.id,
      agentVersion: "0.1.0",
      mode: "SIMULATED",
      bootedAt: new Date(now).toISOString(),
      safetyEnvelopeConfigured: false,
      resumeMissionId: null,
    }),
  );

  sent = [];
  return link;
}

function missionEvent(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "AGENT_MISSION_EVENT",
    messageId: randomUUID(),
    sentAt: new Date(now).toISOString(),
    missionId: MISSION,
    state: "CAPTURING",
    failureReason: null,
    occurredAt: new Date(now).toISOString(),
    detail: null,
    ...overrides,
  });
}

function stateDelta(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "AGENT_STATE_DELTA",
    messageId: randomUUID(),
    sentAt: new Date(now).toISOString(),
    missionId: MISSION,
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
      pointingEquatorial: null,
      pointingHorizontal: null,
      tracking: true,
      parked: false,
      slewing: false,
      focuserPosition: null,
      ambientTemperatureC: 9.5,
      agentVersion: "0.1.0",
      reportedAt: new Date(now).toISOString(),
    },
    missionState: "OBSERVING",
    failureReason: null,
    centeringIteration: null,
    residualArcminutes: null,
    ...overrides,
  });
}

function commandAck(commandId: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "AGENT_COMMAND_ACK",
    messageId: randomUUID(),
    sentAt: new Date(now).toISOString(),
    commandId,
    missionId: MISSION,
    status: "REJECTED",
    rejectionReason: "SAFETY_ABOVE_MAX_ALTITUDE",
    detail: null,
    ...overrides,
  });
}

function mintCommand(commandId: string, observatoryId = observatory.id) {
  store.addCommand({
    observatoryId,
    envelope: {
      commandId,
      missionId: MISSION,
      sessionId: randomUUID(),
      userId: randomUUID(),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      type: "NUDGE",
      payload: {},
    } as never,
  });
}

beforeEach(() => {
  store = new FakeLinkStore();
  broadcast = new RecordingBroadcast();
  sent = [];
  now = Date.parse("2026-09-07T21:00:00.000Z");

  store.addMission(MISSION, { observatoryId: observatory.id, state: "OBSERVING" });
  store.addMission(ANOTHER_OBSERVATORYS_MISSION, {
    observatoryId: "99999999-9999-4999-8999-999999999999",
    state: "OBSERVING",
  });
});

describe("mission events", () => {
  it("reach the fan-out when they move the mission", async () => {
    const link = await onlineLink();
    await link.receive(missionEvent());

    expect(broadcast.moved).toEqual([
      { missionId: MISSION, state: "CAPTURING", failureReason: null },
    ]);
  });

  it("do not reach it when the mission had already finished", async () => {
    // A COMPLETE arriving behind a FAILED is an ordering artefact of a link that
    // does not guarantee order. Telling a customer the mission went back to
    // OBSERVING after they were shown FAILED would report that as a fact about a
    // telescope.
    const link = await onlineLink();
    await link.receive(missionEvent({ state: "FAILED", failureReason: "MOUNT_FAULT" }));
    broadcast.moved.length = 0;

    await link.receive(missionEvent({ state: "COMPLETE" }));

    expect(broadcast.moved).toEqual([]);
  });

  it("do not reach it for another observatory's mission", async () => {
    const link = await onlineLink();
    await link.receive(missionEvent({ missionId: ANOTHER_OBSERVATORYS_MISSION }));

    expect(broadcast.moved).toEqual([]);
    expect(sent).toEqual([
      expect.objectContaining({ type: "CLOUD_ERROR", code: "FORBIDDEN" }),
    ]);
  });

  it("reach it once when the agent replays its queue", async () => {
    const link = await onlineLink();
    const replayed = missionEvent();

    await link.receive(replayed);
    await link.receive(replayed);

    expect(broadcast.moved).toHaveLength(1);
  });
});

describe("telemetry", () => {
  it("reaches the fan-out for this observatory's mission", async () => {
    const link = await onlineLink();
    await link.receive(stateDelta());

    expect(broadcast.telemetry).toHaveLength(1);
    expect(broadcast.telemetry[0].missionId).toBe(MISSION);
  });

  it("is refused for a mission this observatory does not own", async () => {
    // A delta is relayed rather than written, so it does not pass through a store
    // method that scopes it. Without the ownership check one agent could spray
    // telemetry into another mission's subscribers.
    const link = await onlineLink();
    await link.receive(stateDelta({ missionId: ANOTHER_OBSERVATORYS_MISSION }));

    expect(broadcast.telemetry).toEqual([]);
    expect(sent).toEqual([
      expect.objectContaining({ type: "CLOUD_ERROR", code: "FORBIDDEN" }),
    ]);
  });

  it("goes nowhere when the agent holds no mission", async () => {
    const link = await onlineLink();
    await link.receive(stateDelta({ missionId: null }));

    expect(broadcast.telemetry).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("command acknowledgements", () => {
  it("reach the fan-out when the verdict is recorded", async () => {
    const commandId = randomUUID();
    mintCommand(commandId);

    const link = await onlineLink();
    await link.receive(commandAck(commandId));

    expect(broadcast.answered).toHaveLength(1);
    expect(broadcast.answered[0]).toMatchObject({
      commandId,
      status: "REJECTED",
      rejectionReason: "SAFETY_ABOVE_MAX_ALTITUDE",
    });
  });

  it("do not reach it twice when the agent replays the ack", async () => {
    const commandId = randomUUID();
    mintCommand(commandId);

    const link = await onlineLink();
    await link.receive(commandAck(commandId));
    await link.receive(commandAck(commandId, { status: "COMPLETED" }));

    // The first verdict was terminal. The second is a late ack that did not
    // change the row, so a customer does not watch the outcome change twice.
    expect(broadcast.answered).toHaveLength(1);
  });

  it("do not reach it for another observatory's command", async () => {
    const commandId = randomUUID();
    mintCommand(commandId, "99999999-9999-4999-8999-999999999999");

    const link = await onlineLink();
    await link.receive(commandAck(commandId));

    expect(broadcast.answered).toEqual([]);
  });
});
