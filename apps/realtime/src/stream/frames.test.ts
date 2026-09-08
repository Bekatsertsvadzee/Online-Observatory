import { beforeEach, describe, expect, it } from "vitest";

import {
  LIVE_FRAME_MAX_AGE_SECONDS,
  LiveFrameStore,
  type LiveFrame,
} from "@/stream/frames";

const OBSERVATORY = "11111111-1111-4111-8111-111111111111";
const OTHER_OBSERVATORY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MISSION = "22222222-2222-4222-8222-222222222222";
const OTHER_MISSION = "55555555-5555-4555-8555-555555555555";

let store: LiveFrameStore;
let now: number;

function frame(overrides: Partial<LiveFrame> = {}): LiveFrame {
  return {
    missionId: MISSION,
    observatoryId: OBSERVATORY,
    mode: "SIMULATED",
    encoding: "JPEG",
    sequence: 0,
    bytes: Buffer.from([0xff, 0xd8, 0xff]),
    receivedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  store = new LiveFrameStore();
  now = Date.parse("2026-09-08T21:00:00.000Z");
});

describe("latest frame wins", () => {
  it("keeps one frame per mission however many arrive", () => {
    // Not a buffer and not a queue. Queueing would turn a dropped frame -- which
    // nobody notices -- into growing latency, which everybody does.
    for (let sequence = 0; sequence < 50; sequence += 1) {
      store.publish(frame({ sequence, bytes: Buffer.from([sequence]) }));
    }

    expect(store.size).toBe(1);
    expect(store.latest(MISSION)?.sequence).toBe(49);
    expect([...(store.latest(MISSION)?.bytes ?? [])]).toEqual([49]);
  });

  it("keeps missions apart", () => {
    store.publish(frame({ sequence: 1 }));
    store.publish(frame({ missionId: OTHER_MISSION, sequence: 2 }));

    expect(store.latest(MISSION)?.sequence).toBe(1);
    expect(store.latest(OTHER_MISSION)?.sequence).toBe(2);
  });

  it("has nothing for a mission that never streamed", () => {
    expect(store.latest(MISSION)).toBeNull();
  });
});

describe("who is reading", () => {
  it("hands every new frame to every listener", () => {
    const first: number[] = [];
    const second: number[] = [];
    store.listen(MISSION, { frame: (f) => first.push(f.sequence), end: () => {} });
    store.listen(MISSION, { frame: (f) => second.push(f.sequence), end: () => {} });

    store.publish(frame({ sequence: 7 }));
    store.publish(frame({ sequence: 8 }));

    expect(first).toEqual([7, 8]);
    expect(second).toEqual([7, 8]);
  });

  it("does not deliver another mission's frames", () => {
    const seen: number[] = [];
    store.listen(MISSION, { frame: (f) => seen.push(f.sequence), end: () => {} });

    store.publish(frame({ missionId: OTHER_MISSION, sequence: 3 }));

    expect(seen).toEqual([]);
  });

  it("survives a listener that unsubscribes itself mid-publish", () => {
    // A dead socket does exactly this: the write fails, `close` fires, and the
    // listener removes itself from the set being iterated. Iterating the live set
    // would silently skip whoever followed it.
    const seen: string[] = [];
    const stopFirst = store.listen(MISSION, {
      frame: () => {
        seen.push("first");
        stopFirst();
      },
      end: () => {},
    });
    store.listen(MISSION, { frame: () => seen.push("second"), end: () => {} });

    store.publish(frame());

    expect(seen).toEqual(["first", "second"]);
  });

  it("stops delivering after unsubscribe", () => {
    const seen: number[] = [];
    const stop = store.listen(MISSION, {
      frame: (f) => seen.push(f.sequence),
      end: () => {},
    });

    store.publish(frame({ sequence: 1 }));
    stop();
    store.publish(frame({ sequence: 2 }));

    expect(seen).toEqual([1]);
  });
});

describe("letting go", () => {
  it("forgets the frame and closes everyone reading it", () => {
    let ended = 0;
    store.listen(MISSION, { frame: () => {}, end: () => (ended += 1) });
    store.publish(frame());

    store.release(MISSION);

    expect(ended).toBe(1);
    expect(store.latest(MISSION)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("delivers nothing to a listener after its mission was released", () => {
    const seen: number[] = [];
    store.listen(MISSION, { frame: (f) => seen.push(f.sequence), end: () => {} });
    store.publish(frame({ sequence: 1 }));

    store.release(MISSION);
    store.publish(frame({ sequence: 2 }));

    expect(seen).toEqual([1]);
  });

  it("releases one observatory's missions and leaves the others", () => {
    store.publish(frame());
    store.publish(frame({ missionId: OTHER_MISSION, observatoryId: OTHER_OBSERVATORY }));

    expect(store.releaseObservatory(OBSERVATORY)).toBe(1);
    expect(store.latest(MISSION)).toBeNull();
    expect(store.latest(OTHER_MISSION)).not.toBeNull();
  });

  it("releases a mission that simply stopped sending", () => {
    // No event says "the agent crashed". Without this the last frame of every
    // abandoned mission stays in a process designed to run for months.
    let ended = 0;
    store.publish(frame());
    store.listen(MISSION, { frame: () => {}, end: () => (ended += 1) });

    const stale = now + (LIVE_FRAME_MAX_AGE_SECONDS + 1) * 1000;
    expect(store.releaseStale(now + 1000)).toBe(0);
    expect(store.releaseStale(stale)).toBe(1);
    expect(ended).toBe(1);
    expect(store.size).toBe(0);
  });
});
