import { zSignInBody } from "@darkview/contracts/zod";

import { signIn } from "@/features/auth/authenticate";
import { crossOriginRefusal } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * POST /auth/sign-in -- ADR-016. Sets the session cookies and returns the User.
 *
 * Origin-checked although no session exists yet: a cross-site form that signs a
 * visitor into the attacker's account steals nothing and is still an attack.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const refusal = await crossOriginRefusal();
  if (refusal) return refusal;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return apiError(400, "BAD_REQUEST", "Body must be JSON.");
  }

  const body = zSignInBody.safeParse(payload);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "SignInRequest is malformed.");
  }

  const result = await signIn(body.data);
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.user);
}
