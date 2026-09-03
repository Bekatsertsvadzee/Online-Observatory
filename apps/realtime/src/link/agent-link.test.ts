import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { CloudToAgentMessage } from "@darkview/contracts";

import { AgentLink } from "@/link/agent-link";
import { FakeLinkStore } from "@/link/fake-store";
import { AgentLinkRegistry } from "@/link/registry";
import { HEARTBEAT_GRACE_SECONDS, PROTOCOL_VERSION } from "@/link/protocol";
import type { ObservatoryRecord } from "@/link/store";

const observatory: ObservatoryRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "tbilisi",
  mode: "SIMULATED",
};

let store: FakeLinkStore;
let sent: CloudToAgentMessage[];
let closedWith: string[];
let now: number;

function makeLink(record: ObservatoryRecord = observatory) {
  return new AgentLink(
    record,
    store,
    (message) => sent.push(message),
    (reason) => closedWith.push(reason),
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
    safetyEnvelopeConfigured: false,
    resumeMissionId: null,
    ...overrides,
  });
}

function heartbeat(messageId = randomUUID(), sequence = 1) {
  return JSON.stringify({
    type: "AGENT_HEARTBEAT",
    messageId,
    sentAt: new Date(now).toISOString(),
    sequence,
    uptimeSeconds: 60,
  });
}

beforeEach(() => {
  store = new FakeLinkStore();
  sent = [];
  closedWith = [];
  now = Date.parse("2026-09-03T20:00:00.000Z");
});

describe("hello", () => {
  it("welcomes an agent speaking the supported protocol", async () => {
    const link = makeLink();
    await link.receive(hello());

    expect(link.currentState).toBe("ONLINE");
    expect(sent.at(0)).toMatchObject({
      type: "CLOUD_WELCOME",
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(store.linkUp).toEqual([observatory.id]);
  });

  // criterion 5
  it("refuses an unsupported protocol version and closes the link", async () => {
    const link = makeLink();
    await link.receive(hello({ protocolVersion: "1", type: "AGENT_HELLO" }));
    expect(link.currentState).toBe("ONLINE");

    const other = makeLink();
    await other.receive(hello({ protocolVersion: "99" }));

    expect(other.currentState).toBe("CLOSED");
    expect(closedWith).toContain("unsupported protocol version");
    expect(store.linkUp).not.toContain(observatory.id + "-99");
  });

  it("refuses a valid token used to claim another observatory", async () => {
    const link = makeLink();
    await link.receive(hello({ observatoryId: "22222222-2222-4222-8222-222222222222" }));

    expect(link.currentState).toBe("CLOSED");
    expect(sent.at(0)).toMatchObject({ type: "CLOUD_ERROR", code: "FORBIDDEN" });
  });

  it("rejects any message that arrives before hello", async () => {
    const link = makeLink();
    await link.receive(heartbeat());

    expect(link.currentState).toBe("CLOSED");
    expect(sent.at(0)).toMatchObject({ type: "CLOUD_ERROR", fatal: true });
    expect(store.recorded).toEqual([]);
  });
});

// criterion 4
describe("malformed input", () => {
  it.each([
    ["not JSON at all", "<html>502 Bad Gateway</html>"],
    ["JSON that is not an object", "42"],
    ["an unknown message type", JSON.stringify({ type: "AGENT_LOL", messageId: "x" })],
    [
      "a known type with a missing required field",
      JSON.stringify({ type: "AGENT_HEARTBEAT", messageId: randomUUID() }),
    ],
    [
      "a messageId that is not a uuid",
      JSON.stringify({
        type: "AGENT_HEARTBEAT",
        messageId: "not-a-uuid",
        sentAt: new Date().toISOString(),
        sequence: 1,
        uptimeSeconds: 1,
      }),
    ],
  ])("answers %s with CLOUD_ERROR and keeps serving", async (_label, raw) => {
    const link = makeLink();
    await link.receive(hello());
    sent.length = 0;

    await link.receive(raw);

    expect(sent.at(0)).toMatchObject({ type: "CLOUD_ERROR", code: "BAD_REQUEST" });
    expect(link.currentState).toBe("ONLINE");
    expect(store.recorded).toHaveLength(1); // the hello only
  });
});

// criterion 7
describe("replay after an outage", () => {
  it("does not write a second row for a replayed message", async () => {
    const link = makeLink();
    await link.receive(hello());

    const replayed = randomUUID();
    await link.receive(heartbeat(replayed, 7));
    await link.receive(heartbeat(replayed, 7));
    await link.receive(heartbeat(replayed, 7));

    const heartbeats = store.recorded.filter((m) => m.type === "AGENT_HEARTBEAT");
    expect(heartbeats).toHaveLength(1);
    expect(link.currentState).toBe("ONLINE");
  });

  it("keeps the agent's own sentAt rather than rewriting it to now", async () => {
    const link = makeLink();
    await link.receive(hello());

    const occurredDuringOutage = "2026-09-03T19:30:00.000Z";
    await link.receive(
      JSON.stringify({
        type: "AGENT_HEARTBEAT",
        messageId: randomUUID(),
        sentAt: occurredDuringOutage,
        sequence: 3,
        uptimeSeconds: 10,
      }),
    );

    const stored = store.recorded.at(-1);
    expect(stored?.sentAt.toISOString()).toBe(occurredDuringOutage);
  });
});

// criterion 3
describe("heartbeat enforcement", () => {
  it("closes a silent link and records the observatory as having lost it", async () => {
    const link = makeLink();
    await link.receive(hello());

    now += HEARTBEAT_GRACE_SECONDS * 1000 + 1;
    expect(link.isExpired(now)).toBe(true);

    await link.expire();

    expect(link.currentState).toBe("CLOSED");
    expect(closedWith).toContain("heartbeat lost");
    expect(store.linkLost).toEqual([
      { observatoryId: observatory.id, at: new Date(now) },
    ]);
  });

  it("leaves a link alone while heartbeats keep arriving", async () => {
    const link = makeLink();
    await link.receive(hello());

    for (let beat = 0; beat < 10; beat += 1) {
      now += (HEARTBEAT_GRACE_SECONDS * 1000) / 2;
      await link.receive(heartbeat(randomUUID(), beat));
      expect(link.isExpired(now)).toBe(false);
    }

    expect(link.currentState).toBe("ONLINE");
    expect(store.linkLost).toEqual([]);
  });
});

// criterion 2
describe("one connection per observatory", () => {
  it("refuses the second connection and preserves the first", async () => {
    const registry = new AgentLinkRegistry();
    const incumbent = makeLink();
    const challenger = makeLink();

    expect(registry.admit(observatory.id, incumbent)).toEqual({ admitted: true });
    expect(registry.admit(observatory.id, challenger)).toEqual({
      admitted: false,
      reason: "already-connected",
    });

    expect(registry.get(observatory.id)).toBe(incumbent);
    expect(incumbent.currentState).not.toBe("CLOSED");
    expect(registry.size).toBe(1);
  });

  it("does not let a stale link's release evict its replacement", async () => {
    const registry = new AgentLinkRegistry();
    const first = makeLink();
    const second = makeLink();

    registry.admit(observatory.id, first);
    registry.release(observatory.id, first);
    registry.admit(observatory.id, second);

    registry.release(observatory.id, first); // late close from the old socket
    expect(registry.get(observatory.id)).toBe(second);
  });

  it("expires only the silent links in a sweep", async () => {
    const registry = new AgentLinkRegistry();
    const quiet = makeLink();
    const busy = makeLink({ ...observatory, id: "33333333-3333-4333-8333-333333333333" });

    registry.admit(observatory.id, quiet);
    registry.admit(busy.observatory.id, busy);

    now += HEARTBEAT_GRACE_SECONDS * 1000 + 1;
    await busy.receive(hello({ observatoryId: busy.observatory.id }));

    const expired = await registry.expireSilent(now);

    expect(expired).toEqual([observatory.id]);
    expect(registry.get(busy.observatory.id)).toBe(busy);
  });
});
