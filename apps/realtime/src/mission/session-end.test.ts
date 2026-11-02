import { describe, expect, it } from "vitest";

import { FakeLinkStore } from "@/link/fake-store";
import { RecordingBroadcast } from "@/mission/fake-broadcast";
import { sweepSessionEnds } from "@/mission/session-end";

/** ADR-079's end-of-session sweeps, against the in-memory store. */
const OBSERVATORY = "11111111-1111-4111-8111-111111111111";
const MISSION = "22222222-2222-4222-8222-222222222222";
const TARGET = "88888888-8888-4888-8888-888888888888";
const NOW = new Date("2026-12-15T21:00:00.000Z");

function setup() {
  const store = new FakeLinkStore();
  const broadcast = new RecordingBroadcast();
  const told: { observatoryId: string; missionId: string; endReason: string }[] = [];
  const relay = {
    relaySessionEnded: (observatoryId: string, missionId: string, endReason: string) => {
      told.push({ observatoryId, missionId, endReason });
      return "SENT" as const;
    },
  };
  return { store, broadcast, told, sweep: (now = NOW) => sweepSessionEnds({ store, relay, broadcast, now }) };
}

describe("the slot's end reaches the agent", () => {
  it("sends SLOT_ENDED once for a live mission past its slot, and mints no PARK", async () => {
    const { store, told, sweep } = setup();
    store.addMission(MISSION, {
      observatoryId: OBSERVATORY,
      state: "OBSERVING",
      currentTargetId: TARGET,
      slotEndsAt: new Date(NOW.getTime() - 1000),
    });

    await sweep();
    await sweep(new Date(NOW.getTime() + 60_000));

    expect(told).toEqual([
      { observatoryId: OBSERVATORY, missionId: MISSION, endReason: "SLOT_ENDED" },
    ]);
    expect(await store.pendingCommands(OBSERVATORY, NOW)).toEqual([]);
  });

  it("leaves a slot that has not ended alone", async () => {
    const { store, told, sweep } = setup();
    store.addMission(MISSION, {
      observatoryId: OBSERVATORY,
      state: "OBSERVING",
      slotEndsAt: new Date(NOW.getTime() + 1000),
    });

    await sweep();

    expect(told).toEqual([]);
  });
});

describe("a session whose park was never reported", () => {
  it("is ended with parked false 300 seconds after the mission ended, once", async () => {
    const { store, broadcast, sweep } = setup();
    store.addMission(MISSION, {
      observatoryId: OBSERVATORY,
      state: "COMPLETE",
      currentTargetId: TARGET,
      slotEndsAt: NOW,
      endedAt: new Date(NOW.getTime() - 299_000),
    });

    await sweep();
    expect(broadcast.ended).toEqual([]);

    await sweep(new Date(NOW.getTime() + 1000));
    await sweep(new Date(NOW.getTime() + 61_000));

    expect(broadcast.ended).toHaveLength(1);
    expect(broadcast.ended[0]).toMatchObject({ missionId: MISSION, parked: false });
  });

  it("is never sent for a mission that ended before booked sessions existed", async () => {
    const { store, broadcast, sweep } = setup();
    store.addMission(MISSION, {
      observatoryId: OBSERVATORY,
      state: "COMPLETE",
      currentTargetId: null,
      endedAt: new Date(NOW.getTime() - 3_600_000),
    });

    await sweep();

    expect(broadcast.ended).toEqual([]);
  });
});
