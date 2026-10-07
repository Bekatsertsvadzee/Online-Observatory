import { zDeleteAccountBody, zUpdateProfileBody } from "@darkview/contracts/zod";

import { deleteAccount } from "@/features/auth/deletion";
import { updateProfile } from "@/features/auth/profile";
import { toContractUser } from "@/features/identity/user";
import { requireApiMutation, requireApiSession } from "@/lib/auth/api-guard";
import { deleteCurrentSession } from "@/lib/auth/session";
import { apiError } from "@/lib/http/api-error";
import { meterRequest, PROFILE_POLICY } from "@/lib/security/rate-limit";

/**
 * GET /me -- the signed-in user, in the contract's User shape.
 *
 * 401 without a session. The response body is built by toContractUser so that the
 * projection is testable on its own and cannot drift per route.
 */
export async function GET() {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  return Response.json(toContractUser(guard.session.user));
}

/** PATCH /me -- ADR-042. The name and the language the platform writes in. */
export async function PATCH(request: Request) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  const limited = await meterRequest({
    policy: PROFILE_POLICY,
    scope: "profile",
    identity: guard.session.user.id,
    category: "AUTH",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return apiError(400, "BAD_REQUEST", "Body must be JSON.");
  }

  const body = zUpdateProfileBody.safeParse(payload);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "UpdateProfileRequest is malformed.", {
      fields: [...new Set(body.error.issues.map((issue) => issue.path.join(".")))],
    });
  }
  // The contract's minProperties, which the generated validator does not carry.
  if (body.data.displayName === undefined && body.data.locale === undefined) {
    return apiError(
      422,
      "VALIDATION_FAILED",
      "Name at least one of displayName and locale.",
    );
  }

  const result = await updateProfile(guard.session, body.data);
  if (!result.ok) {
    return apiError(result.status, result.code, result.message, result.details);
  }

  return Response.json(result.user);
}

/**
 * DELETE /me -- ADR-044. 204 and the cookies cleared, as signing out does; 409 with
 * `details.blockers` while something is unsettled. Validation issues are reported by
 * path only: the current password is in this body.
 */
export async function DELETE(request: Request) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return apiError(400, "BAD_REQUEST", "Body must be JSON.");
  }

  const body = zDeleteAccountBody.safeParse(payload);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "DeleteAccountRequest is malformed.", {
      fields: [...new Set(body.error.issues.map((issue) => issue.path.join(".")))],
    });
  }

  const result = await deleteAccount(guard.session, body.data);
  if (!result.ok) {
    return apiError(result.status, result.code, result.message, result.details);
  }

  // Every session row is already gone; this clears the cookies that named one.
  await deleteCurrentSession();
  return new Response(null, { status: 204 });
}
