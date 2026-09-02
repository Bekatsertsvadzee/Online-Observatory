"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import type { Locale } from "@/lib/locale";
import { authCopy } from "@/lib/auth/messages";
import { recordAuthEvent } from "@/lib/auth/audit";
import { createOpaqueToken, hashToken } from "@/lib/auth/crypto";
import { sendEmailVerification } from "@/lib/auth/email-verification";
import { assertSameOrigin } from "@/lib/auth/origin";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { consumeAuthenticationLimit, requestActor } from "@/lib/auth/rate-limit";
import {
  createSession,
  csrfTokenIsValid,
  deleteCurrentSession,
  getCurrentSession,
} from "@/lib/auth/session";
import { getDatabase } from "@/lib/db/client";
import { getServerEnvironment } from "@/lib/validation/env";

export type AuthActionState = {
  message?: string;
  errors?: { name?: string; email?: string; password?: string };
};

const dummyPasswordHash =
  "scrypt$65536$8$1$BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc$h0__krhRoWlhZbCHOc0Wf_46L_kywkY8G1KOWdN5y1Xv6tVPAhQik6YPo8pqo9zhXGfH-l8diHELfuJ3eL0yxw";

function normalizedEmail(value: string) {
  return value.trim().toLowerCase();
}

function signInSchema(locale: Locale) {
  const copy = authCopy[locale];
  return z.object({
    email: z.email(copy.errors.invalidEmail).transform(normalizedEmail),
    password: z.string().min(1, copy.errors.invalidCredentials).max(128),
  });
}

function registrationSchema(locale: Locale) {
  const copy = authCopy[locale];
  return z.object({
    name: z.string().trim().min(2, copy.errors.shortName).max(80),
    email: z.email(copy.errors.invalidEmail).transform(normalizedEmail),
    password: z
      .string()
      .min(12, copy.errors.weakPassword)
      .max(128, copy.errors.weakPassword),
  });
}

function fieldErrors(error: z.ZodError) {
  const flattened = error.flatten().fieldErrors as Record<string, string[] | undefined>;
  return {
    name: flattened.name?.[0],
    email: flattened.email?.[0],
    password: flattened.password?.[0],
  };
}

export async function signInAction(
  locale: Locale,
  _state: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  await assertSameOrigin();
  const copy = authCopy[locale];
  const result = signInSchema(locale).safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!result.success) return { errors: fieldErrors(result.error) };

  const actor = await requestActor();
  const identity = `${actor}:${result.data.email}`;
  if (!(await consumeAuthenticationLimit("sign-in", identity))) {
    await recordAuthEvent("RATE_LIMITED", { actor: identity });
    return { message: copy.errors.rateLimited };
  }

  const user = await getDatabase().user.findUnique({
    where: { email: result.data.email },
    include: { account: true },
  });
  const passwordValid = await verifyPassword(
    result.data.password,
    user?.account?.passwordHash ?? dummyPasswordHash,
  );

  if (!user || !passwordValid) {
    await recordAuthEvent("LOGIN_FAILED", { actor: identity });
    return { message: copy.errors.invalidCredentials };
  }
  if (!user.emailVerifiedAt) return { message: copy.errors.unverified };

  await createSession(user.id);
  await recordAuthEvent("LOGIN_SUCCEEDED", { userId: user.id, actor });
  redirect(`/${locale}/app`);
}

export async function registerAction(
  locale: Locale,
  _state: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  await assertSameOrigin();
  const copy = authCopy[locale];
  const result = registrationSchema(locale).safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!result.success) return { errors: fieldErrors(result.error) };

  const environment = getServerEnvironment();
  if (
    !environment.EMAIL_VERIFICATION_WEBHOOK_URL ||
    !environment.EMAIL_VERIFICATION_WEBHOOK_SECRET
  ) {
    return { message: copy.errors.unavailable };
  }

  const actor = await requestActor();
  const identity = `${actor}:${result.data.email}`;
  if (!(await consumeAuthenticationLimit("register", identity))) {
    await recordAuthEvent("RATE_LIMITED", { actor: identity });
    return { message: copy.errors.rateLimited };
  }

  const database = getDatabase();
  const existingUser = await database.user.findUnique({
    where: { email: result.data.email },
  });

  if (existingUser?.emailVerifiedAt) {
    redirect(`/${locale}/verify-email`);
  }

  const token = createOpaqueToken();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const user = existingUser
    ? existingUser
    : await database.user.create({
        data: {
          name: result.data.name,
          email: result.data.email,
          account: {
            create: { passwordHash: await hashPassword(result.data.password) },
          },
        },
      });

  await database.$transaction([
    database.emailVerificationToken.deleteMany({ where: { userId: user.id } }),
    database.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt },
    }),
  ]);

  try {
    await sendEmailVerification({
      recipient: user.email,
      locale,
      verificationUrl: new URL(
        `/${locale}/verify-email/${token}`,
        environment.APP_URL,
      ).toString(),
    });
  } catch {
    return { message: copy.errors.unavailable };
  }

  if (!existingUser) await recordAuthEvent("REGISTERED", { userId: user.id, actor });
  redirect(`/${locale}/verify-email`);
}

export async function verifyEmailAction(locale: Locale, token: string) {
  await assertSameOrigin();
  const database = getDatabase();
  const verification = await database.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });

  if (!verification || verification.consumedAt || verification.expiresAt <= new Date()) {
    redirect(`/${locale}/verify-email/${encodeURIComponent(token)}?invalid=1`);
  }

  await database.$transaction([
    database.user.update({
      where: { id: verification.userId },
      data: { emailVerifiedAt: new Date() },
    }),
    database.emailVerificationToken.update({
      where: { id: verification.id },
      data: { consumedAt: new Date() },
    }),
    database.session.deleteMany({ where: { userId: verification.userId } }),
  ]);
  await createSession(verification.userId);
  await recordAuthEvent("EMAIL_VERIFIED", { userId: verification.userId });
  redirect(`/${locale}/app`);
}

export async function logoutAction(locale: Locale, formData: FormData) {
  await assertSameOrigin();
  const session = await getCurrentSession();
  if (!session || !csrfTokenIsValid(session, formData.get("csrfToken"))) {
    redirect(`/${locale}/sign-in`);
  }

  await deleteCurrentSession();
  await recordAuthEvent("LOGGED_OUT", { userId: session.user.id });
  redirect(`/${locale}/sign-in`);
}
