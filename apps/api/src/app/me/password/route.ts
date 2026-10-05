import { zChangePasswordBody } from "@darkview/contracts/zod";

import { changePassword } from "@/features/auth/password";
import { requireApiMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * POST /me/password -- ADR-040. Ends every other session the user held; this one
 * stays. Validation issues are reported by path only: both passwords are in this body.
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

  const body = zChangePasswordBody.safeParse(payload);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "ChangePasswordRequest is malformed.", {
      fields: [...new Set(body.error.issues.map((issue) => issue.path.join(".")))],
    });
  }

  const result = await changePassword(guard.session, body.data);
  if (!result.ok) {
    return apiError(result.status, result.code, result.message, result.details);
  }

  return new Response(null, { status: 204 });
}
