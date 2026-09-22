import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { CloudToAgentMessage } from "@darkview/contracts";

import { AgentLink } from "@/link/agent-link";
import { FakeLinkStore } from "@/link/fake-store";
import { FAKE_STORAGE } from "@/link/fake-storage";
import {
  MAX_BINARY_BYTES,
  MAX_TEXT_BYTES,
  PROTOCOL_VERSION,
  parseAgentMessage,
} from "@/link/protocol";
import type { ObservatoryRecord } from "@/link/store";
import { RecordingBroadcast } from "@/mission/fake-broadcast";
import { parseClientMessage } from "@/mission/protocol";

const observatory: ObservatoryRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "tbilisi",
  mode: "SIMULATED",
};

const MISSION = "22222222-2222-4222-8222-222222222222";
const PIXELS = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

let store: FakeLinkStore;
let broadcast: RecordingBroadcast;
let sent: CloudToAgentMessage[];
let closed: string | null;
let now: number;

function makeLink() {
  return new AgentLink(
    observatory,
    store,
    (message) => sent.push(message),
    (reason) => {
      closed = reason;
    },
    broadcast,
    FAKE_STORAGE,
    () => now,
  );
}

function header(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "AGENT_LIVE_FRAME",
    messageId: randomUUID(),
    sentAt: new Date(now).toISOString(),
    missionId: MISSION,
    sequence: 0,
    capturedAt: new Date(now).toISOString(),
    encoding: "JPEG",
    widthPx: 1024,
    heightPx: 576,
    byteLength: PIXELS.byteLength,
    exposureMilliseconds: 500,
    gain: 200,
    mode: "SIMULATED",
    ...overrides,
  });
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
    posture: "SIMULATED",
    bootedAt: new Date(now).toISOString(),
    safetyEnvelopeConfigured: false,
    resumeMissionId: null,
    ...overrides,
  });
}

async function online() {
  const link = makeLink();
  await link.receive(hello());
  sent.length = 0;
  return link;
}

beforeEach(() => {
  store = new FakeLinkStore();
  broadcast = new RecordingBroadcast();
  sent = [];
  closed = null;
  now = Date.parse("2026-09-21T21:00:00.000Z");
  store.addMission(MISSION, { observatoryId: observatory.id, state: "OBSERVING" });
});

describe("the contract's bound on a live frame", () => {
  it("accepts a header declaring exactly the maximum", () => {
    const parsed = parseAgentMessage(header({ byteLength: MAX_BINARY_BYTES }));

    expect(parsed.ok).toBe(true);
  });

  it("refuses a header declaring one byte more", () => {
    const parsed = parseAgentMessage(header({ byteLength: MAX_BINARY_BYTES + 1 }));

    expect(parsed.ok).toBe(false);
  });

  it("answers an oversized header with BAD_REQUEST and keeps the link", async () => {
    const link = await online();

    await link.receive(header({ byteLength: MAX_BINARY_BYTES + 1 }));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "CLOUD_ERROR", code: "BAD_REQUEST" });
    expect(closed).toBeNull();
    expect(link.currentState).toBe("ONLINE");
  });

  it("never broadcasts pixels for a header it refused", async () => {
    const link = await online();

    await link.receive(header({ byteLength: MAX_BINARY_BYTES + 1 }));
    await link.receiveBinary(PIXELS);

    expect(broadcast.frames).toHaveLength(0);
  });

  it("drops a pending header when the next message is refused", async () => {
    // The mispairing this closes: a good header, then a refused one, then pixels.
    // Without the reset those pixels pair with the first header and are served as
    // that frame -- one frame's bytes presented as another's.
    const link = await online();

    await link.receive(header({ sequence: 1 }));
    await link.receive(header({ sequence: 2, byteLength: MAX_BINARY_BYTES + 1 }));
    await link.receiveBinary(PIXELS);

    expect(broadcast.frames).toHaveLength(0);
  });
});

describe("the bound on a JSON message", () => {
  it("refuses a message over the text limit, and says so", () => {
    const parsed = parseAgentMessage(
      header({ encoding: "JPEG", sentAt: "x".repeat(MAX_TEXT_BYTES) }),
    );

    expect(parsed).toEqual({ ok: false, reason: `over ${MAX_TEXT_BYTES} bytes` });
  });

  it("answers an oversized message online and survives it", async () => {
    const link = await online();

    await link.receive(header({ sentAt: "x".repeat(MAX_TEXT_BYTES) }));

    expect(sent[0]).toMatchObject({ type: "CLOUD_ERROR", code: "BAD_REQUEST" });
    expect(link.currentState).toBe("ONLINE");
    expect(closed).toBeNull();
  });

  it("closes a connection whose hello is oversized", async () => {
    const link = makeLink();

    await link.receive(hello({ agentVersion: "x".repeat(MAX_TEXT_BYTES) }));

    expect(sent[0]).toMatchObject({ type: "CLOUD_ERROR", code: "BAD_REQUEST", fatal: true });
    expect(link.currentState).toBe("CLOSED");
    expect(closed).not.toBeNull();
  });

  it("bounds the mission channel's messages on the same rule", () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        type: "CLIENT_PING",
        messageId: randomUUID(),
        sentAt: new Date(now).toISOString(),
        missionId: MISSION,
        padding: "x".repeat(MAX_TEXT_BYTES),
      }),
    );

    expect(parsed).toEqual({ ok: false, reason: `over ${MAX_TEXT_BYTES} bytes` });
  });
});
