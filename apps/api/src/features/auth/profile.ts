import "server-only";

import type { ChangeEmailRequest, UpdateProfileRequest, User } from "@darkview/contracts";

import {
  dummyPasswordHash,
  normalizedEmail,
  rateLimited,
  refuse,
  type Refusal,
} from "@/features/auth/authenticate";
import { toContractUser } from "@/features/identity/user";
import { recordAuthEvent } from "@/lib/auth/audit";
import { createOpaqueToken, hashToken } from "@/lib/auth/crypto";
import { sendEmailChangeMessage } from "@/lib/auth/email-change-email";
import { verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import type { VerifiedSession } from "@/lib/auth/types";
import { getDatabase } from "@/lib/db/client";
import { AUTHENTICATION_POLICY, consumeLimit } from "@/lib/security/rate-limit";
import { getServerEnvironment } from "@/lib/validation/env";

/**
 * ADR-042: edit the profile, and change the email address. Shaped like `password.ts`:
 * data in, data out, the route picks the status line.
 */
const changeLifetimeMs = 30 * 60 * 1000;

export async function updateProfile(
  session: VerifiedSession,
  request: UpdateProfileRequest,
): Promise<{ ok: true; user: User } | Refusal> {
  const name = request.displayName?.trim();
  if (name !== undefined && name.length < 2) {
    return refuse(
      422,
      "VALIDATION_FAILED",
      "displayName must be at least two characters.",
      {
        fields: ["displayName"],
      },
    );
  }

  const user = await getDatabase().user.update({
    where: { id: session.user.id },
    data: { name, locale: request.locale },
  });

  await recordAuthEvent("PROFILE_UPDATED", { userId: user.id });
  return { ok: true, user: toContractUser(user) };
}

/**
 * `{ ok: true }` whether or not the new address holds an account, so the 202 cannot
 * say which addresses do.
 */
export async function requestEmailChange(
  session: VerifiedSession,
  request: ChangeEmailRequest,
): Promise<{ ok: true } | Refusal> {
  // Either delivery path is enough, as for registration: Resend (ADR-035) or the webhook.
  const environment = getServerEnvironment();
  const resend = environment.RESEND_API_KEY && environment.EMAIL_FROM;
  const webhook =
    environment.EMAIL_VERIFICATION_WEBHOOK_URL &&
    environment.EMAIL_VERIFICATION_WEBHOOK_SECRET;
  if (!resend && !webhook) {
    return refuse(503, "INTERNAL", "Email change delivery is not configured.");
  }

  const userId = session.user.id;
  if (!(await consumeLimit(AUTHENTICATION_POLICY, "email-change", userId))) {
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

  const newEmail = normalizedEmail(request.email);
  if (newEmail === session.user.email) {
    return refuse(422, "VALIDATION_FAILED", "That is already the account's address.", {
      fields: ["email"],
    });
  }

  // The account's language, not the request's: the link and both notices are for the
  // customer, whatever page they asked from.
  const locale = session.user.locale;
  const taken = await database.user.findUnique({ where: { email: newEmail } });
  try {
    if (taken) {
      await sendEmailChangeMessage({ kind: "EMAIL_IN_USE", recipient: newEmail, locale });
    } else {
      const token = createOpaqueToken();
      await database.$transaction([
        database.emailChangeToken.deleteMany({ where: { userId } }),
        database.emailChangeToken.create({
          data: {
            userId,
            newEmail,
            tokenHash: hashToken(token),
            expiresAt: new Date(Date.now() + changeLifetimeMs),
          },
        }),
      ]);
      await sendEmailChangeMessage({
        kind: "EMAIL_CHANGE",
        recipient: newEmail,
        locale,
        verificationUrl: new URL(
          `/${locale}/verify-email/${token}`,
          environment.APP_URL,
        ).toString(),
      });
    }
    await sendEmailChangeMessage({
      kind: "EMAIL_CHANGE_REQUESTED",
      recipient: session.user.email,
      locale,
    });
  } catch {
    return refuse(503, "INTERNAL", "Email change delivery failed.");
  }

  await recordAuthEvent("EMAIL_CHANGE_REQUESTED", { userId });
  return { ok: true };
}

/**
 * Reached from `verifyEmail` for a token that is not a registration link. `null` when
 * it is not a change link either, so the caller answers as it does for any dead link.
 */
export async function confirmEmailChange(
  token: string,
): Promise<{ ok: true; user: User } | null> {
  const database = getDatabase();
  const change = await database.emailChangeToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!change) return null;

  const now = new Date();
  let user;
  try {
    user = await database.$transaction(async (tx) => {
      // Consumed by a conditional update, as every link is: two requests carrying one
      // link would both pass the read above.
      const consumed = await tx.emailChangeToken.updateMany({
        where: { id: change.id, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) return null;

      const user = await tx.user.update({
        where: { id: change.userId },
        data: { email: change.newEmail },
      });
      await tx.session.deleteMany({ where: { userId: change.userId } });
      // A reset link went to the old address; it must not outlive the move.
      await tx.passwordResetToken.deleteMany({ where: { userId: change.userId } });
      return user;
    });
  } catch (error) {
    // The address was taken between the request and the link.
    if (isUniqueViolation(error)) return null;
    throw error;
  }
  if (!user) return null;

  await createSession(user.id);
  await recordAuthEvent("EMAIL_CHANGED", { userId: user.id });
  return { ok: true, user: toContractUser(user) };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}
