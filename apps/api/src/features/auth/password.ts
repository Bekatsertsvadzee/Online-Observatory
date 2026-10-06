import "server-only";

import type {
  ChangePasswordRequest,
  PasswordResetConfirmRequest,
  PasswordResetRequest,
  User,
} from "@darkview/contracts";

import {
  dummyPasswordHash,
  normalizedEmail,
  markEmailVerified,
  rateLimited,
  refuse,
  type Refusal,
} from "@/features/auth/authenticate";
import { toContractUser } from "@/features/identity/user";
import { recordAuthEvent } from "@/lib/auth/audit";
import { createOpaqueToken, hashToken } from "@/lib/auth/crypto";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { sendPasswordReset } from "@/lib/auth/password-reset-email";
import { createSession } from "@/lib/auth/session";
import type { VerifiedSession } from "@/lib/auth/types";
import { getDatabase } from "@/lib/db/client";
import {
  AUTHENTICATION_POLICY,
  consumeLimit,
  requestActor,
} from "@/lib/security/rate-limit";
import { getServerEnvironment } from "@/lib/validation/env";

/**
 * ADR-040: reset a forgotten password, and change a known one. Shaped like
 * `authenticate.ts`: data in, data out, the route picks the status line.
 */
const resetLifetimeMs = 30 * 60 * 1000;

/**
 * `{ ok: true }` for an unknown, an unverified and a verified address alike, so the
 * 202 cannot say which addresses hold an account.
 */
export async function requestPasswordReset(
  request: PasswordResetRequest,
): Promise<{ ok: true } | Refusal> {
  // Either delivery path is enough, as for registration: Resend (ADR-035) or the webhook.
  const environment = getServerEnvironment();
  const resend = environment.RESEND_API_KEY && environment.EMAIL_FROM;
  const webhook =
    environment.EMAIL_VERIFICATION_WEBHOOK_URL && environment.EMAIL_VERIFICATION_WEBHOOK_SECRET;
  if (!resend && !webhook) {
    return refuse(503, "INTERNAL", "Password reset delivery is not configured.");
  }

  const email = normalizedEmail(request.email);
  const actor = await requestActor();
  const identity = `${actor}:${email}`;
  if (!(await consumeLimit(AUTHENTICATION_POLICY, "password-reset", identity))) {
    await recordAuthEvent("RATE_LIMITED", { actor: identity });
    return rateLimited();
  }

  const database = getDatabase();
  const user = await database.user.findUnique({ where: { email } });
  if (!user) return { ok: true };

  // An unverified account is sent a reset link too. Its password may have been set by
  // somebody registering an address that is not theirs; a verification link would sign
  // the owner in with that password still on the account. Confirming replaces it and
  // verifies the address, which the link has just proved.
  try {
    const token = createOpaqueToken();
    await database.$transaction([
      database.passwordResetToken.deleteMany({ where: { userId: user.id } }),
      database.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + resetLifetimeMs),
        },
      }),
    ]);
    await sendPasswordReset({
      recipient: user.email,
      locale: request.locale,
      resetUrl: new URL(
        `/${request.locale}/reset-password/${token}`,
        environment.APP_URL,
      ).toString(),
    });
  } catch {
    return refuse(503, "INTERNAL", "Password reset delivery failed.");
  }

  await recordAuthEvent("PASSWORD_RESET_REQUESTED", { userId: user.id, actor });
  return { ok: true };
}

export async function confirmPasswordReset(
  request: PasswordResetConfirmRequest,
): Promise<{ ok: true; user: User } | Refusal> {
  // Not metered. The token is 256 random bits, so there is nothing to guess, and keyed
  // on an unattributed address a limiter here would be one bucket for every customer.
  const actor = await requestActor();
  const invalid = refuse(404, "NOT_FOUND", "The reset link is invalid, used or expired.");
  const database = getDatabase();
  const reset = await database.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(request.token) },
  });
  if (!reset) return invalid;

  // Hashed before the transaction: scrypt is slow, and a transaction held open for it
  // holds its locks for it too.
  const passwordHash = await hashPassword(request.password);
  const now = new Date();
  const user = await database.$transaction(async (tx) => {
    // Consumed by a conditional update, as a verification token is: two requests
    // carrying one link would both pass the read above.
    const consumed = await tx.passwordResetToken.updateMany({
      where: { id: reset.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) return null;

    await tx.account.update({ where: { userId: reset.userId }, data: { passwordHash } });
    await tx.session.deleteMany({ where: { userId: reset.userId } });
    // ADR-042: whoever takes the account back should not find it moving to an address
    // somebody else chose.
    await tx.emailChangeToken.deleteMany({ where: { userId: reset.userId } });

    const user = await tx.user.findUniqueOrThrow({ where: { id: reset.userId } });
    if (user.emailVerifiedAt) return user;
    await tx.emailVerificationToken.deleteMany({ where: { userId: reset.userId } });
    return markEmailVerified(tx, reset.userId, now);
  });
  if (!user) return invalid;

  await createSession(user.id);
  await recordAuthEvent("PASSWORD_RESET", { userId: user.id, actor });
  return { ok: true, user: toContractUser(user) };
}

export async function changePassword(
  session: VerifiedSession,
  request: ChangePasswordRequest,
): Promise<{ ok: true } | Refusal> {
  const userId = session.user.id;
  if (!(await consumeLimit(AUTHENTICATION_POLICY, "password-change", userId))) {
    await recordAuthEvent("RATE_LIMITED", { userId });
    return rateLimited();
  }

  const database = getDatabase();
  const account = await database.account.findUnique({ where: { userId } });
  const currentValid = await verifyPassword(
    request.currentPassword,
    account?.passwordHash ?? dummyPasswordHash,
  );
  if (!account || !currentValid) {
    return refuse(422, "VALIDATION_FAILED", "The current password is incorrect.", {
      fields: ["currentPassword"],
    });
  }

  const passwordHash = await hashPassword(request.password);
  await database.$transaction([
    database.account.update({ where: { userId }, data: { passwordHash } }),
    database.session.deleteMany({ where: { userId, id: { not: session.id } } }),
    // A reset link still in a mailbox would undo the change.
    database.passwordResetToken.deleteMany({ where: { userId } }),
    // And a pending change of address (ADR-042).
    database.emailChangeToken.deleteMany({ where: { userId } }),
  ]);

  await recordAuthEvent("PASSWORD_CHANGED", { userId });
  return { ok: true };
}
