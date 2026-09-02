import "server-only";

import { cookies } from "next/headers";
import { cache } from "react";

import { getDatabase } from "@/lib/db/client";
import {
  authenticationCookieOptions,
  csrfCookieName,
  sessionCookieName,
  sessionDurationSeconds,
} from "@/lib/auth/cookies";
import { createOpaqueToken, hashToken, tokenMatchesHash } from "@/lib/auth/crypto";
import type { VerifiedSession } from "@/lib/auth/types";

export async function createSession(userId: string) {
  const sessionToken = createOpaqueToken();
  const csrfToken = createOpaqueToken();
  const expiresAt = new Date(Date.now() + sessionDurationSeconds * 1000);

  await getDatabase().session.create({
    data: {
      userId,
      tokenHash: hashToken(sessionToken),
      csrfTokenHash: hashToken(csrfToken),
      expiresAt,
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(sessionCookieName, sessionToken, authenticationCookieOptions(true));
  cookieStore.set(csrfCookieName, csrfToken, authenticationCookieOptions(false));
}

export const getCurrentSession = cache(async (): Promise<VerifiedSession | null> => {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(sessionCookieName)?.value;
  const csrfToken = cookieStore.get(csrfCookieName)?.value;

  if (!sessionToken || !csrfToken) return null;

  const session = await getDatabase().session.findUnique({
    where: { tokenHash: hashToken(sessionToken) },
    include: { user: true },
  });

  if (
    !session ||
    session.expiresAt <= new Date() ||
    !session.user.emailVerifiedAt ||
    !tokenMatchesHash(csrfToken, session.csrfTokenHash)
  ) {
    return null;
  }

  return {
    id: session.id,
    expiresAt: session.expiresAt,
    csrfToken,
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role,
    },
  };
});

export async function deleteCurrentSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;

  if (token) {
    await getDatabase().session.deleteMany({
      where: { tokenHash: hashToken(token) },
    });
  }

  cookieStore.set(sessionCookieName, "", {
    ...authenticationCookieOptions(true),
    maxAge: 0,
  });
  cookieStore.set(csrfCookieName, "", {
    ...authenticationCookieOptions(false),
    maxAge: 0,
  });
}

export function csrfTokenIsValid(session: VerifiedSession, submittedToken: unknown) {
  return (
    typeof submittedToken === "string" &&
    submittedToken.length > 0 &&
    tokenMatchesHash(submittedToken, hashToken(session.csrfToken))
  );
}
