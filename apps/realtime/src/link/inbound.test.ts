import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { CloudToAgentMessage, CommandEnvelope } from "@darkview/contracts";

import { AgentLink } from "@/link/agent-link";
import { FakeLinkStore } from "@/link/fake-store";
import { PROTOCOL_VERSION } from "@/link/protocol";
import type { ObservatoryRecord } from "@/link/store";

/**
 * What an inbound agent message means, as opposed to whether it was allowed.
 *
 * Issues #25, #26 and #27 were one fault wearing three numbers: the cloud stored
 * the identity of every agent message -- messageId, type, sentAt -- and discarded
 * the body. The agent ran the full mission state machine, refused unsafe commands
 * on its own envelope check, and reported all of it into nothing.
 *
 * The consequence that made it urgent is in `applyMissionEvent`: a mission that
 * never leaves a live state holds Mission_active_per_observatory_unique forever,
 * and every later mission at that observatory is refused. The integration suite
 * proves that against a real index; these prove the rules.
 */
const observatory: ObservatoryRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "tbilisi",
  mode: "SIMULATED",
};

const OTHER_OBSERVATORY = "99999999-9999-4999-8999-999999999999";
const MISSION_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";

let store: FakeLinkStore;
let sent: CloudToAgentMessage[];
let now: number;

function makeLink() {
  return new AgentLink(
    observatory,
    store,
    (message) => sent.push(message),
    () => {},
    () => now,
  );
}

function hello(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "AGENT_HELLO",
    messageId: randomUUID(),
    sentAt: new Date(now).toISOString(),
    protocolVersion: PROTOCOL_VERSION,
    observatoryId: observatory.id,
    agentVersion: "0.1.0",
    mode: "SIMULATED",
    bootedAt: new Date(now).toISOString(),
    safetyEnvelopeConfigured: true,
    resumeMissionId: null,
    ...overrides,
  });
}

function missionEvent(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "AGENT_MISSION_EVENT",
    messageId: randomUUID(),
    sentAt: new Date(now).toISOString(),
    missionId: MISSION_ID,
    state: "COMPLETE",
    failureReason: null,
    occurredAt: new Date(now).toISOString(),
    commandId: null,
    detail: null,
    ...overrides,
  });
}

function commandAck(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "AGENT_COMMAND_ACK",
    messageId: randomUUID(),
    sentAt: new Date(now).toISOString(),
    commandId: COMMAND_ID,
    missionId: MISSION_ID,
    status: "ACCEPTED",
    rejectionReason: null,
    detail: null,
    ...overrides,
  });
}

const COMMAND_ID = "55555555-5555-4555-8555-555555555555";

function envelopeFor(commandId = COMMAND_ID): CommandEnvelope {
  return {
    commandId,
    missionId: MISSION_ID,
    sessionId: SESSION_ID,
    userId: USER_ID,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
    type: "NUDGE",
    payload: {
      kind: "NUDGE",
      axis: "ALTITUDE",
      direction: "POSITIVE",
      stepArcminutes: 3,
    },
  };
}

/** A link that has said hello and is ONLINE, with the queue of sends cleared. */
async function onlineLink() {
  const link = makeLink();
  await link.receive(hello());
  sent.length = 0;
  return link;
}

beforeEach(() => {
  store = new FakeLinkStore();
  sent = [];
  now = Date.parse("2026-12-15T20:00:00.000Z");
  store.addMission(MISSION_ID, { observatoryId: observatory.id, state: "CAPTURING" });
});

describe("mission events (#25)", () => {
  // criterion 1
  it("moves the mission the reporting observatory holds", async () => {
    const link = await onlineLink();
    await link.receive(missionEvent({ state: "COMPLETE" }));

    expect(store.mission(MISSION_ID)?.state).toBe("COMPLETE");
    expect(sent).toEqual([]);
  });

  it("carries the failure reason alongside a failure state", async () => {
    const link = await onlineLink();
    await link.receive(
      missionEvent({ state: "FAILED", failureReason: "PLATE_SOLVE_FAILED" }),
    );

    expect(store.mission(MISSION_ID)).toMatchObject({
      state: "FAILED",
      failureReason: "PLATE_SOLVE_FAILED",
    });
  });

  // criterion 3
  it("records occurredAt as the agent sent it, not as now", async () => {
    const link = await onlineLink();
    const duringTheOutage = "2026-12-15T19:40:00.000Z";

    await link.receive(missionEvent({ occurredAt: duringTheOutage }));

    expect(store.missionEvents.at(-1)?.occurredAt.toISOString()).toBe(duringTheOutage);
  });

  it("files a simulated mission's events as simulated", async () => {
    const link = await onlineLink();
    await link.receive(missionEvent({ state: "PROCESSING" }));

    expect(store.missionEvents.at(-1)).toMatchObject({
      simulated: true,
      source: "AGENT",
    });
  });

  // criterion 2
  it("refuses an event naming another observatory's mission", async () => {
    const foreign = "66666666-6666-4666-8666-666666666666";
    store.addMission(foreign, { observatoryId: OTHER_OBSERVATORY, state: "OBSERVING" });

    const link = await onlineLink();
    await link.receive(missionEvent({ missionId: foreign, state: "COMPLETE" }));

    expect(store.mission(foreign)?.state).toBe("OBSERVING");
    expect(store.missionEvents).toEqual([]);
    expect(sent.at(0)).toMatchObject({ type: "CLOUD_ERROR", code: "FORBIDDEN" });
    // Refused, not fatal. The rest of what this agent has to say is still about
    // the observatory it authenticated as.
    expect(link.currentState).toBe("ONLINE");
  });

  it("refuses an event for a mission that does not exist, without creating one", async () => {
    const link = await onlineLink();
    await link.receive(
      missionEvent({ missionId: "77777777-7777-4777-8777-777777777777" }),
    );

    expect(store.missions.size).toBe(1);
    expect(sent.at(0)).toMatchObject({ type: "CLOUD_ERROR", code: "FORBIDDEN" });
  });

  // criterion 4
  it("does not apply a replayed event twice", async () => {
    const link = await onlineLink();
    const replayed = randomUUID();

    await link.receive(missionEvent({ messageId: replayed, state: "PROCESSING" }));
    await link.receive(missionEvent({ messageId: replayed, state: "PROCESSING" }));
    await link.receive(missionEvent({ messageId: replayed, state: "PROCESSING" }));

    expect(store.missionEvents).toHaveLength(1);
    expect(store.mission(MISSION_ID)?.state).toBe("PROCESSING");
  });

  // criterion 5
  it("does not revive a terminal mission when a late event arrives", async () => {
    const link = await onlineLink();

    await link.receive(missionEvent({ state: "FAILED", failureReason: "TRACKING_LOST" }));
    await link.receive(missionEvent({ state: "COMPLETE" }));

    expect(store.mission(MISSION_ID)).toMatchObject({
      state: "FAILED",
      failureReason: "TRACKING_LOST",
    });
    // Filed even though it was not applied. The agent did report it, and the
    // event log is an account of what was reported.
    expect(store.missionEvents).toHaveLength(2);
    expect(sent).toEqual([]);
  });
});

describe("restart recovery (#26)", () => {
  // criteria 1 and 4
  it("closes out the mission an agent came back holding, and revokes its session", async () => {
    store.setActiveSession(observatory.id, {
      sessionId: SESSION_ID,
      missionId: MISSION_ID,
      userId: USER_ID,
      expiresAt: new Date(now + 600_000),
    });

    const link = makeLink();
    await link.receive(hello({ resumeMissionId: MISSION_ID }));

    expect(store.mission(MISSION_ID)).toMatchObject({
      state: "FAILED",
      failureReason: "AGENT_LINK_LOST",
    });
    expect(store.revoked).toEqual([{ sessionId: SESSION_ID, reason: "AGENT_LINK_LOST" }]);
    expect(store.missionEvents.at(-1)).toMatchObject({
      state: "FAILED",
      source: "CLOUD",
    });
  });

  // criterion 5
  it("welcomes the agent with the mission the cloud believes it holds", async () => {
    const link = makeLink();
    await link.receive(hello());

    expect(sent.at(0)).toMatchObject({
      type: "CLOUD_WELCOME",
      expectedMissionId: MISSION_ID,
    });
    expect(link.currentState).toBe("ONLINE");
  });

  it("states null after a recovery rather than defaulting to it", async () => {
    const link = makeLink();
    await link.receive(hello({ resumeMissionId: MISSION_ID }));

    expect(sent.at(0)).toMatchObject({
      type: "CLOUD_WELCOME",
      expectedMissionId: null,
    });
    expect(sent.at(1)).toMatchObject({
      type: "CLOUD_SESSION_UPDATE",
      missionId: MISSION_ID,
      sessionId: null,
    });
    expect(link.currentState).toBe("ONLINE");
  });

  // criterion 2
  it("changes nothing, and is not an error, when the mission already ended", async () => {
    store.addMission(MISSION_ID, { observatoryId: observatory.id, state: "COMPLETE" });

    const link = makeLink();
    await link.receive(hello({ resumeMissionId: MISSION_ID }));

    expect(store.mission(MISSION_ID)?.state).toBe("COMPLETE");
    expect(store.missionEvents).toEqual([]);
    expect(sent.some((message) => message.type === "CLOUD_ERROR")).toBe(false);
    // Still told it holds nobody: the agent is the one that believes otherwise.
    expect(sent.at(1)).toMatchObject({
      type: "CLOUD_SESSION_UPDATE",
      sessionId: null,
    });
    expect(link.currentState).toBe("ONLINE");
  });

  // criterion 3
  it("refuses a resume claim on another observatory's mission", async () => {
    const foreign = "66666666-6666-4666-8666-666666666666";
    store.addMission(foreign, { observatoryId: OTHER_OBSERVATORY, state: "OBSERVING" });

    const link = makeLink();
    await link.receive(hello({ resumeMissionId: foreign }));

    expect(store.mission(foreign)?.state).toBe("OBSERVING");
    expect(sent.at(1)).toMatchObject({ type: "CLOUD_ERROR", code: "FORBIDDEN" });
    expect(sent.some((message) => message.type === "CLOUD_SESSION_UPDATE")).toBe(false);
    expect(link.currentState).toBe("ONLINE");
  });
});

describe("command acknowledgements (#27)", () => {
  beforeEach(() => {
    store.addCommand({ observatoryId: observatory.id, envelope: envelopeFor() });
  });

  // criteria 1 and 5
  it("records the refusal, its reason and its detail", async () => {
    const link = await onlineLink();
    await link.receive(
      commandAck({
        status: "REJECTED",
        rejectionReason: "SAFETY_ABOVE_MAX_ALTITUDE",
        detail: "82.4 deg exceeds MAX_ALT_SAFE 78.0 deg",
      }),
    );

    expect(store.commandStatusOf(COMMAND_ID)).toBe("REJECTED");
    expect(store.verdictOf(COMMAND_ID)).toMatchObject({
      status: "REJECTED",
      rejectionReason: "SAFETY_ABOVE_MAX_ALTITUDE",
      detail: "82.4 deg exceeds MAX_ALT_SAFE 78.0 deg",
    });
    expect(store.completedAt.get(COMMAND_ID)).toEqual(new Date(now));
  });

  it("round-trips a reason that is not an ErrorCode value", async () => {
    const link = await onlineLink();
    await link.receive(
      commandAck({
        status: "REJECTED",
        rejectionReason: "COMMAND_NOT_PERMITTED_FOR_CLIENT",
      }),
    );

    expect(store.verdictOf(COMMAND_ID)?.rejectionReason).toBe(
      "COMMAND_NOT_PERMITTED_FOR_CLIENT",
    );
  });

  it("keeps the agent's own decision time", async () => {
    const link = await onlineLink();
    const decidedDuringTheOutage = "2026-12-15T19:41:00.000Z";

    await link.receive(commandAck({ status: "FAILED", sentAt: decidedDuringTheOutage }));

    expect(store.verdictOf(COMMAND_ID)?.decidedAt.toISOString()).toBe(
      decidedDuringTheOutage,
    );
  });

  // criterion 2
  it("refuses an ack for another observatory's command", async () => {
    const foreign = "88888888-8888-4888-8888-888888888888";
    store.addCommand({
      observatoryId: OTHER_OBSERVATORY,
      envelope: envelopeFor(foreign),
    });

    const link = await onlineLink();
    await link.receive(commandAck({ commandId: foreign, status: "REJECTED" }));

    expect(store.verdictOf(foreign)).toBeUndefined();
    expect(store.commandStatusOf(foreign)).toBe("RECEIVED");
    expect(sent.at(0)).toMatchObject({ type: "CLOUD_ERROR", code: "FORBIDDEN" });
    expect(link.currentState).toBe("ONLINE");
  });

  // criterion 4
  it("drops an ack for a command it has no row for, and creates nothing", async () => {
    const unknown = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const link = await onlineLink();

    await link.receive(commandAck({ commandId: unknown }));

    expect(store.verdictOf(unknown)).toBeUndefined();
    expect(sent.at(0)).toMatchObject({ type: "CLOUD_ERROR", code: "FORBIDDEN" });
  });

  // criterion 3
  it("does not let a DUPLICATE ack downgrade the verdict that already stands", async () => {
    const link = await onlineLink();

    await link.receive(commandAck({ status: "COMPLETED" }));
    await link.receive(commandAck({ status: "DUPLICATE" }));

    expect(store.commandStatusOf(COMMAND_ID)).toBe("COMPLETED");
    expect(store.verdictOf(COMMAND_ID)?.status).toBe("COMPLETED");
  });

  it("does not let a late ack overwrite a terminal verdict", async () => {
    const link = await onlineLink();

    await link.receive(
      commandAck({ status: "REJECTED", rejectionReason: "SAFETY_SUN_EXCLUSION" }),
    );
    await link.receive(commandAck({ status: "ACCEPTED" }));

    expect(store.commandStatusOf(COMMAND_ID)).toBe("REJECTED");
    expect(store.verdictOf(COMMAND_ID)?.rejectionReason).toBe("SAFETY_SUN_EXCLUSION");
  });

  it("does not apply a replayed ack twice", async () => {
    const link = await onlineLink();
    const replayed = randomUUID();

    await link.receive(commandAck({ messageId: replayed, status: "ACCEPTED" }));
    await link.receive(
      commandAck({
        messageId: replayed,
        status: "REJECTED",
        rejectionReason: "WRONG_USER",
      }),
    );

    expect(store.commandStatusOf(COMMAND_ID)).toBe("EXECUTING");
    expect(store.verdictOf(COMMAND_ID)?.status).toBe("ACCEPTED");
  });
});
