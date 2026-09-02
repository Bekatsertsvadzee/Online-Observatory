import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertRole,
  AuthorizationError,
  observatoryAdministrativeRoles,
} from "@/lib/auth/authorization";
import type { VerifiedSession } from "@/lib/auth/types";

function session(role: VerifiedSession["user"]["role"]): VerifiedSession {
  return {
    id: "session-1",
    expiresAt: new Date("2026-08-27T00:00:00.000Z"),
    csrfToken: "csrf-token",
    user: {
      id: "user-1",
      email: "observer@example.com",
      name: "Observer",
      role,
    },
  };
}

describe("role authorization", () => {
  it("rejects USER access to observatory administration", () => {
    expect(() => assertRole(session("USER"), observatoryAdministrativeRoles)).toThrow(
      AuthorizationError,
    );
  });

  it.each(["OPERATOR", "ADMIN"] as const)(
    "allows %s through the administrative role gate",
    (role) => {
      expect(() =>
        assertRole(session(role), observatoryAdministrativeRoles),
      ).not.toThrow();
    },
  );
});
