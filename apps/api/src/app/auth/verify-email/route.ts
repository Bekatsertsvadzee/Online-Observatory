import { zVerifyEmailBody } from "@darkview/contracts/zod";

import { verifyEmail } from "@/features/auth/authenticate";
import { confirmEmailChange } from "@/features/auth/profile";
import { crossOriginRefusal } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * POST /auth/verify-email -- ADR-016. Consumes the token from the link the web
 * client opened, ends every other session the user held, and signs them in. The link
 * may also be a change of address (ADR-042), which moves the account first.
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

  const body = zVerifyEmailBody.safeParse(payload);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "VerifyEmailRequest is malformed.");
  }

  const changed = await confirmEmailChange(body.data.token);
  if (changed) return Response.json(changed.user);

  const result = await verifyEmail(body.data);
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.user);
}
