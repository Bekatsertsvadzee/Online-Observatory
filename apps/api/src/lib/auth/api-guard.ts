import "server-only";

import { getCurrentSession } from "@/lib/auth/session";
import type { VerifiedSession } from "@/lib/auth/types";
import { forbidden, unauthenticated } from "@/lib/http/api-error";

/**
 * Route guards for the API. These return a response rather than redirecting:
 * a redirect to a sign-in page is a browser affordance, and this app answers
 * machines. The web client turns 401 into whatever navigation it wants.
 *
 * Usage keeps the happy path flat:
 *
 *   const guard = await requireOperator();
 *   if (!guard.ok) return guard.response;
 *   guard.session // typed, present, OPERATOR
 */
export type GuardResult =
  | { ok: true; session: VerifiedSession }
  | { ok: false; response: ReturnType<typeof unauthenticated> };

export async function requireApiSession(): Promise<GuardResult> {
  const session = await getCurrentSession();
  if (!session) return { ok: false, response: unauthenticated() };
  return { ok: true, session };
}

/**
 * OPERATOR is the only administrative role. Every `/admin/*` route must call this
 * before it does anything else; `admin-routes-guarded.test.ts` enforces that.
 */
export async function requireOperator(): Promise<GuardResult> {
  const guard = await requireApiSession();
  if (!guard.ok) return guard;
  if (guard.session.user.role !== "OPERATOR") {
    return { ok: false, response: forbidden() };
  }
  return guard;
}
