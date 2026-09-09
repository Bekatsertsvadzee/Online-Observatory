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
 * DV-062 on the realtime side: what the link writes down.
 *
 * The audit categories AGENT_LINK and COMMAND had no writer anywhere, and
 * `Observatory.status` keeps only the latest state -- so a link that dropped four
 * times in half an hour left one row saying it was up. The correlation between a
 * command and the transition it caused was in the contract and on the wire and was
 * discarded at the cloud.
 *
 * These run against the in-memory store, which mirrors the Prisma one. The
 * database's own behaviour -- the foreign key, the ordering -- is asserted in the
 * integration suite.
 */
const observatory: ObservatoryRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "tbilisi",
  mode: "SIMULATED",
};

const MISSION = "22222222-2222-4222-8222-222222222222";
const ANOTHER_OBSERVATORY = "99999999-9999-4999-8999-999999999999";

let store: FakeLinkStore;
let broadcast: RecordingBroadcast;
let sent: CloudToAgentMessage[];
let now: number;

async function onlineLink(hello: Record<string, unknown> = {}) {
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
      ...hello,
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
    state: "CENTERING",
    failureReason: null,
    occurredAt: new Date(now).toISOString(),
    detail: null,
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
    status: "COMPLETED",
    rejectionReason: null,
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
});

describe("the link's own history", () => {
  it("writes a row when the link comes up", async () => {
    await onlineLink();

    expect(store.auditEvents).toContainEqual(
      expect.objectContaining({
        category: "AGENT_LINK",
        action: "AGENT_LINK_UP",
        entityId: observatory.id,
      }),
    );
  });

  it("writes a row every time it drops, not just the latest", async () => {
    const lostAt = new Date(now);
    await store.markLinkLost(observatory.id, lostAt);
    await store.markLinkUp(observatory.id);
    await store.markLinkLost(observatory.id, new Date(now + 60_000));

    // Observatory.status answers "is it up now". Reconstructing a night needs the
    // sequence, and that is the whole reason these rows exist.
    const linkRows = store.auditEvents.filter((row) => row.category === "AGENT_LINK");
    expect(linkRows.map((row) => row.action)).toEqual([
      "AGENT_LINK_LOST",
      "AGENT_LINK_UP",
      "AGENT_LINK_LOST",
    ]);
    expect(linkRows[0]?.detail).toEqual({ lostAt: lostAt.toISOString() });
  });
});

describe("a command's verdict", () => {
  it("is written down, correlated to the command it judged", async () => {
    const commandId = randomUUID();
    mintCommand(commandId);
    const link = await onlineLink();

    await link.receive(
      commandAck(commandId, {
        status: "REJECTED",
        rejectionReason: "SAFETY_ABOVE_MAX_ALTITUDE",
      }),
    );

    expect(store.auditEvents).toContainEqual(
      expect.objectContaining({
        category: "COMMAND",
        action: "COMMAND_VERDICT_RECORDED",
        commandId,
        detail: expect.objectContaining({
          status: "REJECTED",
          rejectionReason: "SAFETY_ABOVE_MAX_ALTITUDE",
        }),
      }),
    );
  });

  it("is not written for an ack the cloud refused to apply", async () => {
    const commandId = randomUUID();
    mintCommand(commandId, ANOTHER_OBSERVATORY);
    const link = await onlineLink();

    await link.receive(commandAck(commandId));

    // The verdict belongs to another observatory's command. Nothing was applied,
    // so an audit row claiming a verdict was recorded would be a false account.
    expect(store.auditEvents.filter((row) => row.category === "COMMAND")).toEqual([]);
  });
});

describe("a mission event's correlation", () => {
  it("keeps the command that caused the transition", async () => {
    const commandId = randomUUID();
    mintCommand(commandId);
    const link = await onlineLink();

    await link.receive(missionEvent({ commandId }));

    expect(store.missionEvents.at(-1)).toMatchObject({ state: "CENTERING", commandId });
  });

  it("keeps the failure reason on the event, not only on the mission", async () => {
    const link = await onlineLink();

    await link.receive(missionEvent({ state: "FAILED", failureReason: "SLEW_TIMEOUT" }));

    // The mission carries its latest failure. The trail has to show which
    // transition carried which reason, or a mission that held and then failed
    // reads as though it only ever failed.
    expect(store.missionEvents.at(-1)).toMatchObject({
      state: "FAILED",
      failureReason: "SLEW_TIMEOUT",
    });
  });

  it("drops a correlation to a command this observatory does not own", async () => {
    const commandId = randomUUID();
    mintCommand(commandId, ANOTHER_OBSERVATORY);
    const link = await onlineLink();

    await link.receive(missionEvent({ commandId }));

    // The transition is still written -- it really happened. Only the claim about
    // which command caused it is dropped, because the cloud cannot support it.
    expect(store.missionEvents.at(-1)).toMatchObject({
      state: "CENTERING",
      commandId: null,
    });
  });

  it("drops a correlation to a command the cloud never minted", async () => {
    const link = await onlineLink();

    await link.receive(missionEvent({ commandId: randomUUID() }));

    expect(store.missionEvents.at(-1)).toMatchObject({ commandId: null });
  });
});

describe("a mission the cloud closed out", () => {
  it("says so, and says it was the cloud that decided", async () => {
    store.addMission(MISSION, { observatoryId: observatory.id, state: "SLEWING" });

    await onlineLink({ resumeMissionId: MISSION });

    expect(store.auditEvents).toContainEqual(
      expect.objectContaining({
        category: "MISSION",
        action: "MISSION_RESOLVED_AFTER_AGENT_RESTART",
        missionId: MISSION,
      }),
    );
    expect(store.missionEvents.at(-1)).toMatchObject({
      source: "CLOUD",
      state: "FAILED",
      failureReason: "AGENT_LINK_LOST",
    });
  });
});
