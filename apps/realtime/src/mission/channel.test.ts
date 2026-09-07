import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { MissionChannelMessage } from "@darkview/contracts";

import { FakeLinkStore } from "@/link/fake-store";
import { MissionChannel } from "@/mission/channel";
import { CLIENT_IDLE_GRACE_SECONDS } from "@/mission/protocol";
import type { ChannelUser } from "@/mission/store";

const OBSERVATORY = "11111111-1111-4111-8111-111111111111";
const MISSION = "22222222-2222-4222-8222-222222222222";
const OTHER_MISSION = "33333333-3333-4333-8333-333333333333";

const owner: ChannelUser = { id: "44444444-4444-4444-8444-444444444444", role: "USER" };
const stranger: ChannelUser = {
  id: "55555555-5555-4555-8555-555555555555",
  role: "USER",
};

let store: FakeLinkStore;
let sent: MissionChannelMessage[];
let closedWith: string[];
let now: number;
let sessionId: string;

function makeChannel(user: ChannelUser = owner, missionId = MISSION) {
  return new MissionChannel(
    missionId,
    user,
    store,
    (message) => sent.push(message),
    (reason) => closedWith.push(reason),
    () => now,
  );
}

function subscribe(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "CLIENT_SUBSCRIBE",
    messageId: randomUUID(),
    sentAt: new Date(now).toISOString(),
    missionId: MISSION,
    sessionId,
    ...overrides,
  });
}

function ping() {
  return JSON.stringify({
    type: "CLIENT_PING",
    messageId: randomUUID(),
    sentAt: new Date(now).toISOString(),
  });
}

beforeEach(() => {
  store = new FakeLinkStore();
  sent = [];
  closedWith = [];
  now = Date.parse("2026-09-07T21:00:00.000Z");
  sessionId = randomUUID();

  store.addMission(MISSION, { observatoryId: OBSERVATORY, state: "OBSERVING" });
  store.addMission(OTHER_MISSION, { observatoryId: OBSERVATORY, state: "OBSERVING" });
  store.setActiveSession(OBSERVATORY, {
    sessionId,
    missionId: MISSION,
    userId: owner.id,
    expiresAt: new Date(now + 30 * 60_000),
  });
});

describe("who may subscribe", () => {
  it("admits the user the session was issued to", async () => {
    const channel = makeChannel();
    await channel.receive(subscribe());

    expect(channel.currentState).toBe("SUBSCRIBED");
    expect(closedWith).toEqual([]);
  });

  it("refuses a user holding somebody else's sessionId", async () => {
    // The cookie check during the upgrade proved who this is; it proved nothing
    // about which mission they may watch. Without the ownership test here, any
    // signed-in customer who learned a live sessionId could watch that mission.
    const channel = makeChannel(stranger);
    await channel.receive(subscribe());

    expect(channel.currentState).toBe("CLOSED");
    expect(sent).toEqual([
      expect.objectContaining({ type: "MISSION_ERROR", code: "FORBIDDEN" }),
    ]);
  });

  it("refuses a session issued for a different mission", async () => {
    const channel = makeChannel(owner, OTHER_MISSION);
    await channel.receive(subscribe({ missionId: OTHER_MISSION }));

    expect(channel.currentState).toBe("CLOSED");
  });

  it("refuses a subscribe naming a mission other than the one in the URL", async () => {
    const channel = makeChannel();
    await channel.receive(subscribe({ missionId: OTHER_MISSION }));

    expect(channel.currentState).toBe("CLOSED");
  });

  it("refuses a revoked session", async () => {
    store.revokeSession(sessionId);
    const channel = makeChannel();
    await channel.receive(subscribe());

    expect(channel.currentState).toBe("CLOSED");
  });

  it("refuses a session that has lapsed", async () => {
    now += 31 * 60_000;
    const channel = makeChannel();
    await channel.receive(subscribe());

    expect(channel.currentState).toBe("CLOSED");
  });

  it("says the same thing however the subscribe failed", async () => {
    // A customer probing mission and session ids must not be able to tell
    // "does not exist" from "not yours" -- the rule startMissionSession follows
    // when it answers a stranger 404.
    const refusals: string[] = [];

    for (const attempt of [
      () => makeChannel(stranger).receive(subscribe()),
      () => makeChannel().receive(subscribe({ sessionId: randomUUID() })),
      () => makeChannel().receive(subscribe({ missionId: OTHER_MISSION })),
    ]) {
      sent = [];
      await attempt();
      refusals.push(JSON.stringify(sent.map((m) => "message" in m && m.message)));
    }

    expect(new Set(refusals).size).toBe(1);
  });
});

describe("what a subscriber may say", () => {
  it("cannot be sent to before it has subscribed", async () => {
    const channel = makeChannel();

    expect(channel.dispatch({ type: "MISSION_ERROR" } as MissionChannelMessage)).toBe(
      false,
    );
    expect(sent).toEqual([]);
  });

  it("is closed if it says anything before subscribing", async () => {
    const channel = makeChannel();
    await channel.receive(ping());

    expect(channel.currentState).toBe("CLOSED");
    expect(closedWith).toEqual(["message before subscribe"]);
  });

  it("is closed on a malformed first message", async () => {
    const channel = makeChannel();
    await channel.receive("{not json");

    expect(channel.currentState).toBe("CLOSED");
  });

  it("survives a malformed message once subscribed", async () => {
    const channel = makeChannel();
    await channel.receive(subscribe());
    sent = [];

    await channel.receive(JSON.stringify({ type: "CLIENT_COMMAND" }));

    expect(channel.currentState).toBe("SUBSCRIBED");
    expect(sent).toEqual([
      expect.objectContaining({ type: "MISSION_ERROR", code: "BAD_REQUEST" }),
    ]);
  });

  it("rejects a CommandEnvelope outright -- commands are not a channel message", async () => {
    // The contract: "A client may not send a CommandEnvelope on this channel."
    // The generated validator is what enforces it, and this is the proof that
    // nothing in this class quietly accepts one anyway.
    const channel = makeChannel();
    await channel.receive(subscribe());
    sent = [];

    await channel.receive(
      JSON.stringify({
        type: "CLIENT_SUBSCRIBE",
        messageId: randomUUID(),
        sentAt: new Date(now).toISOString(),
        missionId: MISSION,
        sessionId,
        command: { type: "GOTO", payload: { altitudeDegrees: 89 } },
      }),
    );

    expect(sent).toEqual([
      expect.objectContaining({ type: "MISSION_ERROR", code: "BAD_REQUEST" }),
    ]);
  });

  it("answers a ping with nothing and stays alive", async () => {
    const channel = makeChannel();
    await channel.receive(subscribe());
    sent = [];

    now += 60_000;
    await channel.receive(ping());

    expect(sent).toEqual([]);
    expect(channel.isExpired(now + CLIENT_IDLE_GRACE_SECONDS * 1000)).toBe(false);
  });

  it("expires after the idle grace period", async () => {
    const channel = makeChannel();
    await channel.receive(subscribe());

    expect(channel.isExpired(now + CLIENT_IDLE_GRACE_SECONDS * 1000 + 1)).toBe(true);
  });
});

describe("what a new subscriber is told", () => {
  it("receives the mission's current state immediately", async () => {
    // Without this a customer opening the page during OBSERVING sees an empty
    // panel until the agent's next transition, which can be minutes away.
    const channel = makeChannel();
    await channel.receive(subscribe());

    expect(sent).toEqual([
      expect.objectContaining({
        type: "MISSION_STATE",
        missionId: MISSION,
        state: "OBSERVING",
      }),
    ]);
  });

  it("is not subscribed twice by a second subscribe", async () => {
    const channel = makeChannel();
    await channel.receive(subscribe());
    sent = [];

    await channel.receive(subscribe());

    expect(sent).toEqual([
      expect.objectContaining({ type: "MISSION_ERROR", code: "BAD_REQUEST" }),
    ]);
    expect(channel.currentState).toBe("SUBSCRIBED");
  });
});
