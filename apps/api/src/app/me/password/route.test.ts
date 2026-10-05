import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requestHeaders, getCurrentSession, changePassword } = vi.hoisted(() => ({
  requestHeaders: { origin: "https://darkview.test" as string | null },
  getCurrentSession: vi.fn(),
  changePassword: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(requestHeaders.origin ? { origin: requestHeaders.origin } : {}),
}));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({ APP_URL: "https://darkview.test" }),
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentSession }));
vi.mock("@/features/auth/password", () => ({ changePassword }));

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

const body = { currentPassword: "the old one", password: "long-enough-pw" };
const post = (value: unknown) =>
  new Request("https://darkview.test/api/me/password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });

beforeEach(() => {
  requestHeaders.origin = "https://darkview.test";
  vi.clearAllMocks();
  getCurrentSession.mockResolvedValue(session);
});

describe("POST /me/password", () => {
  it("refuses a foreign Origin with 403 before doing any work", async () => {
    requestHeaders.origin = "https://attacker.test";

    expect((await POST(post(body))).status).toBe(403);
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("answers 401 without a session", async () => {
    getCurrentSession.mockResolvedValueOnce(null);

    expect((await POST(post(body))).status).toBe(401);
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("answers 204 with no body, for the signed-in user's own session", async () => {
    changePassword.mockResolvedValueOnce({ ok: true });

    const response = await POST(post(body));

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(changePassword).toHaveBeenCalledWith(session, body);
  });

  it("names the wrong field without echoing either password", async () => {
    changePassword.mockResolvedValueOnce({
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
    expect(text).not.toContain(body.password);
  });

  it("answers 400 to a body that is not JSON, and 422 to one the contract rejects", async () => {
    expect((await POST(post("{not json"))).status).toBe(400);
    expect((await POST(post({ currentPassword: "x", password: "short" }))).status).toBe(
      422,
    );
  });
});
