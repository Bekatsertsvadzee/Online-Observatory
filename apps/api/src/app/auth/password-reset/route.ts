import { zRequestPasswordResetBody } from "@darkview/contracts/zod";

import { requestPasswordReset } from "@/features/auth/password";
import { crossOriginRefusal } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * POST /auth/password-reset -- ADR-040. 202 whether or not the address holds an
 * account, so the answer cannot be used to find out which addresses do.
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

  const body = zRequestPasswordResetBody.safeParse(payload);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "PasswordResetRequest is malformed.");
  }

  const result = await requestPasswordReset(body.data);
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return new Response(null, { status: 202 });
}
