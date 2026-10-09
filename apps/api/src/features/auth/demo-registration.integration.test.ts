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
// The demo, with no way to send email: ADR-049's case.
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({
    APP_URL: "https://darkview.test",
    AUTH_SECRET: "integration-test-secret-integration-test-secret",
    DARKVIEW_DEPLOYMENT: "demo",
    TRUSTED_PROXY_HOPS: 0,
  }),
}));
vi.mock("@/lib/auth/email-verification", () => ({
  sendEmailVerification: async () => {
    throw new Error("never called: nothing is configured to send");
  },
}));

const { register, signIn } = await import("@/features/auth/authenticate");
const { sessionCookieName } = await import("@/lib/auth/cookies");

const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const PASSWORD = "a correct horse battery";
let database: PrismaClient;
const newAddress = () => `${randomUUID()}@example.test`;

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

describe("registration on the demo without email delivery (ADR-049)", () => {
  it("verifies a new address at once, signs it in, and the password works afterwards", async () => {
    const email = newAddress();
    const result = await register({ displayName: "Nino", email, password: PASSWORD, locale: "ka" });

    expect(result).toMatchObject({ ok: true, user: { email, displayName: "Nino", locale: "ka" } });
    expect(cookieJar.has(sessionCookieName)).toBe(true);
    const row = await database.user.findUniqueOrThrow({ where: { email } });
    expect(row.emailVerifiedAt).not.toBeNull();
    expect(await database.loyaltyAccount.findUnique({ where: { userId: row.id } })).not.toBeNull();

    cookieJar.clear();
    await expect(signIn({ email, password: PASSWORD })).resolves.toMatchObject({ ok: true });
  });

  it("signs nobody into an address that already holds an account", async () => {
    const email = newAddress();
    await register({ displayName: "First", email, password: PASSWORD, locale: "en" });
    cookieJar.clear();

    const again = await register({ displayName: "Second", email, password: "another password", locale: "en" });

    expect(again).toEqual({ ok: true });
    expect(cookieJar.size).toBe(0);
    await expect(signIn({ email, password: "another password" })).resolves.toMatchObject({
      status: 401,
    });
  });
});
