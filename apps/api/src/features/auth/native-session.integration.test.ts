import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase, cookieJar, requestHeaders, sentLinks } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
  cookieJar: new Map<string, string>(),
  requestHeaders: new Map<string, string>(),
  sentLinks: [] as string[],
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(Object.fromEntries(requestHeaders)),
  cookies: async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined,
    set: (name: string, value: string) =>
      value === "" ? cookieJar.delete(name) : cookieJar.set(name, value),
  }),
}));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({
    APP_URL: "https://darkview.test",
    AUTH_SECRET: "integration-test-secret-integration-test-secret",
    EMAIL_VERIFICATION_WEBHOOK_URL: "https://mail.darkview.test/hook",
    EMAIL_VERIFICATION_WEBHOOK_SECRET: "integration-test-webhook-secret-0000",
    TRUSTED_PROXY_HOPS: 0,
  }),
}));
vi.mock("@/lib/auth/email-verification", () => ({
  sendEmailVerification: async (message: { verificationUrl: string }) => {
    sentLinks.push(message.verificationUrl);
  },
}));

const { register, signIn, signInNative, verifyEmail } =
  await import("@/features/auth/authenticate");
const { getCurrentSession, deleteCurrentSession } = await import("@/lib/auth/session");
const { requireApiMutation } = await import("@/lib/auth/api-guard");
const { hashToken } = await import("@/lib/auth/crypto");
const { sessionCookieName, csrfCookieName } = await import("@/lib/auth/cookies");

/**
 * ADR-061 against a real PostgreSQL instance: a native client's bearer session is
 * issued without cookies, accepted only as a bearer, never in place of a cookie
 * session or the reverse, and ended by sign-out.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const PASSWORD = "a correct horse battery";

let database: PrismaClient;

async function verifiedAccount() {
  const email = `${randomUUID()}@example.test`;
  await register({ displayName: "Observer", email, password: PASSWORD, locale: "en" });
  const link = sentLinks.at(-1)!;
  await verifyEmail({ token: link.slice(link.lastIndexOf("/") + 1) });
  cookieJar.clear();
  return email;
}

async function nativeToken(email: string) {
  const result = await signInNative({ email, password: PASSWORD });
  if (!result.ok) throw new Error(result.message);
  return result.session.token;
}

beforeAll(() => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING }),
  });
  testDatabase.current = database;
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(() => {
  cookieJar.clear();
  requestHeaders.clear();
});

describe("native sign-in", () => {
  it("answers a bearer token, sets no cookie, and stores only a NATIVE row's hash", async () => {
    const email = await verifiedAccount();
    const result = await signInNative({ email, password: PASSWORD });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(cookieJar.size).toBe(0);
    expect(result.session.user.email).toBe(email);
    expect(Date.parse(result.session.expiresAt)).toBeGreaterThan(Date.now());

    const row = await database.session.findUnique({
      where: { tokenHash: hashToken(result.session.token) },
    });
    expect(row?.client).toBe("NATIVE");
    expect(
      await database.session.findUnique({ where: { tokenHash: result.session.token } }),
    ).toBeNull();
  });

  it("refuses a wrong password and an unverified address as sign-in does", async () => {
    const email = await verifiedAccount();
    await expect(signInNative({ email, password: "wrong" })).resolves.toMatchObject({
      ok: false,
      status: 401,
    });

    const unverified = `${randomUUID()}@example.test`;
    await register({
      displayName: "Observer",
      email: unverified,
      password: PASSWORD,
      locale: "en",
    });
    await expect(
      signInNative({ email: unverified, password: PASSWORD }),
    ).resolves.toMatchObject({
      ok: false,
      status: 403,
      code: "EMAIL_UNVERIFIED",
    });
  });
});

describe("a bearer request", () => {
  it("is authenticated by a NATIVE token", async () => {
    const email = await verifiedAccount();
    requestHeaders.set("authorization", `Bearer ${await nativeToken(email)}`);

    const session = await getCurrentSession();
    expect(session?.user.email).toBe(email);
    expect(session?.credential).toBe("bearer");
  });

  it("refuses a WEB session's token presented as a bearer", async () => {
    const email = await verifiedAccount();
    await signIn({ email, password: PASSWORD });
    const webToken = cookieJar.get(sessionCookieName)!;
    cookieJar.clear();

    requestHeaders.set("authorization", `Bearer ${webToken}`);
    expect(await getCurrentSession()).toBeNull();
  });

  it("is judged by the header alone: a bad one is not rescued by good cookies", async () => {
    const email = await verifiedAccount();
    await signIn({ email, password: PASSWORD });
    expect(await getCurrentSession()).not.toBeNull();

    requestHeaders.set(
      "authorization",
      "Bearer not-a-session-token-but-long-enough-to-parse",
    );
    expect(await getCurrentSession()).toBeNull();
    requestHeaders.set("authorization", "Basic dXNlcjpwYXNz");
    expect(await getCurrentSession()).toBeNull();
  });

  it("passes the mutation guard with no Origin, which a cookie request does not", async () => {
    const email = await verifiedAccount();
    await signIn({ email, password: PASSWORD });
    await expect(requireApiMutation()).resolves.toMatchObject({ ok: false });

    cookieJar.clear();
    requestHeaders.set("authorization", `Bearer ${await nativeToken(email)}`);
    await expect(requireApiMutation()).resolves.toMatchObject({ ok: true });
  });
});

describe("a cookie request", () => {
  it("refuses a NATIVE token placed in the session cookie", async () => {
    const email = await verifiedAccount();
    const token = await nativeToken(email);
    cookieJar.set(sessionCookieName, token);
    cookieJar.set(csrfCookieName, "whatever");

    expect(await getCurrentSession()).toBeNull();
  });
});

describe("sign-out with a bearer", () => {
  it("deletes that native session and leaves the account's web session alone", async () => {
    const email = await verifiedAccount();
    await signIn({ email, password: PASSWORD });
    const webToken = cookieJar.get(sessionCookieName)!;
    const token = await nativeToken(email);

    requestHeaders.set("authorization", `Bearer ${token}`);
    await deleteCurrentSession();

    expect(await getCurrentSession()).toBeNull();
    expect(
      await database.session.findUnique({ where: { tokenHash: hashToken(token) } }),
    ).toBeNull();
    expect(
      await database.session.findUnique({ where: { tokenHash: hashToken(webToken) } }),
    ).not.toBeNull();
    expect(cookieJar.get(sessionCookieName)).toBe(webToken);
  });
});
