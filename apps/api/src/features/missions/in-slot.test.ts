import { describe, expect, it, vi } from "vitest";

import {
  effectiveRetargetAllowedAt,
  judgeCapture,
  judgeRetarget,
  type CaptureFacts,
  type RetargetFacts,
} from "@/features/missions/in-slot";

/**
 * ADR-079's in-slot rules, in the order the contract lists them for
 * `POST /missions/{missionId}/command`. Fixed instants; nothing reads the clock.
 */
const NOW = new Date("2026-12-15T20:00:00.000Z");
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

function retarget(overrides: Partial<RetargetFacts> = {}): RetargetFacts {
  return {
    state: "OBSERVING",
    now: NOW,
    sessionEndsAt: at(3600),
    currentTargetId: "current",
    targetId: "next",
    dwellEndsAt: at(-1),
    unrecovered: false,
    visibleNow: () => ({
      currentListed: true,
      requested: { listed: true, blockReasons: [] },
    }),
    ...overrides,
  };
}

describe("RETARGET refusals, in order", () => {
  it("accepts a listed object once the dwell has passed", () => {
    expect(judgeRetarget(retarget())).toBeNull();
  });

  it.each(["SLEWING", "VERIFYING", "CENTERING", "CAPTURING", "PROCESSING"])(
    "is MISSION_BUSY while %s, before looking at the sky",
    (state) => {
      const visibleNow = vi.fn();
      const refusal = judgeRetarget(retarget({ state, visibleNow }));

      expect(refusal).toMatchObject({
        status: 409,
        code: "MISSION_BUSY",
        details: { rejectionReason: "MISSION_BUSY" },
      });
      expect(visibleNow).not.toHaveBeenCalled();
    },
  );

  it("is SESSION_ENDING with under five minutes left", () => {
    expect(judgeRetarget(retarget({ sessionEndsAt: at(299) }))).toMatchObject({
      code: "SESSION_ENDING",
    });
    expect(judgeRetarget(retarget({ sessionEndsAt: at(300) }))).toBeNull();
  });

  it("is CONFLICT for the object already on the telescope", () => {
    expect(judgeRetarget(retarget({ targetId: "current" }))).toMatchObject({
      status: 409,
      code: "CONFLICT",
    });
  });

  it("is DWELL_LOCKED one second before the ten minutes are up, with when it lifts", () => {
    const refusal = judgeRetarget(retarget({ dwellEndsAt: at(1) }));

    expect(refusal).toMatchObject({
      code: "DWELL_LOCKED",
      details: { rejectionReason: "DWELL_LOCKED", allowedAt: at(1).toISOString() },
    });
  });

  it("accepts at exactly the end of the dwell", () => {
    expect(judgeRetarget(retarget({ dwellEndsAt: NOW }))).toBeNull();
  });

  it("waives the dwell while the picture is UNRECOVERED", () => {
    expect(judgeRetarget(retarget({ dwellEndsAt: at(300), unrecovered: true }))).toBeNull();
  });

  it("waives the dwell when the current object is setting out of the list", () => {
    const refusal = judgeRetarget(
      retarget({
        dwellEndsAt: at(300),
        visibleNow: () => ({
          currentListed: false,
          requested: { listed: true, blockReasons: [] },
        }),
      }),
    );
    expect(refusal).toBeNull();
  });

  it("is TARGET_NOT_OBSERVABLE, with the reasons, for an object not visible now", () => {
    const refusal = judgeRetarget(
      retarget({
        visibleNow: () => ({
          currentListed: true,
          requested: { listed: false, blockReasons: ["BEHIND_HORIZON_MASK"] },
        }),
      }),
    );

    expect(refusal).toMatchObject({
      status: 409,
      code: "TARGET_NOT_OBSERVABLE",
      details: {
        rejectionReason: "TARGET_NOT_VISIBLE_NOW",
        blockReasons: ["BEHIND_HORIZON_MASK"],
      },
    });
  });

  it("reports the dwell before visibility when both would refuse", () => {
    const refusal = judgeRetarget(
      retarget({
        dwellEndsAt: at(60),
        visibleNow: () => ({
          currentListed: true,
          requested: { listed: false, blockReasons: ["SUN_TOO_HIGH"] },
        }),
      }),
    );
    expect(refusal?.code).toBe("DWELL_LOCKED");
  });
});

describe("the dwell lock as a client reads it", () => {
  it("is null once it has passed, and the instant it lifts until then", () => {
    const base = { unrecovered: false, currentListed: true, now: NOW };

    expect(effectiveRetargetAllowedAt({ ...base, dwellEndsAt: null })).toBeNull();
    expect(effectiveRetargetAllowedAt({ ...base, dwellEndsAt: NOW })).toBeNull();
    expect(effectiveRetargetAllowedAt({ ...base, dwellEndsAt: at(30) })).toEqual(at(30));
    expect(
      effectiveRetargetAllowedAt({ ...base, dwellEndsAt: at(30), unrecovered: true }),
    ).toBeNull();
    expect(
      effectiveRetargetAllowedAt({ ...base, dwellEndsAt: at(30), currentListed: false }),
    ).toBeNull();
  });
});

function capture(overrides: Partial<CaptureFacts> = {}): CaptureFacts {
  return {
    state: "OBSERVING",
    now: NOW,
    sessionEndsAt: at(3600),
    awaitingVerdict: false,
    lastIssuedAt: null,
    captureCount: 0,
    ...overrides,
  };
}

describe("CAPTURE refusals, in order", () => {
  it("accepts the first capture of a session", () => {
    expect(judgeCapture(capture())).toBeNull();
  });

  it("is CAPTURE_IN_PROGRESS while one awaits the agent's verdict, or runs", () => {
    expect(judgeCapture(capture({ awaitingVerdict: true }))?.code).toBe("CAPTURE_IN_PROGRESS");
    expect(judgeCapture(capture({ state: "CAPTURING" }))?.code).toBe("CAPTURE_IN_PROGRESS");
    expect(judgeCapture(capture({ state: "PROCESSING" }))?.code).toBe("CAPTURE_IN_PROGRESS");
  });

  it("is CAPTURE_COOLDOWN 29 seconds after the last one and accepts at 30", () => {
    expect(judgeCapture(capture({ lastIssuedAt: at(-29) }))).toMatchObject({
      code: "CAPTURE_COOLDOWN",
      details: { allowedAt: at(1).toISOString() },
    });
    expect(judgeCapture(capture({ lastIssuedAt: at(-30) }))).toBeNull();
  });

  it("is CAPTURE_LIMIT_REACHED at fifty", () => {
    expect(judgeCapture(capture({ captureCount: 49 }))).toBeNull();
    expect(judgeCapture(capture({ captureCount: 50 }))?.code).toBe("CAPTURE_LIMIT_REACHED");
  });

  it("is SESSION_ENDING in the last minute", () => {
    expect(judgeCapture(capture({ sessionEndsAt: at(59) }))?.code).toBe("SESSION_ENDING");
    expect(judgeCapture(capture({ sessionEndsAt: at(60) }))).toBeNull();
  });

  it("reports a capture in progress before the cooldown", () => {
    expect(
      judgeCapture(capture({ state: "CAPTURING", lastIssuedAt: at(-5) }))?.code,
    ).toBe("CAPTURE_IN_PROGRESS");
  });
});
