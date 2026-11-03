import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ getDatabase: () => null }));

const { bookedSessionFields, sessionEndsAtOf } = await import("@/features/missions/session");

/** ADR-079's three Mission fields, read off the row. */
const SLOT = { slotStartAt: new Date("2026-12-15T20:00:00.000Z"), durationMinutes: 90 };
const ACCEPTED_AT = new Date("2026-12-15T20:01:00.000Z");

function row(overrides: Partial<Parameters<typeof bookedSessionFields>[0]> = {}) {
  return {
    state: "OBSERVING",
    targetId: "booked",
    startedAt: new Date("2026-12-15T20:00:30.000Z"),
    currentTargetId: "current",
    currentTargetSince: ACCEPTED_AT,
    booking: SLOT,
    sessions: [],
    ...overrides,
  };
}

describe("a booked session's Mission fields", () => {
  it("ends at the slot's end, whatever the session row says", () => {
    expect(
      bookedSessionFields(row({ sessions: [{ expiresAt: new Date("2026-12-15T23:00:00Z") }] }))
        .sessionEndsAt,
    ).toBe("2026-12-15T21:30:00.000Z");
  });

  it("ends with the session for a mission nobody booked, and is null with neither", () => {
    const expiresAt = new Date("2026-12-15T20:30:00.000Z");
    expect(sessionEndsAtOf(null, { expiresAt })).toEqual(expiresAt);
    expect(sessionEndsAtOf(null, null)).toBeNull();
  });

  it("locks a RETARGET for 600 seconds from the agent's acceptance", () => {
    expect(bookedSessionFields(row()).retargetAllowedAt).toBe("2026-12-15T20:11:00.000Z");
  });

  it("has no dwell lock once the mission is over", () => {
    expect(bookedSessionFields(row({ state: "COMPLETE" })).retargetAllowedAt).toBeNull();
  });

  it("keeps the booked target separate from the current one", () => {
    expect(bookedSessionFields(row()).currentTargetId).toBe("current");
  });

  it("reports the booked target for a mission that started before ADR-079", () => {
    expect(bookedSessionFields(row({ currentTargetId: null })).currentTargetId).toBe("booked");
    expect(
      bookedSessionFields(row({ currentTargetId: null, startedAt: null })).currentTargetId,
    ).toBeNull();
  });
});
