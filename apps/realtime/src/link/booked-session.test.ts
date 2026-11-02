import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { CloudToAgentMessage, CommandEnvelope, ImageHealth } from "@darkview/contracts";
import { captureObjectKey } from "@darkview/storage/keys";

import { AgentLink } from "@/link/agent-link";
import { FakeLinkStore } from "@/link/fake-store";
import { FAKE_STORAGE } from "@/link/fake-storage";
import { PROTOCOL_VERSION, cloudSessionUpdate } from "@/link/protocol";
import { LIVE_MISSION_STATES, isLegalMissionTransition, type ObservatoryRecord } from "@/link/store";
import { RecordingBroadcast } from "@/mission/fake-broadcast";

/**
 * ADR-079 on the agent link: the new transitions, the dwell lock starting when the
 * agent accepts, captures filed against the object they show, the picture's
 * UNRECOVERED flag, and the session ending once the mount reports parked. Against
 * the in-memory store; `inbound.integration.test.ts` covers the Prisma one.
 */
const observatory: ObservatoryRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "tbilisi",
  mode: "SIMULATED",
};
const MISSION = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const SESSION = "77777777-7777-4777-8777-777777777777";
const BOOKED = "88888888-8888-4888-8888-888888888888";
const NEXT = "99999999-9999-4999-8999-999999999999";
const STRANGER = "66666666-6666-4666-8666-666666666666";

let store: FakeLinkStore;
let broadcast: RecordingBroadcast;
let sent: CloudToAgentMessage[];
let now: number;

function envelope(type: string, payload: Record<string, unknown>): CommandEnvelope {
  return {
    commandId: randomUUID(),
    missionId: MISSION,
    sessionId: SESSION,
    userId: OWNER,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
    type,
    payload,
  } as CommandEnvelope;
}

const coordinates = { raHours: 1, decDegrees: 2, epoch: "JNOW" };
const goto = (recenter: boolean) =>
  envelope("GOTO", {
    kind: "GOTO",
    targetId: BOOKED,
    coordinates,
    opticalConfig: "F10_NATIVE",
    imagingProfile: "PLANETARY",
    recenter,
  });
const retarget = (targetId = NEXT) =>
  envelope("RETARGET", {
    kind: "RETARGET",
    targetId,
    coordinates,
    opticalConfig: "F10_NATIVE",
    imagingProfile: "PLANETARY",
  });

function issue(command: CommandEnvelope) {
  store.addCommand({ observatoryId: observatory.id, envelope: command });
  return command;
}

function ack(command: CommandEnvelope, status: "ACCEPTED" | "REJECTED", rejectionReason: string | null = null) {
  return JSON.stringify({
    type: "AGENT_COMMAND_ACK",
    messageId: randomUUID(),
    sentAt: new Date(now).toISOString(),
    commandId: command.commandId,
    status,
    rejectionReason,
    detail: null,
  });
}

function missionEvent(state: string) {
  return JSON.stringify({
    type: "AGENT_MISSION_EVENT",
    messageId: randomUUID(),
    sentAt: new Date(now).toISOString(),
    missionId: MISSION,
    state,
    failureReason: null,
    occurredAt: new Date(now).toISOString(),
    commandId: null,
    detail: null,
  });
}

function delta(input: {
  missionId?: string | null;
  parked?: boolean;
  imageHealth?: ImageHealth | null;
}) {
  const at = new Date(now).toISOString();
  return JSON.stringify({
    type: "AGENT_STATE_DELTA",
    messageId: randomUUID(),
    sentAt: at,
    missionId: input.missionId === undefined ? MISSION : input.missionId,
    telemetry: {
      mode: "SIMULATED",
      link: "ONLINE",
      mount: { health: "OK", detail: null },
      camera: { health: "OK", detail: null },
      focuser: { health: "NOT_CONFIGURED", detail: null },
      weather: { status: "CLEAR", source: "OPERATOR", holdActive: false, note: null, updatedAt: at },
      parked: input.parked ?? false,
      reportedAt: at,
    },
    imageHealth: input.imageHealth ?? null,
  });
}

function captureReady(command: CommandEnvelope, targetId: string | null) {
  return JSON.stringify({
    type: "AGENT_CAPTURE_READY",
    messageId: randomUUID(),
    sentAt: new Date(now).toISOString(),
    missionId: MISSION,
    commandId: command.commandId,
    capturedAt: new Date(now).toISOString(),
    imagingProfile: "PLANETARY",
    opticalConfig: "F10_NATIVE",
    exposureMilliseconds: 10,
    gain: 200,
    framesStacked: 20,
    integrationSeconds: 0.2,
    imageStorageKey: captureObjectKey({
      observatoryId: observatory.id,
      missionId: MISSION,
      commandId: command.commandId,
      kind: "IMAGE",
    }),
    targetId,
    mode: "SIMULATED",
  });
}

async function online() {
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
      posture: "SIMULATED",
      bootedAt: new Date(now).toISOString(),
      safetyEnvelopeConfigured: false,
      resumeMissionId: null,
    }),
  );
  sent.length = 0;
  return link;
}

beforeEach(() => {
  store = new FakeLinkStore();
  broadcast = new RecordingBroadcast();
  sent = [];
  now = Date.parse("2026-12-15T20:00:00.000Z");
  store.addMission(MISSION, {
    observatoryId: observatory.id,
    state: "OBSERVING",
    userId: OWNER,
    targetId: BOOKED,
    currentTargetId: BOOKED,
    slotEndsAt: new Date(now + 60 * 60_000),
  });
});

describe("the transitions a booked session adds (ADR-079 §5)", () => {
  it.each([
    ["OBSERVING", "SLEWING"],
    ["PROCESSING", "OBSERVING"],
    ["OBSERVING", "COMPLETE"],
    ["PROCESSING", "COMPLETE"],
  ])("accepts %s -> %s", (from, to) => {
    expect(isLegalMissionTransition(from as never, to as never)).toBe(true);
  });

  it("counts PROCESSING as live, so it keeps the observatory", () => {
    expect(LIVE_MISSION_STATES).toContain("PROCESSING");
  });

  it("still refuses a mission that skips straight to COMPLETE from slewing", () => {
    expect(isLegalMissionTransition("SLEWING", "COMPLETE")).toBe(false);
  });
});

describe("the dwell lock starts when the agent accepts", () => {
  it("moves the current object and restarts the lock on an accepted RETARGET", async () => {
    const link = await online();
    const command = issue(retarget());

    await link.receive(ack(command, "ACCEPTED"));

    expect(store.mission(MISSION)).toMatchObject({
      currentTargetId: NEXT,
      currentTargetSince: new Date(now),
      targetId: BOOKED,
    });
    expect(store.auditEvents.map((event) => event.action)).toContain("MISSION_TARGET_CHANGED");
  });

  it("changes nothing, and fails nothing, when the agent refuses a RETARGET", async () => {
    const link = await online();
    const command = issue(retarget());

    await link.receive(ack(command, "REJECTED", "DWELL_LOCKED"));

    expect(store.mission(MISSION)).toMatchObject({
      state: "OBSERVING",
      currentTargetId: BOOKED,
    });
  });

  it("starts the lock on the starting GOTO and leaves it alone on a RECENTER", async () => {
    store.mission(MISSION)!.state = "PREPARING";
    const link = await online();
    await link.receive(ack(issue(goto(false)), "ACCEPTED"));
    const started = store.mission(MISSION)?.currentTargetSince;
    expect(started).toEqual(new Date(now));

    now += 120_000;
    await link.receive(ack(issue(goto(true)), "ACCEPTED"));

    expect(store.mission(MISSION)?.currentTargetSince).toEqual(started);
  });
});

describe("every capture kept, against the object it shows", () => {
  it("files a capture against the object the agent reports, when the mission was sent there", async () => {
    const link = await online();
    await link.receive(ack(issue(retarget()), "ACCEPTED"));
    const capture = issue(envelope("CAPTURE", { kind: "CAPTURE", imagingProfile: "PLANETARY" }));

    await link.receive(captureReady(capture, NEXT));

    expect(broadcast.captures[0]?.targetId).toBe(NEXT);
  });

  it("does not file a capture against an object this mission was never sent to", async () => {
    const link = await online();
    const capture = issue(envelope("CAPTURE", { kind: "CAPTURE", imagingProfile: "PLANETARY" }));

    await link.receive(captureReady(capture, STRANGER));

    expect(broadcast.captures[0]?.targetId).toBe(BOOKED);
  });

  it("uses the current object when an older agent reports none", async () => {
    store.mission(MISSION)!.currentTargetId = NEXT;
    const link = await online();
    const capture = issue(envelope("CAPTURE", { kind: "CAPTURE", imagingProfile: "PLANETARY" }));

    await link.receive(captureReady(capture, null));

    expect(broadcast.captures[0]?.targetId).toBe(NEXT);
  });

  it("sends no per-capture email for a booked session, and one for a mission nobody booked", async () => {
    const link = await online();
    await link.receive(
      captureReady(issue(envelope("CAPTURE", { kind: "CAPTURE", imagingProfile: "PLANETARY" })), null),
    );
    expect(store.emails).toEqual([]);

    delete store.mission(MISSION)!.slotEndsAt;
    await link.receive(
      captureReady(issue(envelope("CAPTURE", { kind: "CAPTURE", imagingProfile: "PLANETARY" })), null),
    );
    expect(store.emails.map((email) => email.kind)).toEqual(["CAPTURE_READY"]);
  });
});

describe("the picture's UNRECOVERED flag (ADR-080)", () => {
  const unrecovered: ImageHealth = {
    status: "UNRECOVERED",
    reason: "NO_STARS",
    step: null,
    attempt: 2,
    since: "2026-12-15T20:00:00.000Z",
    nextRetryAt: "2026-12-15T20:05:00.000Z",
  };

  it("is written when it changes, not per sample", async () => {
    const link = await online();

    await link.receive(delta({ imageHealth: null }));
    await link.receive(delta({ imageHealth: unrecovered }));
    await link.receive(delta({ imageHealth: unrecovered }));
    await link.receive(delta({ imageHealth: { ...unrecovered, status: "OK", reason: null } }));

    expect(store.imageHealthWrites).toEqual([
      { missionId: MISSION, unrecovered: false },
      { missionId: MISSION, unrecovered: true },
      { missionId: MISSION, unrecovered: false },
    ]);
    expect(store.mission(MISSION)?.imageUnrecoveredSince).toBeNull();
  });
});

describe("the session ends once the mount reports parked (ADR-079 §6)", () => {
  async function ended() {
    const link = await online();
    await link.receive(missionEvent("COMPLETE"));
    return link;
  }

  it("relays the park to the ended mission's channel though the delta names no mission", async () => {
    const link = await ended();

    await link.receive(delta({ missionId: null, parked: false }));

    expect(broadcast.telemetry.map((entry) => entry.missionId)).toEqual([MISSION]);
    expect(broadcast.ended).toEqual([]);
  });

  it("sends MISSION_SESSION_ENDED once, with the captures, and queues one summary", async () => {
    store.missionEvents.push({
      missionId: MISSION,
      state: "OBSERVING",
      failureReason: null,
      source: "AGENT",
      commandId: null,
      message: null,
      occurredAt: new Date(now),
      simulated: true,
      isDemo: false,
    });
    const link = await online();
    await link.receive(
      captureReady(issue(envelope("CAPTURE", { kind: "CAPTURE", imagingProfile: "PLANETARY" })), null),
    );
    await link.receive(missionEvent("COMPLETE"));

    await link.receive(delta({ missionId: null, parked: true }));
    await link.receive(delta({ missionId: null, parked: true }));

    expect(broadcast.ended).toHaveLength(1);
    expect(broadcast.ended[0]).toMatchObject({
      missionId: MISSION,
      state: "COMPLETE",
      endReason: "SLOT_ENDED",
      parked: true,
      captureIds: [broadcast.captures[0]?.id],
      summaryEmailQueued: true,
    });
    expect(store.emails.filter((email) => email.kind === "SESSION_SUMMARY")).toHaveLength(1);
  });

  it("queues no summary for a session that never reached OBSERVING", async () => {
    const link = await ended();

    await link.receive(delta({ missionId: null, parked: true }));

    expect(broadcast.ended[0]).toMatchObject({ summaryEmailQueued: false });
    expect(store.emails).toEqual([]);
  });

  it("stops following the ended mission after 300 seconds", async () => {
    const link = await ended();

    now += 301_000;
    await link.receive(delta({ missionId: null, parked: true }));

    expect(broadcast.telemetry).toEqual([]);
    expect(broadcast.ended).toEqual([]);
  });
});

describe("telling the agent a session ended rather than rotated", () => {
  it("carries SLOT_ENDED only with a null session", () => {
    expect(cloudSessionUpdate(MISSION, null, "SLOT_ENDED")).toMatchObject({
      sessionId: null,
      endReason: "SLOT_ENDED",
    });
  });

  it("leaves a plain revocation without an end reason, so the mission observes on", () => {
    expect(cloudSessionUpdate(MISSION, null)).not.toHaveProperty("endReason");
    expect(
      cloudSessionUpdate(
        MISSION,
        { sessionId: SESSION, userId: OWNER, expiresAt: new Date(now) },
        "SLOT_ENDED",
      ),
    ).not.toHaveProperty("endReason");
  });
});
