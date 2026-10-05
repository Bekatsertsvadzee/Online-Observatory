import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase, cookieJar, sentLinks, failDelivery } = vi.hoisted(() => ({
  failDelivery: { next: false },
  testDatabase: { current: null as unknown as PrismaClient },
  cookieJar: new Map<string, string>(),
  sentLinks: [] as { kind: "VERIFY" | "RESET"; url: string }[],
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
    sentLinks.push({ kind: "VERIFY", url: message.verificationUrl });
  },
}));
vi.mock("@/lib/auth/password-reset-email", () => ({
  sendPasswordReset: async (message: { resetUrl: string }) => {
    if (failDelivery.next) {
      failDelivery.next = false;
      throw new Error("Password reset delivery failed");
    }
    sentLinks.push({ kind: "RESET", url: message.resetUrl });
  },
}));

const { register, signIn, verifyEmail } = await import("@/features/auth/authenticate");
const { changePassword, confirmPasswordReset, requestPasswordReset } =
  await import("@/features/auth/password");
const { getCurrentSession } = await import("@/lib/auth/session");
const { hashToken } = await import("@/lib/auth/crypto");
const { sessionCookieName } = await import("@/lib/auth/cookies");

/**
 * ADR-040 against a real PostgreSQL instance: a forgotten password is reset through
 * a single-use link, and a known one is changed, each ending the sessions it should.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const PASSWORD = "a correct horse battery";
const NEW_PASSWORD = "a different horse entirely";

let database: PrismaClient;

const newAddress = () => `${randomUUID()}@example.test`;
const tokenFrom = (url: string) => url.slice(url.lastIndexOf("/") + 1);

async function verifiedAccount() {
  const email = newAddress();
  await register({ displayName: "Observer", email, password: PASSWORD, locale: "en" });
  const result = await verifyEmail({ token: tokenFrom(sentLinks.at(-1)!.url) });
  if (!result.ok) throw new Error("verification failed");
  cookieJar.clear();
  return { email, userId: result.user.id };
}

async function resetToken(email: string) {
  const before = sentLinks.length;
  await expect(requestPasswordReset({ email, locale: "ka" })).resolves.toEqual({
    ok: true,
  });
  expect(sentLinks).toHaveLength(before + 1);
  expect(sentLinks.at(-1)!.kind).toBe("RESET");
  return tokenFrom(sentLinks.at(-1)!.url);
}

/** Signs in and returns the session the cookies now carry. */
async function signedInSession(email: string, password: string) {
  cookieJar.clear();
  await expect(signIn({ email, password })).resolves.toMatchObject({ ok: true });
  return (await getCurrentSession())!;
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

describe("asking for a reset", () => {
  it("links to the web client's page, in the locale the request named", async () => {
    const { email } = await verifiedAccount();
    await resetToken(email);
    expect(sentLinks.at(-1)!.url).toMatch(
      /^https:\/\/darkview\.test\/ka\/reset-password\/[\w-]{43}$/,
    );
  });

  it("answers an unknown address exactly as a known one, and sends it nothing", async () => {
    const before = sentLinks.length;
    await expect(
      requestPasswordReset({ email: newAddress(), locale: "en" }),
    ).resolves.toEqual({ ok: true });
    expect(sentLinks).toHaveLength(before);
  });

  it("lets the owner of an address somebody else registered take it back", async () => {
    // Somebody registers an address that is not theirs, with their own password.
    const email = newAddress();
    await register({ displayName: "Squatter", email, password: PASSWORD, locale: "en" });
    const verificationToken = tokenFrom(sentLinks.at(-1)!.url);

    // The owner asks for a reset and gets one: a verification link would sign them in
    // with the squatter's password still on the account.
    const token = await resetToken(email);
    const result = await confirmPasswordReset({ token, password: NEW_PASSWORD });

    expect(result).toMatchObject({ ok: true, user: { email } });
    const user = await database.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(
      await database.loyaltyLedgerEntry.count({
        where: { userId: user.id, kind: "WELCOME_BONUS" },
      }),
    ).toBeLessThanOrEqual(1);
    cookieJar.clear();
    await expect(signIn({ email, password: PASSWORD })).resolves.toMatchObject({
      status: 401,
    });
    // The squatter's verification link is gone with their password.
    await expect(verifyEmail({ token: verificationToken })).resolves.toMatchObject({
      ok: false,
    });
  });

  it("answers 503 when the mail service fails, so the customer can try again", async () => {
    const { email } = await verifiedAccount();
    failDelivery.next = true;

    await expect(requestPasswordReset({ email, locale: "en" })).resolves.toMatchObject({
      ok: false,
      status: 503,
    });
  });

  it("replaces an earlier link", async () => {
    const { email } = await verifiedAccount();
    const first = await resetToken(email);
    const second = await resetToken(email);

    await expect(
      confirmPasswordReset({ token: first, password: NEW_PASSWORD }),
    ).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(
      confirmPasswordReset({ token: second, password: NEW_PASSWORD }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("records the request against the account", async () => {
    const { email, userId } = await verifiedAccount();
    await resetToken(email);

    const rows = await database.auditLog.findMany({
      where: { actorUserId: userId, action: "PASSWORD_RESET_REQUESTED" },
    });
    expect(rows).toHaveLength(1);
  });
});

describe("confirming a reset", () => {
  it("sets the password, signs the customer in, and ends every earlier session", async () => {
    const { email, userId } = await verifiedAccount();
    const earlier = await signedInSession(email, PASSWORD);
    const token = await resetToken(email);
    cookieJar.clear();

    const result = await confirmPasswordReset({ token, password: NEW_PASSWORD });

    expect(result).toMatchObject({ ok: true, user: { id: userId, email } });
    expect(await database.session.findUnique({ where: { id: earlier.id } })).toBeNull();
    const current = await database.session.findUnique({
      where: { tokenHash: hashToken(cookieJar.get(sessionCookieName)!) },
    });
    expect(current?.userId).toBe(userId);

    cookieJar.clear();
    await expect(signIn({ email, password: PASSWORD })).resolves.toMatchObject({
      status: 401,
    });
    await expect(signIn({ email, password: NEW_PASSWORD })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("refuses a token the second time with 404", async () => {
    const { email } = await verifiedAccount();
    const token = await resetToken(email);
    await expect(
      confirmPasswordReset({ token, password: NEW_PASSWORD }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      confirmPasswordReset({ token, password: PASSWORD }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("lets exactly one of two simultaneous requests use one token", async () => {
    const { email } = await verifiedAccount();
    const token = await resetToken(email);

    const results = await Promise.all([
      confirmPasswordReset({ token, password: NEW_PASSWORD }),
      confirmPasswordReset({ token, password: "a third horse, also long" }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it("refuses an expired token, and leaves the password alone", async () => {
    const { email } = await verifiedAccount();
    const token = await resetToken(email);
    await database.passwordResetToken.update({
      where: { tokenHash: hashToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      confirmPasswordReset({ token, password: NEW_PASSWORD }),
    ).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(signIn({ email, password: PASSWORD })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("refuses a token it never issued", async () => {
    await expect(
      confirmPasswordReset({ token: "x".repeat(43), password: NEW_PASSWORD }),
    ).resolves.toMatchObject({ ok: false, status: 404 });
    expect(cookieJar.size).toBe(0);
  });
});

describe("changing a known password", () => {
  it("changes it, keeps this session and ends every other", async () => {
    const { email } = await verifiedAccount();
    const other = await signedInSession(email, PASSWORD);
    const current = await signedInSession(email, PASSWORD);

    await expect(
      changePassword(current, { currentPassword: PASSWORD, password: NEW_PASSWORD }),
    ).resolves.toEqual({ ok: true });

    expect(
      await database.session.findUnique({ where: { id: current.id } }),
    ).not.toBeNull();
    expect(await database.session.findUnique({ where: { id: other.id } })).toBeNull();
    cookieJar.clear();
    await expect(signIn({ email, password: NEW_PASSWORD })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("refuses a wrong current password as a field error, not a lost session", async () => {
    const { email } = await verifiedAccount();
    const session = await signedInSession(email, PASSWORD);

    await expect(
      changePassword(session, {
        currentPassword: "not the password",
        password: NEW_PASSWORD,
      }),
    ).resolves.toEqual({
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      message: "The current password is incorrect.",
      details: { fields: ["currentPassword"] },
    });
    await expect(signIn({ email, password: PASSWORD })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("kills a reset link still in the mailbox", async () => {
    const { email } = await verifiedAccount();
    const token = await resetToken(email);
    const session = await signedInSession(email, PASSWORD);

    await changePassword(session, { currentPassword: PASSWORD, password: NEW_PASSWORD });

    await expect(
      confirmPasswordReset({ token, password: PASSWORD }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("stops after five attempts in the window", async () => {
    const { email } = await verifiedAccount();
    const session = await signedInSession(email, PASSWORD);
    const attempt = () =>
      changePassword(session, {
        currentPassword: "not the password",
        password: NEW_PASSWORD,
      });

    for (let i = 0; i < 5; i += 1) {
      await expect(attempt()).resolves.toMatchObject({ status: 422 });
    }
    await expect(attempt()).resolves.toMatchObject({ status: 429, code: "RATE_LIMITED" });
  });
});
