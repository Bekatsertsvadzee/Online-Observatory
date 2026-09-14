import { zRegisterBody } from "@darkview/contracts/zod";

import { register } from "@/features/auth/authenticate";
import { crossOriginRefusal } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * POST /auth/register -- ADR-016. 202 whether or not the address already holds an
 * account, so the answer cannot be used to find out which addresses do.
 *
 * Validation issues are reported by path only. The password is in this body, and
 * an issue message can quote the value it rejected.
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

  const body = zRegisterBody.safeParse(payload);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "RegisterRequest is malformed.", {
      fields: [...new Set(body.error.issues.map((issue) => issue.path.join(".")))],
    });
  }

  const result = await register(body.data);
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return new Response(null, { status: 202 });
}
