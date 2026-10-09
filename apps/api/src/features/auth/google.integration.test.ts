import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase, cookieJar } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
  cookieJar: new Map<string, string>(),
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
    GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "client-secret",
    TRUSTED_PROXY_HOPS: 0,
  }),
}));

const { completeGoogleSignIn, startGoogleSignIn, googleStateCookieName } = await import(
  "@/features/auth/google"
);
const { sessionCookieName, csrfCookieName } = await import("@/lib/auth/cookies");
const { hashPassword } = await import("@/lib/auth/password");

/**
 * ADR-048 against a real PostgreSQL instance: the state round-trips, a verified
 * Google address signs in or creates the account, and every failure is the one
 * sign-in page with `error=google`.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

let database: PrismaClient;

const newAddress = () => `${randomUUID()}@example.test`;

/** What a browser does: follow the start, keep the cookie, come back with the state. */
async function start() {
  const result = await startGoogleSignIn("ka");
  if (!result.ok) throw new Error("start refused");
  const state = new URL(result.location).searchParams.get("state")!;
  const stateCookie = cookieJar.get(googleStateCookieName) ?? result.stateCookie;
  return { state, stateCookie };
}

function google(identity: { email: string; subject?: string; name?: string; verified?: boolean }) {
  return async () => ({
    subject: identity.subject ?? `sub-${identity.email}`,
    email: identity.email,
    emailVerified: identity.verified ?? true,
    name: identity.name ?? null,
  });
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

describe("the start", () => {
  it("sends the browser to Google with a state it remembers in a cookie", async () => {
    const result = await startGoogleSignIn("ka");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.location);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://darkview.test/api/auth/google/callback",
    );
    expect(url.searchParams.get("client_id")).toBe("client-id.apps.googleusercontent.com");
    expect(url.searchParams.get("state")).toMatch(/^[\w-]{32}$/);
    expect(result.stateCookie.split(".")[0]).toBe(url.searchParams.get("state"));
    expect(result.stateCookie.split(".")[1]).toBe("ka");
  });
});

describe("the callback", () => {
  it("creates a verified account for a new address, with Google's name, and signs it in", async () => {
    const email = newAddress();
    const { state, stateCookie } = await start();

    const { location } = await completeGoogleSignIn(
      { code: "code", state, stateCookie },
      google({ email, name: "Nino" }),
    );

    expect(location).toBe("/ka/app");
    expect([...cookieJar.keys()]).toEqual(
      expect.arrayContaining([sessionCookieName, csrfCookieName]),
    );
    const user = await database.user.findUniqueOrThrow({ where: { email } });
    expect(user).toMatchObject({ name: "Nino", locale: "ka", googleSubject: `sub-${email}` });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(await database.account.findUnique({ where: { userId: user.id } })).toBeNull();
    expect(await database.loyaltyAccount.findUnique({ where: { userId: user.id } })).not.toBeNull();
  });

  it("signs in the password account that holds the address, links it, and verifies it", async () => {
    const email = newAddress();
    const subject = `sub-${randomUUID()}`;
    const existing = await database.user.create({
      data: {
        name: "Observer",
        email,
        locale: "en",
        account: { create: { passwordHash: await hashPassword("a correct horse battery") } },
      },
    });
    const { state, stateCookie } = await start();

    const { location } = await completeGoogleSignIn(
      { code: "code", state, stateCookie },
      google({ email, subject }),
    );

    expect(location).toBe("/ka/app");
    const user = await database.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(user.googleSubject).toBe(subject);
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.name).toBe("Observer");
  });

  it("finds a linked account by its Google id even after the Google address changed", async () => {
    const email = newAddress();
    const subject = `sub-${randomUUID()}`;
    const { state, stateCookie } = await start();
    await completeGoogleSignIn({ code: "code", state, stateCookie }, google({ email, subject }));
    const user = await database.user.findUniqueOrThrow({ where: { email } });
    cookieJar.clear();

    const second = await start();
    const { location } = await completeGoogleSignIn(
      { code: "code", state: second.state, stateCookie: second.stateCookie },
      google({ email: newAddress(), subject }),
    );

    expect(location).toBe("/ka/app");
    const session = await database.session.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    expect(session).not.toBeNull();
    expect(await database.user.count({ where: { googleSubject: subject } })).toBe(1);
  });

  it("refuses a state that does not match the cookie, and a cookie that is missing", async () => {
    const { stateCookie } = await start();
    expect(
      await completeGoogleSignIn(
        { code: "code", state: "somebody-elses", stateCookie },
        google({ email: newAddress() }),
      ),
    ).toEqual({ location: "/ka/sign-in?error=google" });
    expect(
      await completeGoogleSignIn(
        { code: "code", state: "x", stateCookie: null },
        google({ email: newAddress() }),
      ),
    ).toEqual({ location: "/en/sign-in?error=google" });
    expect(cookieJar.has(sessionCookieName)).toBe(false);
  });

  it("refuses a forged cookie, an unverified address, and a refused code", async () => {
    const { state, stateCookie } = await start();
    const forged = stateCookie.replace(/\.[^.]+$/, ".forged");
    expect(
      await completeGoogleSignIn({ code: "code", state, stateCookie: forged }, google({ email: newAddress() })),
    ).toEqual({ location: "/en/sign-in?error=google" });
    expect(
      await completeGoogleSignIn(
        { code: "code", state, stateCookie },
        google({ email: newAddress(), verified: false }),
      ),
    ).toEqual({ location: "/ka/sign-in?error=google" });
    expect(
      await completeGoogleSignIn({ code: "code", state, stateCookie }, async () => {
        throw new Error("invalid_grant");
      }),
    ).toEqual({ location: "/ka/sign-in?error=google" });
    expect(cookieJar.has(sessionCookieName)).toBe(false);
  });

  it("never revives a deleted account", async () => {
    const email = newAddress();
    await database.user.create({
      data: { name: "Deleted", email, locale: "en", deletedAt: new Date() },
    });
    const { state, stateCookie } = await start();

    expect(
      await completeGoogleSignIn({ code: "code", state, stateCookie }, google({ email })),
    ).toEqual({ location: "/ka/sign-in?error=google" });
    expect(cookieJar.has(sessionCookieName)).toBe(false);
  });
});
