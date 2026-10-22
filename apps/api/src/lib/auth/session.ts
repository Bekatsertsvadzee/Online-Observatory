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
import { requestBearerToken } from "@/lib/auth/bearer";
import type { AuthenticatedUser, VerifiedSession } from "@/lib/auth/types";

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

/**
 * ADR-061 §1: a native client's session. The token is returned once, for the response
 * body; only its hash is stored. Nothing is set on the response.
 */
export async function createNativeSession(userId: string) {
  const token = createOpaqueToken();
  const expiresAt = new Date(Date.now() + sessionDurationSeconds * 1000);

  await getDatabase().session.create({
    data: {
      userId,
      client: "NATIVE",
      tokenHash: hashToken(token),
      // The column is required; a native session has no CSRF cookie, so this is the
      // hash of a value nobody keeps.
      csrfTokenHash: hashToken(createOpaqueToken()),
      expiresAt,
    },
  });

  return { token, expiresAt };
}

type SessionRow = {
  id: string;
  expiresAt: Date;
  user: {
    id: string;
    email: string;
    name: string;
    role: AuthenticatedUser["role"];
    locale: AuthenticatedUser["locale"];
    createdAt: Date;
    emailVerifiedAt: Date | null;
  };
};

function verified(
  session: SessionRow,
  credential: VerifiedSession["credential"],
  csrfToken: string,
): VerifiedSession {
  return {
    id: session.id,
    expiresAt: session.expiresAt,
    csrfToken,
    credential,
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role,
      locale: session.user.locale,
      createdAt: session.user.createdAt,
    },
  };
}

export const getCurrentSession = cache(async (): Promise<VerifiedSession | null> => {
  const bearer = await requestBearerToken();
  if (bearer !== undefined) {
    if (bearer === null) return null;
    const session = await getDatabase().session.findUnique({
      where: { tokenHash: hashToken(bearer) },
      include: { user: true },
    });
    if (
      !session ||
      session.client !== "NATIVE" ||
      session.expiresAt <= new Date() ||
      !session.user.emailVerifiedAt
    ) {
      return null;
    }
    return verified(session, "bearer", "");
  }

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
    session.client !== "WEB" ||
    session.expiresAt <= new Date() ||
    !session.user.emailVerifiedAt ||
    !tokenMatchesHash(csrfToken, session.csrfTokenHash)
  ) {
    return null;
  }

  return verified(session, "cookie", csrfToken);
});

export async function deleteCurrentSession() {
  // ADR-061: a bearer request signs out its own native session and leaves the cookies,
  // which are not its credential, alone.
  const bearer = await requestBearerToken();
  if (bearer !== undefined) {
    if (bearer) {
      await getDatabase().session.deleteMany({
        where: { tokenHash: hashToken(bearer), client: "NATIVE" },
      });
    }
    return;
  }

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
    session.credential === "cookie" &&
    typeof submittedToken === "string" &&
    submittedToken.length > 0 &&
    tokenMatchesHash(submittedToken, hashToken(session.csrfToken))
  );
}
