import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { CommandEnvelope } from "@darkview/contracts";

import { AgentLink } from "@/link/agent-link";
import { FakeLinkStore } from "@/link/fake-store";
import { FAKE_STORAGE } from "@/link/fake-storage";
import { PROTOCOL_VERSION } from "@/link/protocol";
import type { ObservatoryRecord } from "@/link/store";
import { RecordingBroadcast } from "@/mission/fake-broadcast";

/**
 * ADR-018 §3 and §4, as rules. The integration suite proves them against the index
 * and the notification channel; these prove which missions they touch.
 */
const observatory: ObservatoryRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "tbilisi",
  mode: "SIMULATED",
};

const MISSION_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const COMMAND_ID = "55555555-5555-4555-8555-555555555555";
const TARGET_ID = "66666666-6666-4666-8666-666666666666";

let store: FakeLinkStore;
let now: number;

function gotoEnvelope(recenter: boolean): CommandEnvelope {
  return {
    commandId: COMMAND_ID,
    missionId: MISSION_ID,
    sessionId: SESSION_ID,
    userId: USER_ID,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
    type: "GOTO",
    payload: {
      kind: "GOTO",
      targetId: TARGET_ID,
      coordinates: { raHours: 16.6949, decDegrees: 36.4613, epoch: "J2000" },
      opticalConfig: "F10_NATIVE",
      imagingProfile: "GLOBULAR_CLUSTER",
      recenter,
    },
  };
}

async function onlineLink() {
  const link = new AgentLink(
    observatory,
    store,
    () => {},
    () => {},
    new RecordingBroadcast(),
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
      safetyEnvelopeConfigured: true,
      resumeMissionId: null,
    }),
  );
  return link;
}

function refusal(rejectionReason: string) {
  return JSON.stringify({
    type: "AGENT_COMMAND_ACK",
    messageId: randomUUID(),
    sentAt: new Date(now).toISOString(),
    commandId: COMMAND_ID,
    missionId: MISSION_ID,
    status: "REJECTED",
    rejectionReason,
    detail: "refused by the agent",
  });
}

function prepare(state: "PREPARING" | "SLEWING", recenter: boolean) {
  store.addMission(MISSION_ID, { observatoryId: observatory.id, state });
  store.setActiveSession(observatory.id, {
    sessionId: SESSION_ID,
    missionId: MISSION_ID,
    userId: USER_ID,
    expiresAt: new Date(now + 20 * 60_000),
  });
  store.addCommand({ observatoryId: observatory.id, envelope: gotoEnvelope(recenter) });
}

beforeEach(() => {
  store = new FakeLinkStore();
  now = Date.parse("2026-12-15T20:00:00.000Z");
});

describe("a start the agent refuses", () => {
  it("fails the mission, revokes its session and says why", async () => {
    prepare("PREPARING", false);
    const link = await onlineLink();

    await link.receive(refusal("SAFETY_ABOVE_MAX_ALTITUDE"));

    expect(store.mission(MISSION_ID)).toMatchObject({
      state: "FAILED",
      failureReason: "SAFETY_REFUSED",
    });
    expect(store.missionEvents.at(-1)).toMatchObject({
      state: "FAILED",
      source: "CLOUD",
      commandId: COMMAND_ID,
    });
    expect(store.revoked).toEqual([
      { sessionId: SESSION_ID, reason: "START_REFUSED_BY_AGENT" },
    ]);
    expect(store.auditEvents.map((event) => event.action)).toContain(
      "MISSION_START_REFUSED_BY_AGENT",
    );
  });

  it("files a refusal that is not the envelope's with no failure reason", async () => {
    prepare("PREPARING", false);
    const link = await onlineLink();

    await link.receive(refusal("DEVICE_UNAVAILABLE"));

    expect(store.mission(MISSION_ID)).toMatchObject({ state: "FAILED", failureReason: null });
  });

  it("leaves the mission alone when the refused GOTO was a recentre", async () => {
    prepare("PREPARING", true);
    const link = await onlineLink();

    await link.receive(refusal("SAFETY_ABOVE_MAX_ALTITUDE"));

    expect(store.mission(MISSION_ID)?.state).toBe("PREPARING");
    expect(store.revoked).toEqual([]);
  });

  it("leaves a mission that is already past PREPARING alone", async () => {
    prepare("SLEWING", false);
    const link = await onlineLink();

    await link.receive(refusal("SAFETY_ABOVE_MAX_ALTITUDE"));

    expect(store.mission(MISSION_ID)?.state).toBe("SLEWING");
  });
});

describe("a slot nobody started", () => {
  const ENDED = "77777777-7777-4777-8777-777777777777";
  const RUNNING_SLOT = "88888888-8888-4888-8888-888888888888";
  const STARTED = "99999999-9999-4999-8999-999999999999";

  beforeEach(() => {
    store.addMission(ENDED, {
      observatoryId: observatory.id,
      state: "SCHEDULED",
      slotEndsAt: new Date(now - 1),
    });
    store.addMission(RUNNING_SLOT, {
      observatoryId: observatory.id,
      state: "SCHEDULED",
      slotEndsAt: new Date(now + 60_000),
    });
    store.addMission(STARTED, {
      observatoryId: observatory.id,
      state: "PREPARING",
      slotEndsAt: new Date(now - 1),
    });
  });

  it("closes only the scheduled missions whose slot has ended", async () => {
    await expect(store.closeUnstartedMissions(new Date(now))).resolves.toEqual([ENDED]);

    expect(store.mission(ENDED)).toMatchObject({
      state: "CANCELLED",
      failureReason: "SESSION_EXPIRED",
    });
    expect(store.mission(RUNNING_SLOT)?.state).toBe("SCHEDULED");
    expect(store.mission(STARTED)?.state).toBe("PREPARING");
    expect(store.auditEvents.map((event) => event.action)).toEqual(["MISSION_NOT_STARTED"]);
  });

  it("closes nothing twice", async () => {
    await store.closeUnstartedMissions(new Date(now));

    await expect(store.closeUnstartedMissions(new Date(now))).resolves.toEqual([]);
  });
});
