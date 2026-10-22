import { zSignInBody } from "@darkview/contracts/zod";

import { signInNative } from "@/features/auth/authenticate";
import { apiError } from "@/lib/http/api-error";

/**
 * POST /auth/native-sign-in -- ADR-061. The mobile application's sign-in: a bearer
 * session in the body, no cookie.
 *
 * Deliberately not Origin-checked, unlike /auth/sign-in. That check stops another site
 * signing a visitor in by setting a cookie; this route sets none, and the API sends no
 * CORS headers, so another site's page cannot read the token it answers with.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
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

  const result = await signInNative(body.data);
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.session, { headers: { "cache-control": "no-store" } });
}
