import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getCurrentSession } = vi.hoisted(() => ({ getCurrentSession: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentSession }));

import { requireApiSession, requireOperator } from "@/lib/auth/api-guard";
import type { VerifiedSession } from "@/lib/auth/types";

const session = (role: "USER" | "OPERATOR"): VerifiedSession => ({
  id: "session-1",
  expiresAt: new Date("2026-09-10T00:00:00.000Z"),
  csrfToken: "csrf-token-value",
  user: {
    id: "6f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
    email: "observer@example.com",
    name: "Observer",
    role,
    locale: "en",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  },
});

describe("requireApiSession", () => {
  it("refuses an anonymous caller with 401, not a redirect", async () => {
    getCurrentSession.mockResolvedValueOnce(null);

    const guard = await requireApiSession();

    expect(guard.ok).toBe(false);
    if (guard.ok) return;
    expect(guard.response.status).toBe(401);
    await expect(guard.response.json()).resolves.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("passes a signed-in caller through", async () => {
    getCurrentSession.mockResolvedValueOnce(session("USER"));
    await expect(requireApiSession()).resolves.toMatchObject({ ok: true });
  });
});

describe("requireOperator", () => {
  it("refuses a USER with 403 and a contract ApiError", async () => {
    getCurrentSession.mockResolvedValueOnce(session("USER"));

    const guard = await requireOperator();

    expect(guard.ok).toBe(false);
    if (guard.ok) return;
    expect(guard.response.status).toBe(403);
    await expect(guard.response.json()).resolves.toEqual({
      code: "FORBIDDEN",
      message: "This account may not perform that action.",
    });
  });

  it("refuses an anonymous caller with 401 before considering the role", async () => {
    getCurrentSession.mockResolvedValueOnce(null);

    const guard = await requireOperator();

    expect(guard.ok).toBe(false);
    if (guard.ok) return;
    expect(guard.response.status).toBe(401);
  });

  it("admits an OPERATOR", async () => {
    getCurrentSession.mockResolvedValueOnce(session("OPERATOR"));
    await expect(requireOperator()).resolves.toMatchObject({ ok: true });
  });
});
