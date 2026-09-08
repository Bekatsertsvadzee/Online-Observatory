import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { MissionChannelMessage, MissionStreamInfo } from "@darkview/contracts";

import { FakeLinkStore } from "@/link/fake-store";
import { MissionRelay } from "@/mission/broadcast";
import { MissionChannel } from "@/mission/channel";
import { MissionChannelRegistry } from "@/mission/registry";
import type { ChannelUser } from "@/mission/store";
import type { LiveFrame } from "@/stream/frames";
import { FakeStreamOffers, RecordingFrameSink } from "@/stream/fake-stream";
import { STREAM_RENEWAL_LEAD_SECONDS, STREAM_TOKEN_TTL_SECONDS } from "@/stream/token";

const OBSERVATORY = "11111111-1111-4111-8111-111111111111";
const MISSION = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const OBSERVER = "66666666-6666-4666-8666-666666666666";

const owner: ChannelUser = { id: OWNER, role: "USER" };
const observer: ChannelUser = { id: OBSERVER, role: "USER" };

let store: FakeLinkStore;
let offers: FakeStreamOffers;
let sent: MissionChannelMessage[];
let now: number;
let sessionId: string;

function makeChannel(user: ChannelUser = owner) {
  return new MissionChannel(
    MISSION,
    user,
    store,
    (message) => sent.push(message),
    () => {},
    offers,
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

const streams = () => sent.filter((m): m is MissionStreamInfo => m.type === "MISSION_STREAM");

beforeEach(() => {
  store = new FakeLinkStore();
  offers = new FakeStreamOffers();
  sent = [];
  now = Date.parse("2026-09-08T21:00:00.000Z");
  sessionId = randomUUID();

  store.addMission(MISSION, { observatoryId: OBSERVATORY, state: "OBSERVING" });
  store.setActiveSession(OBSERVATORY, {
    sessionId,
    missionId: MISSION,
    userId: OWNER,
    expiresAt: new Date(now + 60 * 60_000),
  });
});

describe("when a client is told where to watch", () => {
  it("says nothing about a stream before a frame has arrived", async () => {
    // ADR-011: MISSION_STREAM is sent only once a frame has actually arrived. A
    // URL offered earlier is one the client fetches, is refused, and cannot retry.
    const channel = makeChannel();
    await channel.receive(subscribe());

    expect(streams()).toEqual([]);
  });

  it("offers the URL as soon as the client subscribes to a mission already streaming", async () => {
    // Joining mid-OBSERVING must not mean a correct state panel above an empty
    // picture until the agent's next frame.
    offers.streaming.add(MISSION);
    const channel = makeChannel();

    await channel.receive(subscribe());

    expect(streams()).toHaveLength(1);
    expect(streams()[0]).toMatchObject({ missionId: MISSION, encoding: "JPEG" });
  });

  it("carries the mode, so simulator output is never shown as telescope output", async () => {
    offers.streaming.add(MISSION);
    offers.mode = "SIMULATED";
    const channel = makeChannel();

    await channel.receive(subscribe());

    expect(streams()[0].mode).toBe("SIMULATED");
  });

  it("mints for the viewer on this socket, not for the mission", async () => {
    offers.streaming.add(MISSION);
    store.addObserverSeat(MISSION, OBSERVER);

    const controller = makeChannel(owner);
    await controller.receive(subscribe());
    const watcher = makeChannel(observer);
    await watcher.receive(subscribe({ sessionId: null }));

    expect(offers.minted.map((m) => m.userId)).toEqual([OWNER, OBSERVER]);
    expect(streams()[0].streamUrl).not.toBe(streams()[1].streamUrl);
  });

  it("does not offer one URL per frame", async () => {
    // A customer receiving a MISSION_STREAM every second would be reopening the
    // response every second. The offer they hold is still good; leave it alone.
    offers.streaming.add(MISSION);
    const channel = makeChannel();
    await channel.receive(subscribe());

    for (let frame = 0; frame < 100; frame += 1) channel.offerStream();

    expect(streams()).toHaveLength(1);
  });

  it("renews before the URL it gave out stops working", async () => {
    offers.streaming.add(MISSION);
    const channel = makeChannel();
    await channel.receive(subscribe());

    // Just outside the renewal window: nothing yet.
    now += (STREAM_TOKEN_TTL_SECONDS - STREAM_RENEWAL_LEAD_SECONDS - 1) * 1000;
    channel.offerStream();
    expect(streams()).toHaveLength(1);

    // Inside it: a replacement, a full minute before the old one lapses, so the
    // client can swap `src` without a visible gap.
    now += 2000;
    channel.offerStream();
    expect(streams()).toHaveLength(2);
    expect(Date.parse(streams()[1].expiresAt)).toBeGreaterThan(
      Date.parse(streams()[0].expiresAt),
    );
  });

  it("offers nothing to a socket that never subscribed", async () => {
    // The socket is authenticated as a person but has proved nothing about which
    // mission they may watch. A URL here would be the leak the subscribe stops.
    offers.streaming.add(MISSION);
    const channel = makeChannel();

    channel.offerStream();

    expect(offers.minted).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("offers nothing to a refused subscriber", async () => {
    offers.streaming.add(MISSION);
    const channel = makeChannel(observer);

    await channel.receive(subscribe({ sessionId: null }));

    expect(offers.minted).toEqual([]);
    expect(streams()).toEqual([]);
  });
});

describe("a frame reaching the fan-out", () => {
  let registry: MissionChannelRegistry;
  let frames: RecordingFrameSink;
  let relay: MissionRelay;

  function frame(overrides: Partial<LiveFrame> = {}): LiveFrame {
    return {
      missionId: MISSION,
      observatoryId: OBSERVATORY,
      mode: "SIMULATED",
      encoding: "JPEG",
      sequence: 0,
      bytes: Buffer.from([0xff, 0xd8]),
      receivedAt: now,
      ...overrides,
    };
  }

  beforeEach(() => {
    registry = new MissionChannelRegistry();
    frames = new RecordingFrameSink();
    relay = new MissionRelay(store, registry, frames);
  });

  it("stores the frame and then offers it", async () => {
    offers.streaming.add(MISSION);
    const channel = makeChannel();
    registry.add(MISSION, channel);
    await channel.receive(subscribe());
    sent.length = 0;

    relay.liveFrameArrived(frame({ sequence: 9 }));

    expect(frames.published).toHaveLength(1);
    expect(frames.published[0].sequence).toBe(9);
  });

  it("reaches every subscriber on the mission", async () => {
    offers.streaming.add(MISSION);
    store.addObserverSeat(MISSION, OBSERVER);

    const controller = makeChannel(owner);
    const watcher = makeChannel(observer);
    registry.add(MISSION, controller);
    registry.add(MISSION, watcher);
    await controller.receive(subscribe());
    await watcher.receive(subscribe({ sessionId: null }));
    const before = offers.minted.length;

    now += STREAM_TOKEN_TTL_SECONDS * 1000;
    relay.liveFrameArrived(frame());

    expect(offers.minted.length - before).toBe(2);
  });

  it("frees the frame when the mission ends", async () => {
    // Releasing also closes the open responses: nobody is left watching a still
    // image of a finished mission, and a months-long process does not accumulate
    // the last frame of every mission it ever carried.
    relay.missionMoved({ missionId: MISSION, state: "COMPLETE", failureReason: null });

    expect(frames.released).toEqual([MISSION]);
  });

  it("keeps the frame while the mission is still running", () => {
    relay.missionMoved({ missionId: MISSION, state: "OBSERVING", failureReason: null });
    relay.missionMoved({ missionId: MISSION, state: "CAPTURING", failureReason: null });
    // A hold can be lifted, so it is not the end of the mission.
    relay.missionMoved({
      missionId: MISSION,
      state: "WEATHER_HOLD",
      failureReason: "WEATHER_UNSAFE",
    });

    expect(frames.released).toEqual([]);
  });

  it("frees the frame when the mission fails or is cancelled", () => {
    relay.missionMoved({ missionId: MISSION, state: "FAILED", failureReason: "MOUNT_FAULT" });
    relay.missionMoved({ missionId: MISSION, state: "CANCELLED", failureReason: null });

    expect(frames.released).toEqual([MISSION, MISSION]);
  });
});
