import { zConfirmPasswordResetBody } from "@darkview/contracts/zod";

import { confirmPasswordReset } from "@/features/auth/password";
import { crossOriginRefusal } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * POST /auth/password-reset/confirm -- ADR-040. Consumes the token from the link the
 * web client opened, sets the password, ends every session the user held, and signs
 * them in.
 *
 * Validation issues are reported by path only: the password is in this body.
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

  const body = zConfirmPasswordResetBody.safeParse(payload);
  if (!body.success) {
    return apiError(
      422,
      "VALIDATION_FAILED",
      "PasswordResetConfirmRequest is malformed.",
      {
        fields: [...new Set(body.error.issues.map((issue) => issue.path.join(".")))],
      },
    );
  }

  const result = await confirmPasswordReset(body.data);
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.user);
}
