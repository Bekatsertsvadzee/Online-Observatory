import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requestHeaders, signIn, register, verifyEmail } = vi.hoisted(() => ({
  requestHeaders: { origin: "https://darkview.test" as string | null },
  signIn: vi.fn(),
  register: vi.fn(),
  verifyEmail: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(requestHeaders.origin ? { origin: requestHeaders.origin } : {}),
}));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({ APP_URL: "https://darkview.test" }),
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentSession: vi.fn() }));
vi.mock("@/features/auth/authenticate", () => ({ signIn, register, verifyEmail }));

import { zUser } from "@darkview/contracts/zod";

import { POST as registerRoute } from "./register/route";
import { POST as signInRoute } from "./sign-in/route";
import { POST as verifyEmailRoute } from "./verify-email/route";

const user = {
  id: "6f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
  email: "observer@example.com",
  displayName: "Observer",
  role: "USER" as const,
  locale: "en" as const,
  createdAt: "2026-08-01T00:00:00.000Z",
};

const post = (body: unknown) =>
  new Request("https://darkview.test/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const routes = [
  { name: "sign-in", route: signInRoute, body: { email: user.email, password: "x" } },
  {
    name: "register",
    route: registerRoute,
    body: { displayName: "Observer", email: user.email, password: "long-enough-pw", locale: "en" },
  },
  { name: "verify-email", route: verifyEmailRoute, body: { token: "a".repeat(43) } },
];

beforeEach(() => {
  requestHeaders.origin = "https://darkview.test";
  vi.clearAllMocks();
});

describe.each(routes)("POST /auth/$name", ({ route, body }) => {
  it("refuses a foreign Origin with 403 before doing any work", async () => {
    requestHeaders.origin = "https://attacker.test";

    const response = await route(post(body));

    expect(response.status).toBe(403);
    expect(signIn).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(verifyEmail).not.toHaveBeenCalled();
  });

  it("refuses a missing Origin rather than waving it through", async () => {
    requestHeaders.origin = null;
    expect((await route(post(body))).status).toBe(403);
  });

  it("answers 400 to a body that is not JSON", async () => {
    expect((await route(post("{not json"))).status).toBe(400);
  });

  it("answers 422 to a body the contract rejects", async () => {
    expect((await route(post({ unexpected: true }))).status).toBe(422);
  });
});

describe("POST /auth/sign-in", () => {
  it("returns a User the contract's own schema accepts", async () => {
    signIn.mockResolvedValueOnce({ ok: true, user });

    const response = await signInRoute(post({ email: user.email, password: "x" }));

    expect(response.status).toBe(200);
    expect(zUser.parse(await response.json())).toEqual(user);
  });

  it("passes a refusal through as a contract ApiError", async () => {
    signIn.mockResolvedValueOnce({
      ok: false,
      status: 401,
      code: "UNAUTHENTICATED",
      message: "Email or password is incorrect.",
    });

    const response = await signInRoute(post({ email: user.email, password: "wrong" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "UNAUTHENTICATED",
      message: "Email or password is incorrect.",
    });
  });
});

describe("POST /auth/register", () => {
  it("answers 202 with no body", async () => {
    register.mockResolvedValueOnce({ ok: true });

    const response = await registerRoute(post(routes[1].body));

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("never echoes the submitted password in a validation error", async () => {
    const password = "short-secret";

    const response = await registerRoute(
      post({ displayName: "O", email: "not-an-email", password, locale: "en" }),
    );

    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain(password);
  });
});
