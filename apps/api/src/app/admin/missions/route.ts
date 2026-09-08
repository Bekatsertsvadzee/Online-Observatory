import { zMissionState } from "@darkview/contracts/zod";

import { listAllMissions } from "@/features/admin/missions";
import { pageLimitOf } from "@/features/audit/logs";
import { requireOperator } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /admin/missions -- every mission, for operations and support.
 *
 * Unscoped by user, which is what makes it an admin route. An unrecognised `state`
 * is refused rather than ignored: silently returning everything to an operator who
 * asked for the failures would be the wrong answer told confidently.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = await requireOperator();
  if (!guard.ok) return guard.response;

  const query = new URL(request.url).searchParams;
  const rawState = query.get("state");

  const state = rawState === null ? undefined : zMissionState.safeParse(rawState);
  if (state && !state.success) {
    return apiError(422, "VALIDATION_FAILED", `${rawState} is not a mission state.`);
  }

  return Response.json(
    await listAllMissions({
      state: state?.data,
      cursor: query.get("cursor") ?? undefined,
      limit: pageLimitOf(query.get("limit")),
    }),
  );
}
