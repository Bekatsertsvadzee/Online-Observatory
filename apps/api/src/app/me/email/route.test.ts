import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requestHeaders, getCurrentSession, requestEmailChange } = vi.hoisted(() => ({
  requestHeaders: { origin: "https://darkview.test" as string | null },
  getCurrentSession: vi.fn(),
  requestEmailChange: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(requestHeaders.origin ? { origin: requestHeaders.origin } : {}),
}));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({ APP_URL: "https://darkview.test" }),
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentSession }));
vi.mock("@/features/auth/profile", () => ({ requestEmailChange }));

import { POST } from "./route";

const session = {
  id: "session-1",
  expiresAt: new Date("2026-11-01T00:00:00.000Z"),
  csrfToken: "csrf-token-value",
  user: {
    id: "6f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
    email: "observer@example.com",
    name: "Observer",
    role: "USER" as const,
    locale: "en" as const,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  },
};

const body = { email: "new@example.com", currentPassword: "the current one" };
const post = (value: unknown) =>
  new Request("https://darkview.test/api/me/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });

beforeEach(() => {
  requestHeaders.origin = "https://darkview.test";
  vi.clearAllMocks();
  getCurrentSession.mockResolvedValue(session);
});

describe("POST /me/email", () => {
  it("refuses a foreign Origin with 403 before doing any work", async () => {
    requestHeaders.origin = "https://attacker.test";

    expect((await POST(post(body))).status).toBe(403);
    expect(requestEmailChange).not.toHaveBeenCalled();
  });

  it("answers 401 without a session", async () => {
    getCurrentSession.mockResolvedValueOnce(null);

    expect((await POST(post(body))).status).toBe(401);
    expect(requestEmailChange).not.toHaveBeenCalled();
  });

  it("answers 202 with no body", async () => {
    requestEmailChange.mockResolvedValueOnce({ ok: true });

    const response = await POST(post(body));

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    expect(requestEmailChange).toHaveBeenCalledWith(session, body);
  });

  it("names the wrong field without echoing the password", async () => {
    requestEmailChange.mockResolvedValueOnce({
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      message: "The current password is incorrect.",
      details: { fields: ["currentPassword"] },
    });

    const response = await POST(post(body));
    const text = await response.text();

    expect(response.status).toBe(422);
    expect(JSON.parse(text)).toMatchObject({ details: { fields: ["currentPassword"] } });
    expect(text).not.toContain(body.currentPassword);
  });

  it("answers 400 to a body that is not JSON, and 422 to one the contract rejects", async () => {
    expect((await POST(post("{not json"))).status).toBe(400);
    const response = await POST(post({ email: "not an address", currentPassword: "x" }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      details: { fields: ["email"] },
    });
  });
});
