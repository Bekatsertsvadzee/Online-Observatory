import {
  zSetCaptureVisibilityBody,
  zSetCaptureVisibilityPath,
} from "@darkview/contracts/zod";

import { getCapture, setCaptureVisibility } from "@/features/captures/collection";
import { requireApiMutation, requireApiSession } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { CAPTURE_VISIBILITY_POLICY, meterRequest } from "@/lib/security/rate-limit";

/**
 * GET /captures/{captureId} -- one capture the caller owns.
 *
 * A capture belonging to somebody else answers 404, identically to one that does
 * not exist. Anything more specific would confirm the id is real to whoever is
 * guessing at ids.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ captureId: string }> },
) {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  const { captureId } = await context.params;

  const capture = await getCapture({
    userId: guard.session.user.id,
    captureId,
    now: new Date(),
  });

  if (!capture) return apiError(404, "NOT_FOUND", "No such capture.");

  return Response.json(capture);
}

/**
 * PATCH /captures/{captureId} -- the owner publishes a capture to the gallery or
 * takes it back (#144). Same 404 rule as GET; 409 for GALLERY on a SIMULATED
 * capture; idempotent. See setCaptureVisibility.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ captureId: string }> },
) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  const limited = await meterRequest({
    policy: CAPTURE_VISIBILITY_POLICY,
    scope: "capture-visibility",
    identity: guard.session.user.id,
    category: "MISSION",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  const path = zSetCaptureVisibilityPath.safeParse(await context.params);
  if (!path.success) return apiError(404, "NOT_FOUND", "No such capture.");

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return apiError(400, "BAD_REQUEST", "Body must be JSON.");
  }

  const body = zSetCaptureVisibilityBody.safeParse(payload);
  if (!body.success) {
    return apiError(
      422,
      "VALIDATION_FAILED",
      "SetCaptureVisibilityRequest is malformed.",
    );
  }

  const result = await setCaptureVisibility({
    userId: guard.session.user.id,
    captureId: path.data.captureId,
    visibility: body.data.visibility,
    now: new Date(),
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.capture);
}
