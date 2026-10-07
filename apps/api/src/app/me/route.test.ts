import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  getCurrentSession,
  deleteCurrentSession,
  requestHeaders,
  updateProfile,
  deleteAccount,
  meterRequest,
} = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  deleteCurrentSession: vi.fn(),
  requestHeaders: { origin: "https://darkview.test" as string | null },
  updateProfile: vi.fn(),
  deleteAccount: vi.fn(),
  meterRequest: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentSession, deleteCurrentSession }));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(requestHeaders.origin ? { origin: requestHeaders.origin } : {}),
}));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({ APP_URL: "https://darkview.test" }),
}));
vi.mock("@/features/auth/profile", () => ({ updateProfile }));
vi.mock("@/features/auth/deletion", () => ({ deleteAccount }));
vi.mock("@/lib/security/rate-limit", () => ({ meterRequest, PROFILE_POLICY: {} }));

import { zUser } from "@darkview/contracts/zod";

import { DELETE, GET, PATCH } from "./route";

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

const patch = (value: unknown) =>
  new Request("https://darkview.test/api/me", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });

describe("PATCH /me", () => {
  beforeEach(() => {
    requestHeaders.origin = "https://darkview.test";
    vi.clearAllMocks();
    getCurrentSession.mockResolvedValue(session("USER"));
    meterRequest.mockResolvedValue(null);
  });

  it("refuses a foreign Origin with 403 before doing any work", async () => {
    requestHeaders.origin = "https://attacker.test";

    expect((await PATCH(patch({ locale: "ka" }))).status).toBe(403);
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("answers 401 without a session", async () => {
    getCurrentSession.mockResolvedValueOnce(null);

    expect((await PATCH(patch({ locale: "ka" }))).status).toBe(401);
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("answers the updated User", async () => {
    const user = { ...session("USER").user, locale: "ka" };
    updateProfile.mockResolvedValueOnce({
      ok: true,
      user: { ...user, displayName: user.name, createdAt: user.createdAt.toISOString() },
    });

    const response = await PATCH(patch({ locale: "ka" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ locale: "ka" });
    expect(updateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1" }),
      { locale: "ka" },
    );
  });

  it("answers 422 to an empty body, which the contract's minProperties forbids", async () => {
    expect((await PATCH(patch({}))).status).toBe(422);
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("answers 400 to a body that is not JSON, and 422 naming the field the contract rejects", async () => {
    expect((await PATCH(patch("{not json"))).status).toBe(400);
    const response = await PATCH(patch({ displayName: "x" }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      details: { fields: ["displayName"] },
    });
  });

  it("is metered before anything else is read", async () => {
    meterRequest.mockResolvedValueOnce(
      Response.json(
        { code: "RATE_LIMITED", message: "Too many requests." },
        { status: 429 },
      ),
    );

    expect((await PATCH(patch({ locale: "ka" }))).status).toBe(429);
    expect(updateProfile).not.toHaveBeenCalled();
  });
});

const remove = (value: unknown) =>
  new Request("https://darkview.test/api/me", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });

describe("DELETE /me", () => {
  beforeEach(() => {
    requestHeaders.origin = "https://darkview.test";
    vi.clearAllMocks();
    getCurrentSession.mockResolvedValue(session("USER"));
  });

  it("refuses a foreign Origin with 403 before doing any work", async () => {
    requestHeaders.origin = "https://attacker.test";

    expect((await DELETE(remove({ currentPassword: "pw" }))).status).toBe(403);
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("answers 401 without a session", async () => {
    getCurrentSession.mockResolvedValueOnce(null);

    expect((await DELETE(remove({ currentPassword: "pw" }))).status).toBe(401);
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("answers 400 to a body that is not JSON, and 422 without the password", async () => {
    expect((await DELETE(remove("{not json"))).status).toBe(400);
    const response = await DELETE(remove({}));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      details: { fields: ["currentPassword"] },
    });
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("answers 204 and clears the cookies once the account is deleted", async () => {
    deleteAccount.mockResolvedValueOnce({ ok: true });

    const response = await DELETE(remove({ currentPassword: "pw" }));

    expect(response.status).toBe(204);
    expect(deleteAccount).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1" }),
      { currentPassword: "pw" },
    );
    expect(deleteCurrentSession).toHaveBeenCalledTimes(1);
  });

  it("passes a 409's blockers through and keeps the session", async () => {
    deleteAccount.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "The account has something to settle first.",
      details: { blockers: ["UPCOMING_BOOKING"] },
    });

    const response = await DELETE(remove({ currentPassword: "pw" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "CONFLICT",
      details: { blockers: ["UPCOMING_BOOKING"] },
    });
    expect(deleteCurrentSession).not.toHaveBeenCalled();
  });
});
