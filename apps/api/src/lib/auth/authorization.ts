import "server-only";

import { redirect } from "next/navigation";

import type { Locale } from "@/lib/locale";
import { getCurrentSession } from "@/lib/auth/session";
import type { Role, VerifiedSession } from "@/lib/auth/types";

export class AuthorizationError extends Error {
  readonly status: 401 | 403;

  constructor(message: string, status: 401 | 403) {
    super(message);
    this.name = "AuthorizationError";
    this.status = status;
  }
}

export async function requireSession(locale: Locale) {
  const session = await getCurrentSession();
  if (!session) redirect(`/${locale}/sign-in`);
  return session;
}

export function assertRole(session: VerifiedSession, allowedRoles: readonly Role[]) {
  if (!allowedRoles.includes(session.user.role)) {
    throw new AuthorizationError("Insufficient role", 403);
  }
}

export async function requireRole(locale: Locale, allowedRoles: readonly Role[]) {
  const session = await requireSession(locale);
  assertRole(session, allowedRoles);
  return session;
}

export const observatoryAdministrativeRoles = ["OPERATOR"] as const;
