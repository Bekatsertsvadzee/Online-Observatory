import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getCurrentSession } = vi.hoisted(() => ({ getCurrentSession: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentSession }));

import { zUser } from "@darkview/contracts/zod";

import { GET } from "./route";

const session = (role: "USER" | "OPERATOR") => ({
  id: "session-1",
  expiresAt: new Date("2026-09-10T00:00:00.000Z"),
  csrfToken: "csrf-token-value",
  user: {
    id: "6f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
    email: "observer@example.com",
    name: "Observer",
    role,
    locale: "en" as const,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  },
});

describe("GET /me", () => {
  it("returns 401 with a contract ApiError when there is no session", async () => {
    getCurrentSession.mockResolvedValueOnce(null);

    const response = await GET();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
    });
  });

  it("returns a body the contract's own schema accepts", async () => {
    getCurrentSession.mockResolvedValueOnce(session("USER"));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    // Validated against the generated contract schema, not a hand-written shape.
    expect(() => zUser.parse(body)).not.toThrow();
  });

  it("sends only what the contract declares, and no session credential", async () => {
    getCurrentSession.mockResolvedValueOnce(session("OPERATOR"));

    const body = (await (await GET()).json()) as Record<string, unknown>;

    // The contract sets additionalProperties: false, so an extra key is a breach,
    // not untidiness. emailVerifiedAt, isDemo and the session must not appear.
    expect(Object.keys(body).sort()).toEqual([
      "createdAt",
      "displayName",
      "email",
      "id",
      "locale",
      "role",
    ]);

    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("csrf-token-value");
    expect(serialised).not.toContain("session-1");
  });
});
