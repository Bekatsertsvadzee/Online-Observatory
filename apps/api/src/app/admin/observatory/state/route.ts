import { readOperatorObservatoryState } from "@/features/admin/observatory-state";
import { requireOperator } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { currentObservatoryId } from "@/lib/http/current-observatory";
import { getServerEnvironment } from "@/lib/validation/env";

/**
 * GET /admin/observatory/state -- live operator telemetry (ADR-017).
 *
 * The first-party observatory, as every `/admin/observatory/*` route resolves it
 * until issue #76 gives the group an id.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireOperator();
  if (!guard.ok) return guard.response;

  const observatoryId = await currentObservatoryId();
  if (!observatoryId) {
    return apiError(404, "NOT_FOUND", "No observatory is configured.");
  }

  const { REALTIME_INTERNAL_URL, REALTIME_INTERNAL_SECRET } = getServerEnvironment();
  const result = await readOperatorObservatoryState({
    observatoryId,
    realtime: { url: REALTIME_INTERNAL_URL, secret: REALTIME_INTERNAL_SECRET },
    now: new Date(),
  });

  if (!result.ok) return apiError(result.status, result.code, result.message);
  return Response.json(result.state);
}
