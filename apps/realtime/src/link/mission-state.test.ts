import { describe, expect, it } from "vitest";

import { FakeLinkStore } from "@/link/fake-store";

/**
 * Which mission transitions the cloud will accept from an observatory (ADR-004,
 * ADR-018).
 *
 * The only question once asked of an agent-reported event was whether the mission
 * had already finished, so a live mission could be walked back to SCHEDULED,
 * jumped from PREPARING to COMPLETE, or have its weather hold lifted by the
 * observatory that set it -- and the weather hold is what the refund engine
 * classifies from.
 *
 * `store.ts` now holds the transition table both stores apply -- the fake in code,
 * the Prisma one in the WHERE clause of its guarded UPDATE.
 *
 * The last test in this file is still failing on purpose. See its comment.
 */
const OBS = "11111111-1111-4111-8111-111111111111";
const MISSION = "22222222-2222-4222-8222-222222222222";

const event = (state: string, failureReason: string | null = null) =>
  ({
    observatoryId: OBS,
    missionId: MISSION,
    state,
    failureReason,
    occurredAt: new Date(),
    commandId: null,
    detail: null,
  }) as never;

describe("the cloud refuses a transition the agent could not have made", () => {
  it.each([
    ["OBSERVING", "REQUESTED"],
    ["OBSERVING", "SCHEDULED"],
    ["PREPARING", "COMPLETE"],
    ["WEATHER_HOLD", "OBSERVING"],
    ["HARDWARE_ERROR", "SLEWING"],
  ])("refuses %s -> %s", async (from, to) => {
    const store = new FakeLinkStore();
    store.addMission(MISSION, { observatoryId: OBS, state: from as never });
    const outcome = await store.applyMissionEvent(event(to));
    expect(outcome).not.toBe("APPLIED");
    expect(store.mission(MISSION)?.state).toBe(from);
  });

  it("keeps a cloud WEATHER_HOLD when the agent reports its weather park as an operator abort", async () => {
    const store = new FakeLinkStore();
    store.addMission(MISSION, {
      observatoryId: OBS,
      state: "WEATHER_HOLD",
      failureReason: "WEATHER_UNSAFE" as never,
    });
    await store.applyMissionEvent(event("CANCELLED", "OPERATOR_ABORT"));
    // refunds/entitlements.ts:222-227 classifies WEATHER from exactly these fields.
    expect(store.mission(MISSION)?.state).toBe("WEATHER_HOLD");
    expect(store.mission(MISSION)?.failureReason).toBe("WEATHER_UNSAFE");
  });
});

describe("a starting GOTO the agent never ran releases the observatory", () => {
  it("does not leave the mission in PREPARING holding the observatory", async () => {
    const store = new FakeLinkStore();
    store.addMission(MISSION, { observatoryId: OBS, state: "PREPARING" });
    const now = new Date().toISOString();
    store.addCommand({
      observatoryId: OBS,
      envelope: {
        commandId: "33333333-3333-4333-8333-333333333333",
        missionId: MISSION,
        sessionId: "44444444-4444-4444-8444-444444444444",
        userId: "55555555-5555-4555-8555-555555555555",
        issuedAt: now,
        expiresAt: now,
        type: "GOTO",
        payload: { kind: "GOTO", recenter: false },
      },
    } as never);

    await store.recordCommandVerdict({
      observatoryId: OBS,
      commandId: "33333333-3333-4333-8333-333333333333",
      status: "EXPIRED",
      rejectionReason: "COMMAND_EXPIRED",
      detail: null,
      decidedAt: new Date(),
    } as never);

    expect(store.mission(MISSION)?.state).not.toBe("PREPARING");
    expect(await store.liveMissionId(OBS)).toBeNull();
  });
});

describe("a network blip leaves the mission live (ADR-046)", () => {
  // `AgentHello.resumeMissionId` is sent on every hello while a mission is active, a
  // reconnect after a two-second blip included. Only a new process -- a different
  // `bootedAt` -- has parked and lost the state machine's progress.
  it("keeps an OBSERVING mission live when the agent reconnects holding it", async () => {
    const store = new FakeLinkStore();
    store.addMission(MISSION, { observatoryId: OBS, state: "OBSERVING" });
    const outcome = await store.resolveResumedMission({
      observatoryId: OBS,
      missionId: MISSION,
      restarted: false,
      now: new Date(),
    });
    expect(outcome).toBe("STILL_LIVE");
    expect(store.mission(MISSION)?.state).toBe("OBSERVING");
  });

  it("still closes it out when the agent restarted holding it", async () => {
    const store = new FakeLinkStore();
    store.addMission(MISSION, { observatoryId: OBS, state: "OBSERVING" });
    const outcome = await store.resolveResumedMission({
      observatoryId: OBS,
      missionId: MISSION,
      restarted: true,
      now: new Date(),
    });
    expect(outcome).toBe("RESOLVED");
    expect(store.mission(MISSION)?.state).toBe("FAILED");
  });
});

