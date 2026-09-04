import { zMissionId, zSubmitMissionCommandBody } from "@darkview/contracts/zod";

import {
  mintMissionCommand,
  rejectCloudMintedFields,
  rejectOperatorOnlyCommand,
} from "@/features/missions/command";
import { requireApiMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * POST /missions/{missionId}/command -- submit bounded intent.
 *
 * The order of the checks below is the point of this route. Both refusals happen
 * against the raw body, before the contract schema sees it:
 *
 *   a body carrying envelope fields is refused, not sanitised -- the generated
 *   Zod strips unknown keys (#15), and silently dropping a client's own sessionId
 *   would answer "accepted" to an attempt to command as somebody else;
 *
 *   a body naming GOTO, FOCUS, PARK or SET_PROFILE is refused as not permitted,
 *   rather than as an invalid enum value, because "you may not ask for that" and
 *   "that is not a word" are different answers and only one is true.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ missionId: string }> },
) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  const { missionId } = await context.params;
  if (!zMissionId.safeParse(missionId).success) {
    return apiError(404, "NOT_FOUND", "No such mission.");
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return apiError(400, "BAD_REQUEST", "Body must be JSON.");
  }

  const minted = rejectCloudMintedFields(raw);
  if (minted) return apiError(minted.status, minted.code, minted.message, minted.details);

  const forbidden = rejectOperatorOnlyCommand(raw);
  if (forbidden) {
    return apiError(
      forbidden.status,
      forbidden.code,
      forbidden.message,
      forbidden.details,
    );
  }

  const body = zSubmitMissionCommandBody.safeParse(raw);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "MissionCommandRequest is malformed.", {
      issues: body.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const result = await mintMissionCommand({
    missionId,
    request: body.data,
    actor: { id: guard.session.user.id, role: guard.session.user.role },
    now: new Date(),
  });

  if (!result.ok) {
    return apiError(result.status, result.code, result.message, result.details);
  }

  return Response.json(result.accepted, { status: 202 });
}
