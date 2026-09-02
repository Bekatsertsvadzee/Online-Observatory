import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  authorizeTelescopeCommand,
  type TelescopeCommandAuthorizationContext,
} from "@/lib/observatory/command-authorization";

const now = new Date("2026-08-25T20:00:00.000Z");

function validContext(): TelescopeCommandAuthorizationContext {
  return {
    actor: {
      id: "user-1",
      email: "observer@example.com",
      name: "Observer",
      role: "USER",
    },
    mission: {
      id: "mission-1",
      ownerId: "user-1",
      sessionActive: true,
      state: "OBSERVING",
    },
    lease: {
      missionId: "mission-1",
      userId: "user-1",
      expiresAt: new Date("2026-08-25T20:10:00.000Z"),
      revokedAt: null,
    },
    command: {
      category: "MISSION",
      expiresAt: new Date("2026-08-25T20:00:10.000Z"),
    },
    observatoryReady: true,
    safetyApproved: true,
    now,
  };
}

describe("telescope command authorization", () => {
  it("authorizes only when every mission invariant is satisfied", () => {
    expect(authorizeTelescopeCommand(validContext())).toEqual({ authorized: true });
  });

  it.each([
    ["UNAUTHENTICATED", { actor: null }],
    ["NO_ACTIVE_MISSION", { mission: null }],
    ["INVALID_LEASE", { lease: null }],
    ["COMMAND_EXPIRED", { command: { category: "MISSION", expiresAt: now } }],
    ["OBSERVATORY_NOT_READY", { observatoryReady: false }],
    ["SAFETY_REJECTED", { safetyApproved: false }],
  ] as const)("rejects %s", (reason, override) => {
    expect(authorizeTelescopeCommand({ ...validContext(), ...override })).toEqual({
      authorized: false,
      reason,
    });
  });

  it("never permits a USER to issue an administrative command", () => {
    const context = validContext();
    context.command.category = "ADMINISTRATIVE";
    expect(authorizeTelescopeCommand(context)).toEqual({
      authorized: false,
      reason: "ROLE_FORBIDDEN",
    });
  });

  it("rejects a USER whose lease or mission belongs to somebody else", () => {
    const context = validContext();
    context.mission!.ownerId = "user-2";
    expect(authorizeTelescopeCommand(context)).toEqual({
      authorized: false,
      reason: "NO_ACTIVE_MISSION",
    });
  });
});
