import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase, cookieJar, sent, failDelivery } = vi.hoisted(() => ({
  failDelivery: { next: false },
  testDatabase: { current: null as unknown as PrismaClient },
  cookieJar: new Map<string, string>(),
  sent: [] as { kind: string; recipient: string; url?: string; locale?: string }[],
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
  sendEmailVerification: async (message: {
    recipient: string;
    verificationUrl: string;
  }) => {
    sent.push({
      kind: "VERIFY",
      recipient: message.recipient,
      url: message.verificationUrl,
    });
  },
}));
vi.mock("@/lib/auth/email-change-email", () => ({
  sendEmailChangeMessage: async (message: {
    kind: string;
    recipient: string;
    locale: string;
    verificationUrl?: string;
  }) => {
    if (failDelivery.next) {
      failDelivery.next = false;
      throw new Error("Email change delivery failed");
    }
    sent.push({
      kind: message.kind,
      recipient: message.recipient,
      locale: message.locale,
      url: message.verificationUrl,
    });
  },
}));
vi.mock("@/lib/auth/password-reset-email", () => ({
  sendPasswordReset: async (message: { recipient: string; resetUrl: string }) => {
    sent.push({ kind: "RESET", recipient: message.recipient, url: message.resetUrl });
  },
}));

const { register, signIn, verifyEmail } = await import("@/features/auth/authenticate");
const { changePassword, confirmPasswordReset, requestPasswordReset } =
  await import("@/features/auth/password");
const { confirmEmailChange, requestEmailChange, updateProfile } =
  await import("@/features/auth/profile");
const { getCurrentSession } = await import("@/lib/auth/session");

/**
 * ADR-042 against a real PostgreSQL instance: the name and language are edited, and an
 * address moves only when a link sent to the new one is followed.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const PASSWORD = "a correct horse battery";

let database: PrismaClient;

const newAddress = () => `${randomUUID()}@example.test`;
const tokenFrom = (url: string) => url.slice(url.lastIndexOf("/") + 1);

/** A verified account, signed in; returns the session the cookies carry. */
async function signedInAccount(locale: "en" | "ka" = "en") {
  const email = newAddress();
  await register({ displayName: "Observer", email, password: PASSWORD, locale });
  const verified = await verifyEmail({ token: tokenFrom(sent.at(-1)!.url!) });
  if (!verified.ok) throw new Error("verification failed");
  await database.user.update({ where: { email }, data: { locale } });
  cookieJar.clear();
  await expect(signIn({ email, password: PASSWORD })).resolves.toMatchObject({
    ok: true,
  });
  return { email, session: (await getCurrentSession())! };
}

async function changeLink(
  session: Awaited<ReturnType<typeof signedInAccount>>["session"],
  email: string,
) {
  const before = sent.length;
  await expect(
    requestEmailChange(session, { email, currentPassword: PASSWORD }),
  ).resolves.toEqual({ ok: true });
  const link = sent.slice(before).find((message) => message.kind === "EMAIL_CHANGE");
  return tokenFrom(link!.url!);
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

describe("editing the profile", () => {
  it("changes the name and the language, trimmed, and records it", async () => {
    const { session } = await signedInAccount();

    const result = await updateProfile(session, {
      displayName: "  Nino  ",
      locale: "ka",
    });

    expect(result).toMatchObject({
      ok: true,
      user: { displayName: "Nino", locale: "ka" },
    });
    expect(
      await database.auditLog.count({
        where: { actorUserId: session.user.id, action: "PROFILE_UPDATED" },
      }),
    ).toBe(1);
  });

  it("leaves a field the body does not name alone", async () => {
    const { session } = await signedInAccount();

    await updateProfile(session, { locale: "ka" });

    const user = await database.user.findUniqueOrThrow({
      where: { id: session.user.id },
    });
    expect(user.name).toBe("Observer");
  });

  it("refuses a name that is blank once trimmed", async () => {
    const { session } = await signedInAccount();

    await expect(updateProfile(session, { displayName: "   " })).resolves.toMatchObject({
      status: 422,
      details: { fields: ["displayName"] },
    });
  });
});

describe("asking for a new address", () => {
  it("sends a link to the new address in the account's language, and tells the old one", async () => {
    const { email, session } = await signedInAccount("ka");
    const target = newAddress();
    const before = sent.length;

    await requestEmailChange(session, { email: target, currentPassword: PASSWORD });

    const messages = sent.slice(before);
    expect(messages.map((message) => [message.kind, message.recipient])).toEqual([
      ["EMAIL_CHANGE", target],
      ["EMAIL_CHANGE_REQUESTED", email],
    ]);
    expect(messages[0]!.url).toMatch(
      /^https:\/\/darkview\.test\/ka\/verify-email\/[\w-]{43}$/,
    );
    expect(messages.every((message) => message.locale === "ka")).toBe(true);
  });

  it("keeps the current address until the link is followed", async () => {
    const { email, session } = await signedInAccount();
    await changeLink(session, newAddress());

    const user = await database.user.findUniqueOrThrow({
      where: { id: session.user.id },
    });
    expect(user.email).toBe(email);
  });

  it("refuses a wrong current password with 422 naming the field, and sends nothing", async () => {
    const { session } = await signedInAccount();
    const before = sent.length;

    await expect(
      requestEmailChange(session, {
        email: newAddress(),
        currentPassword: "not it at all",
      }),
    ).resolves.toMatchObject({ status: 422, details: { fields: ["currentPassword"] } });
    expect(sent).toHaveLength(before);
  });

  it("refuses the address the account already has", async () => {
    const { email, session } = await signedInAccount();

    await expect(
      requestEmailChange(session, {
        email: email.toUpperCase(),
        currentPassword: PASSWORD,
      }),
    ).resolves.toMatchObject({ status: 422, details: { fields: ["email"] } });
  });

  it("answers an address that holds an account as a free one, and sends it no link", async () => {
    const { session } = await signedInAccount();
    const { email: taken } = await signedInAccount();
    const before = sent.length;

    await expect(
      requestEmailChange(session, { email: taken, currentPassword: PASSWORD }),
    ).resolves.toEqual({ ok: true });

    expect(sent.slice(before).map((message) => message.kind)).toEqual([
      "EMAIL_IN_USE",
      "EMAIL_CHANGE_REQUESTED",
    ]);
    expect(
      await database.emailChangeToken.count({ where: { userId: session.user.id } }),
    ).toBe(0);
  });

  it("answers 503 when the mail service fails, so the customer can ask again", async () => {
    const { session } = await signedInAccount();
    failDelivery.next = true;

    await expect(
      requestEmailChange(session, { email: newAddress(), currentPassword: PASSWORD }),
    ).resolves.toMatchObject({ ok: false, status: 503 });
  });
});

describe("following the link", () => {
  it("moves the address, ends every session, and signs the opener in", async () => {
    const { session } = await signedInAccount();
    const target = newAddress();
    const token = await changeLink(session, target);
    cookieJar.clear();

    const result = await confirmEmailChange(token);

    expect(result).toMatchObject({ ok: true, user: { email: target } });
    expect(await database.session.findUnique({ where: { id: session.id } })).toBeNull();
    expect(await getCurrentSession()).toMatchObject({ user: { email: target } });
    expect(
      await database.auditLog.count({
        where: { actorUserId: session.user.id, action: "EMAIL_CHANGED" },
      }),
    ).toBe(1);
  });

  it("signs in at the new address, and not at the old", async () => {
    const { email, session } = await signedInAccount();
    const target = newAddress();
    await confirmEmailChange(await changeLink(session, target));
    cookieJar.clear();

    await expect(signIn({ email, password: PASSWORD })).resolves.toMatchObject({
      status: 401,
    });
    await expect(signIn({ email: target, password: PASSWORD })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("works once", async () => {
    const { session } = await signedInAccount();
    const token = await changeLink(session, newAddress());

    await expect(confirmEmailChange(token)).resolves.toMatchObject({ ok: true });
    await expect(confirmEmailChange(token)).resolves.toBeNull();
  });

  it("is replaced by a later request", async () => {
    const { session } = await signedInAccount();
    const first = await changeLink(session, newAddress());
    const second = await changeLink(session, newAddress());

    await expect(confirmEmailChange(first)).resolves.toBeNull();
    await expect(confirmEmailChange(second)).resolves.toMatchObject({ ok: true });
  });

  it("is dead when the address was taken in the meantime", async () => {
    const { session } = await signedInAccount();
    const target = newAddress();
    const token = await changeLink(session, target);
    await register({
      displayName: "Second",
      email: target,
      password: PASSWORD,
      locale: "en",
    });

    await expect(confirmEmailChange(token)).resolves.toBeNull();
    const user = await database.user.findUniqueOrThrow({
      where: { id: session.user.id },
    });
    expect(user.email).not.toBe(target);
  });

  it("removes a reset link that went to the old address", async () => {
    const { email, session } = await signedInAccount();
    await requestPasswordReset({ email, locale: "en" });
    const reset = tokenFrom(sent.at(-1)!.url!);

    await confirmEmailChange(await changeLink(session, newAddress()));

    await expect(
      confirmPasswordReset({ token: reset, password: "a brand new password" }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("cannot be used as a registration link, nor a registration link as a change", async () => {
    const { session } = await signedInAccount();
    const change = await changeLink(session, newAddress());
    await register({
      displayName: "Pending",
      email: newAddress(),
      password: PASSWORD,
      locale: "en",
    });
    const registration = tokenFrom(sent.at(-1)!.url!);

    await expect(verifyEmail({ token: change })).resolves.toMatchObject({ ok: false });
    await expect(confirmEmailChange(registration)).resolves.toBeNull();
  });
});

describe("taking the account back", () => {
  it("a password change cancels a pending change of address", async () => {
    const { session } = await signedInAccount();
    const token = await changeLink(session, newAddress());

    await changePassword(session, {
      currentPassword: PASSWORD,
      password: "a different horse entirely",
    });

    await expect(confirmEmailChange(token)).resolves.toBeNull();
  });

  it("a password reset cancels a pending change of address", async () => {
    const { email, session } = await signedInAccount();
    const token = await changeLink(session, newAddress());
    await requestPasswordReset({ email, locale: "en" });

    await confirmPasswordReset({
      token: tokenFrom(sent.at(-1)!.url!),
      password: "a different horse entirely",
    });

    await expect(confirmEmailChange(token)).resolves.toBeNull();
  });
});
