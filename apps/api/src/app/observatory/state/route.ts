import { readPublicObservatoryStatus } from "@/features/observatory/status";
import { apiError } from "@/lib/http/api-error";
import { currentObservatoryId } from "@/lib/http/current-observatory";

/**
 * GET /observatory/state -- the public status chip.
 *
 * The path names no observatory, so this reads the first-party one, as every
 * `/admin/observatory/*` route does. Issue #76 gives the whole group an id.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const observatoryId = await currentObservatoryId();
  const status = observatoryId ? await readPublicObservatoryStatus(observatoryId) : null;
  if (!status) return apiError(404, "NOT_FOUND", "No observatory is configured.");

  return Response.json(status);
}
