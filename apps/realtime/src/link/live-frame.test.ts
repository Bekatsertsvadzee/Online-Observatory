import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { CloudToAgentMessage } from "@darkview/contracts";

import { AgentLink } from "@/link/agent-link";
import { FakeLinkStore } from "@/link/fake-store";
import { PROTOCOL_VERSION } from "@/link/protocol";
import type { ObservatoryRecord } from "@/link/store";
import { RecordingBroadcast } from "@/mission/fake-broadcast";
import { FAKE_STORAGE } from "@/link/fake-storage";

const observatory: ObservatoryRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "tbilisi",
  mode: "SIMULATED",
};

const MISSION = "22222222-2222-4222-8222-222222222222";
const OTHER_OBSERVATORY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ELSEWHERE = "55555555-5555-4555-8555-555555555555";

const PIXELS = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

let store: FakeLinkStore;
let broadcast: RecordingBroadcast;
let sent: CloudToAgentMessage[];
let now: number;

function makeLink(record: ObservatoryRecord = observatory) {
  return new AgentLink(
    record,
    store,
    (message) => sent.push(message),
    () => {},
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

async function online() {
  const link = makeLink();
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
  sent.length = 0;
  return link;
}

beforeEach(() => {
  store = new FakeLinkStore();
  broadcast = new RecordingBroadcast();
  sent = [];
  now = Date.parse("2026-09-08T21:00:00.000Z");
  store.addMission(MISSION, { observatoryId: observatory.id, state: "OBSERVING" });
});

describe("pairing a header with its pixels", () => {
  it("delivers the frame the two halves describe", async () => {
    const link = await online();

    await link.receive(header({ sequence: 12 }));
    await link.receiveBinary(PIXELS);

    expect(broadcast.frames).toHaveLength(1);
    expect(broadcast.frames[0]).toMatchObject({
      missionId: MISSION,
      observatoryId: observatory.id,
      encoding: "JPEG",
      sequence: 12,
    });
    expect(broadcast.frames[0].bytes.equals(PIXELS)).toBe(true);
  });

  it("pairs correctly when the bytes arrive before the header call settles", async () => {
    // This is how `ws` actually delivers it. Message events fire in order but the
    // library does not wait for an async handler to settle between them, so the
    // binary frame lands while `receive` is still pending. Anything that awaited
    // before storing the header would find nothing to pair with here and drop
    // every frame -- with the link looking perfectly healthy the whole time.
    const link = await online();

    const pending = link.receive(header({ sequence: 3 }));
    await link.receiveBinary(PIXELS);
    await pending;

    expect(broadcast.frames).toHaveLength(1);
    expect(broadcast.frames[0].sequence).toBe(3);
  });

  it("reports the observatory's mode, not the agent's account of itself", async () => {
    // An agent able to set this could present simulator output as telescope
    // output, or real output as a simulation. The row decides.
    store.addMission(ELSEWHERE, { observatoryId: OTHER_OBSERVATORY, state: "OBSERVING" });
    const real: ObservatoryRecord = { ...observatory, mode: "REAL" };
    const link = new AgentLink(real, store, () => {}, () => {}, broadcast, FAKE_STORAGE, () => now);
    await link.receive(
      JSON.stringify({
        type: "AGENT_HELLO",
        messageId: randomUUID(),
        sentAt: new Date(now).toISOString(),
        protocolVersion: PROTOCOL_VERSION,
        observatoryId: real.id,
        agentVersion: "0.1.0",
        mode: "SIMULATED",
        bootedAt: new Date(now).toISOString(),
        safetyEnvelopeConfigured: false,
        resumeMissionId: null,
      }),
    );

    await link.receive(header({ mode: "SIMULATED" }));
    await link.receiveBinary(PIXELS);

    expect(broadcast.frames[0].mode).toBe("REAL");
  });

  it("writes no row per frame", async () => {
    // AgentMessage exists to make the agent's replay idempotent. A live frame is
    // never queued and never replayed, so a row would buy no deduplication and
    // write continuously for the length of every mission.
    const link = await online();
    const before = store.recorded.length;

    for (let sequence = 0; sequence < 20; sequence += 1) {
      await link.receive(header({ sequence }));
      await link.receiveBinary(PIXELS);
    }

    expect(store.recorded.length).toBe(before);
    expect(broadcast.frames).toHaveLength(20);
  });
});

describe("what is refused", () => {
  it("drops binary that no header claimed", async () => {
    const link = await online();

    await link.receiveBinary(PIXELS);

    expect(broadcast.frames).toEqual([]);
    // Silently. A CLOUD_ERROR per stray frame would flood a link that also
    // carries safety verdicts.
    expect(sent).toEqual([]);
  });

  it("drops a payload whose length contradicts its header", async () => {
    const link = await online();

    await link.receive(header({ byteLength: PIXELS.byteLength + 1 }));
    await link.receiveBinary(PIXELS);

    expect(broadcast.frames).toEqual([]);
  });

  it("does not pair a header with the frame after the one that was refused", async () => {
    const link = await online();

    await link.receive(header({ sequence: 1, byteLength: 999 }));
    await link.receiveBinary(PIXELS); // refused, header consumed
    await link.receiveBinary(PIXELS); // unclaimed

    expect(broadcast.frames).toEqual([]);
  });

  it("refuses a frame for a mission belonging to another observatory", async () => {
    store.addMission(ELSEWHERE, { observatoryId: OTHER_OBSERVATORY, state: "OBSERVING" });
    const link = await online();

    await link.receive(header({ missionId: ELSEWHERE }));
    await link.receiveBinary(PIXELS);

    expect(broadcast.frames).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ type: "CLOUD_ERROR", code: "FORBIDDEN" });
  });

  it("drops a second header's pixels when the first never sent any", async () => {
    // The contract says a header is followed by exactly one binary frame. Two
    // headers in a row means the first frame's bytes are not coming, and keeping
    // it would pair a header with somebody else's image.
    const link = await online();

    await link.receive(header({ sequence: 1 }));
    await link.receive(header({ sequence: 2 }));
    await link.receiveBinary(PIXELS);

    expect(broadcast.frames).toHaveLength(1);
    expect(broadcast.frames[0].sequence).toBe(2);
  });

  it("ignores a frame before the hello", async () => {
    const link = makeLink();

    await link.receive(header());
    await link.receiveBinary(PIXELS);

    expect(broadcast.frames).toEqual([]);
  });
});
