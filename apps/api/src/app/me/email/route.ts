import { zChangeEmailBody } from "@darkview/contracts/zod";

import { requestEmailChange } from "@/features/auth/profile";
import { requireApiMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * POST /me/email -- ADR-042. 202 whether or not the new address holds an account.
 * Validation issues are reported by path only: the current password is in this body.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return apiError(400, "BAD_REQUEST", "Body must be JSON.");
  }

  const body = zChangeEmailBody.safeParse(payload);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "ChangeEmailRequest is malformed.", {
      fields: [...new Set(body.error.issues.map((issue) => issue.path.join(".")))],
    });
  }

  const result = await requestEmailChange(guard.session, body.data);
  if (!result.ok) {
    return apiError(result.status, result.code, result.message, result.details);
  }

  return new Response(null, { status: 202 });
}
