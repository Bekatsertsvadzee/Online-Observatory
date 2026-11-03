import { describe, expect, it } from "vitest";

import type { ImageHealth } from "@darkview/contracts";

import type { MissionLiveContext } from "@/link/store";
import { bookedSessionTelemetry } from "@/mission/booked-session";

/** What MISSION_TELEMETRY adds for a booked session (ADR-079). Fixed instants. */
const NOW = new Date("2026-12-15T20:00:00.000Z");
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

function context(overrides: Partial<MissionLiveContext> = {}): MissionLiveContext {
  return {
    missionId: "22222222-2222-4222-8222-222222222222",
    state: "OBSERVING",
    currentTargetId: "current",
    currentTargetSince: at(-60),
    sessionEndsAt: at(3600),
    lastCaptureIssuedAt: null,
    captureAwaitingVerdict: false,
    captureCount: 0,
    ...overrides,
  };
}

const telemetry = (
  live: MissionLiveContext | null,
  options: { imageHealth?: ImageHealth | null; parked?: boolean } = {},
) =>
  bookedSessionTelemetry(live, {
    imageHealth: options.imageHealth ?? null,
    parked: options.parked ?? false,
    now: NOW,
  });

describe("the dwell countdown", () => {
  it("counts down to 600 seconds after the agent accepted the object", () => {
    expect(telemetry(context()).retargetAllowedAt).toBe(at(540).toISOString());
  });

  it("is null once the dwell has passed", () => {
    expect(telemetry(context({ currentTargetSince: at(-600) })).retargetAllowedAt).toBeNull();
  });

  it("is null while the agent reports the picture UNRECOVERED", () => {
    const imageHealth: ImageHealth = {
      status: "UNRECOVERED",
      reason: "CLOUDS",
      since: NOW.toISOString(),
    };
    expect(telemetry(context(), { imageHealth }).retargetAllowedAt).toBeNull();
  });

  it("is null once the mission has ended", () => {
    expect(telemetry(context({ state: "COMPLETE" })).retargetAllowedAt).toBeNull();
  });
});

describe("when the next capture is accepted", () => {
  it("is null when one is accepted now", () => {
    expect(telemetry(context()).captureAllowedAt).toBeNull();
  });

  it("is 30 seconds after the previous capture's issue", () => {
    expect(telemetry(context({ lastCaptureIssuedAt: at(-10) })).captureAllowedAt).toBe(
      at(20).toISOString(),
    );
  });

  it("is null while one is in progress and once the limit is reached", () => {
    const recent = { lastCaptureIssuedAt: at(-10) };
    expect(telemetry(context({ ...recent, state: "CAPTURING" })).captureAllowedAt).toBeNull();
    expect(telemetry(context({ ...recent, captureAwaitingVerdict: true })).captureAllowedAt).toBeNull();
    expect(telemetry(context({ ...recent, captureCount: 50 })).captureAllowedAt).toBeNull();
  });
});

describe("how far the ending has got", () => {
  it("is null while the slot runs", () => {
    expect(telemetry(context()).endPhase).toBeNull();
  });

  it("is FINISHING past the slot's end while the mission is still live", () => {
    expect(telemetry(context({ state: "PROCESSING", sessionEndsAt: at(-5) })).endPhase).toBe(
      "FINISHING",
    );
  });

  it("is PARKING once the mission has ended, and PARKED when the mount says so", () => {
    expect(telemetry(context({ state: "COMPLETE" })).endPhase).toBe("PARKING");
    expect(telemetry(context({ state: "COMPLETE" }), { parked: true }).endPhase).toBe("PARKED");
  });
});

describe("the agent's verdict on its picture", () => {
  it("is relayed unchanged, and the rest is null for a mission the store does not hold", () => {
    const imageHealth: ImageHealth = {
      status: "RECOVERING",
      reason: "BLANK_FRAME",
      step: "RE_EXPOSE",
      attempt: 1,
      since: NOW.toISOString(),
      nextRetryAt: null,
    };
    expect(telemetry(context(), { imageHealth }).imageHealth).toEqual(imageHealth);
    expect(telemetry(null, { imageHealth })).toEqual({
      currentTargetId: null,
      retargetAllowedAt: null,
      captureAllowedAt: null,
      imageHealth,
      endPhase: null,
    });
  });
});
