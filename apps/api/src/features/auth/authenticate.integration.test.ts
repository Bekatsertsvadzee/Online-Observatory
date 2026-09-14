import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase, cookieJar, sentLinks } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
  cookieJar: new Map<string, string>(),
  sentLinks: [] as string[],
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined,
    set: (name: string, value: string) => cookieJar.set(name, value),
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

const { register, signIn, verifyEmail } = await import("@/features/auth/authenticate");
const { hashToken } = await import("@/lib/auth/crypto");
const { sessionCookieName, csrfCookieName } = await import("@/lib/auth/cookies");

/**
 * ADR-016 against a real PostgreSQL instance: an account is created, verified
 * once and only once, and signed into, with no direct database edit advancing
 * any of it.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const PASSWORD = "a correct horse battery";

let database: PrismaClient;

const newAddress = () => `${randomUUID()}@example.test`;
const tokenFrom = (link: string) => link.slice(link.lastIndexOf("/") + 1);

async function registerAndCaptureToken(email: string) {
  const before = sentLinks.length;
  await expect(
    register({ displayName: "Observer", email, password: PASSWORD, locale: "ka" }),
  ).resolves.toEqual({ ok: true });
  expect(sentLinks).toHaveLength(before + 1);
  return tokenFrom(sentLinks[sentLinks.length - 1]);
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
});

describe("registration", () => {
  it("links to the web client's page, in the locale the customer chose", async () => {
    await registerAndCaptureToken(newAddress());
    expect(sentLinks.at(-1)).toMatch(/^https:\/\/darkview\.test\/ka\/verify-email\/[\w-]{43}$/);
  });

  it("issues no session before the address is verified", async () => {
    await registerAndCaptureToken(newAddress());
    expect(cookieJar.size).toBe(0);
  });

  it("answers a verified address exactly as a new one, and sends it nothing", async () => {
    const email = newAddress();
    await verifyEmail({ token: await registerAndCaptureToken(email) });
    const before = sentLinks.length;

    await expect(
      register({ displayName: "Someone else", email, password: PASSWORD, locale: "en" }),
    ).resolves.toEqual({ ok: true });
    expect(sentLinks).toHaveLength(before);
  });
});

describe("verification", () => {
  it("signs the customer in, and the cookie is the stored session", async () => {
    const email = newAddress();
    const result = await verifyEmail({ token: await registerAndCaptureToken(email) });

    expect(result).toMatchObject({ ok: true, user: { email, locale: "ka", role: "USER" } });
    const session = await database.session.findUnique({
      where: { tokenHash: hashToken(cookieJar.get(sessionCookieName)!) },
    });
    expect(session).not.toBeNull();
    expect(cookieJar.get(csrfCookieName)).toBeTruthy();
  });

  it("refuses a token the second time", async () => {
    const token = await registerAndCaptureToken(newAddress());
    await expect(verifyEmail({ token })).resolves.toMatchObject({ ok: true });

    await expect(verifyEmail({ token })).resolves.toMatchObject({
      ok: false,
      status: 422,
    });
  });

  it("lets exactly one of two simultaneous requests use one token", async () => {
    const token = await registerAndCaptureToken(newAddress());

    const results = await Promise.all([verifyEmail({ token }), verifyEmail({ token })]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it("refuses an expired token", async () => {
    const token = await registerAndCaptureToken(newAddress());
    await database.emailVerificationToken.update({
      where: { tokenHash: hashToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(verifyEmail({ token })).resolves.toMatchObject({ ok: false, status: 422 });
  });
});

describe("sign-in", () => {
  it("refuses an unverified address with 403, only after the password is checked", async () => {
    const email = newAddress();
    await registerAndCaptureToken(email);

    await expect(signIn({ email, password: "not the password" })).resolves.toMatchObject({
      status: 401,
    });
    await expect(signIn({ email, password: PASSWORD })).resolves.toMatchObject({
      status: 403,
    });
    expect(cookieJar.size).toBe(0);
  });

  it("gives an unknown address and a wrong password the same answer", async () => {
    const email = newAddress();
    await verifyEmail({ token: await registerAndCaptureToken(email) });
    cookieJar.clear();

    const wrongPassword = await signIn({ email, password: "not the password" });
    const unknownAddress = await signIn({ email: newAddress(), password: PASSWORD });

    expect(wrongPassword).toEqual(unknownAddress);
    expect(cookieJar.size).toBe(0);
  });

  it("issues a session for a verified address, whatever case it is typed in", async () => {
    const email = newAddress();
    await verifyEmail({ token: await registerAndCaptureToken(email) });
    cookieJar.clear();

    const result = await signIn({ email: email.toUpperCase(), password: PASSWORD });

    expect(result).toMatchObject({ ok: true, user: { email } });
    expect(cookieJar.has(sessionCookieName)).toBe(true);
  });
});
