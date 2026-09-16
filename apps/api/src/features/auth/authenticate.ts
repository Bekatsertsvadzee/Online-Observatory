import "server-only";

import type {
  ErrorCode,
  RegisterRequest,
  SignInRequest,
  User,
  VerifyEmailRequest,
} from "@darkview/contracts";
import { ensureLoyaltyAccount, postLoyaltyEntry, readLoyaltyScheme } from "@darkview/db/loyalty";

import { toContractUser } from "@/features/identity/user";
import { recordAuthEvent } from "@/lib/auth/audit";
import { createOpaqueToken, hashToken } from "@/lib/auth/crypto";
import { sendEmailVerification } from "@/lib/auth/email-verification";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { getDatabase } from "@/lib/db/client";
import {
  AUTHENTICATION_POLICY,
  consumeLimit,
  consumeRegistrationOriginLimit,
  requestActor,
} from "@/lib/security/rate-limit";
import { getServerEnvironment } from "@/lib/validation/env";

/**
 * ADR-016: the DV-051 authentication logic, answering HTTP rather than a form.
 *
 * Each function returns data, never a response, so the route decides the status
 * line and these stay testable against a database without Next's request scope --
 * except for the cookies `createSession` writes, which is the point of calling it.
 */
export type Refusal = { ok: false; status: number; code: ErrorCode; message: string };

const refuse = (status: number, code: ErrorCode, message: string): Refusal => ({
  ok: false,
  status,
  code,
  message,
});

const rateLimited = () => refuse(429, "RATE_LIMITED", "Too many requests. Try again later.");

// Verified against when the address has no account, so an unknown address costs
// the same scrypt work as a wrong password and the two cannot be told apart by time.
const dummyPasswordHash =
  "scrypt$65536$8$1$BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc$h0__krhRoWlhZbCHOc0Wf_46L_kywkY8G1KOWdN5y1Xv6tVPAhQik6YPo8pqo9zhXGfH-l8diHELfuJ3eL0yxw";

const verificationLifetimeMs = 30 * 60 * 1000;

function normalizedEmail(value: string) {
  return value.trim().toLowerCase();
}

export async function signIn(
  request: SignInRequest,
): Promise<{ ok: true; user: User } | Refusal> {
  const email = normalizedEmail(request.email);
  const actor = await requestActor();
  const identity = `${actor}:${email}`;
  if (!(await consumeLimit(AUTHENTICATION_POLICY, "sign-in", identity))) {
    await recordAuthEvent("RATE_LIMITED", { actor: identity });
    return rateLimited();
  }

  const user = await getDatabase().user.findUnique({
    where: { email },
    include: { account: true },
  });
  const passwordValid = await verifyPassword(
    request.password,
    user?.account?.passwordHash ?? dummyPasswordHash,
  );

  if (!user || !passwordValid) {
    await recordAuthEvent("LOGIN_FAILED", { actor: identity });
    return refuse(401, "UNAUTHENTICATED", "Email or password is incorrect.");
  }
  if (!user.emailVerifiedAt) {
    return refuse(403, "FORBIDDEN", "Verify the email address before signing in.");
  }

  await createSession(user.id);
  await recordAuthEvent("LOGIN_SUCCEEDED", { userId: user.id, actor });
  return { ok: true, user: toContractUser(user) };
}

/**
 * `{ ok: true }` for a new address, an unverified one and a verified one alike.
 * The route answers 202 to all three, so the response cannot say which addresses
 * hold an account.
 */
export async function register(request: RegisterRequest): Promise<{ ok: true } | Refusal> {
  const displayName = request.displayName.trim();
  if (displayName.length < 2) {
    return refuse(422, "VALIDATION_FAILED", "displayName must be at least two characters.");
  }

  const environment = getServerEnvironment();
  if (
    !environment.EMAIL_VERIFICATION_WEBHOOK_URL ||
    !environment.EMAIL_VERIFICATION_WEBHOOK_SECRET
  ) {
    return refuse(503, "INTERNAL", "Email verification delivery is not configured.");
  }

  const email = normalizedEmail(request.email);
  const actor = await requestActor();
  const identity = `${actor}:${email}`;
  if (!(await consumeLimit(AUTHENTICATION_POLICY, "register", identity))) {
    await recordAuthEvent("RATE_LIMITED", { actor: identity });
    return rateLimited();
  }

  // The check above is keyed on the address *and* the email, so a fresh email
  // address is a fresh bucket: it caps attempts at one account, not the number
  // of accounts one client may create. This caps that, and only where the
  // address is real, which is why the check is a function rather than a
  // condition here.
  if (!(await consumeRegistrationOriginLimit(actor))) {
    await recordAuthEvent("RATE_LIMITED", { actor });
    return rateLimited();
  }

  const database = getDatabase();
  const existingUser = await database.user.findUnique({ where: { email } });
  if (existingUser?.emailVerifiedAt) return { ok: true };

  const token = createOpaqueToken();
  const user =
    existingUser ??
    (await database.user.create({
      data: {
        name: displayName,
        email,
        locale: request.locale,
        account: { create: { passwordHash: await hashPassword(request.password) } },
      },
    }));

  // DV-096. The referrer is recorded with the account and never changed: an
  // unverified re-registration cannot swap it. An unknown code is ignored rather
  // than refused, so a code does not reveal whether it exists.
  const referrer = request.referralCode
    ? await database.loyaltyAccount.findUnique({
        where: { referralCode: request.referralCode.toUpperCase() },
        select: { userId: true },
      })
    : null;
  await database.$transaction((tx) =>
    ensureLoyaltyAccount(tx, user.id, { referredByUserId: referrer?.userId ?? null }),
  );

  await database.$transaction([
    database.emailVerificationToken.deleteMany({ where: { userId: user.id } }),
    database.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + verificationLifetimeMs),
      },
    }),
  ]);

  try {
    await sendEmailVerification({
      recipient: user.email,
      locale: request.locale,
      verificationUrl: new URL(
        `/${request.locale}/verify-email/${token}`,
        environment.APP_URL,
      ).toString(),
    });
  } catch {
    return refuse(503, "INTERNAL", "Email verification delivery failed.");
  }

  if (!existingUser) await recordAuthEvent("REGISTERED", { userId: user.id, actor });
  return { ok: true };
}

export async function verifyEmail(
  request: VerifyEmailRequest,
): Promise<{ ok: true; user: User } | Refusal> {
  const invalid = refuse(
    422,
    "VALIDATION_FAILED",
    "The verification link is invalid or has expired.",
  );
  const database = getDatabase();
  const verification = await database.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(request.token) },
  });
  if (!verification) return invalid;

  const now = new Date();
  // Consumed by a conditional update rather than by the read above: two requests
  // carrying one link would both pass a read, and the contract says single-use.
  const user = await database.$transaction(async (tx) => {
    const consumed = await tx.emailVerificationToken.updateMany({
      where: { id: verification.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) return null;

    await tx.session.deleteMany({ where: { userId: verification.userId } });

    // DV-090. The welcome bonus on a verified address, not on sign-up, so an
    // address nobody controls earns nothing. Once per user, however it is reached.
    const { scheme } = await readLoyaltyScheme(tx);
    if (scheme.welcomeBonusPoints > 0) {
      await postLoyaltyEntry(tx, {
        userId: verification.userId,
        kind: "WELCOME_BONUS",
        points: scheme.welcomeBonusPoints,
        sourceRef: `user:${verification.userId}`,
      });
    }

    return tx.user.update({
      where: { id: verification.userId },
      data: { emailVerifiedAt: now },
    });
  });
  if (!user) return invalid;

  await createSession(user.id);
  await recordAuthEvent("EMAIL_VERIFIED", { userId: user.id });
  return { ok: true, user: toContractUser(user) };
}
