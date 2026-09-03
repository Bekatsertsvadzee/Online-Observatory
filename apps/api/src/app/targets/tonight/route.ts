import { listTonightTargets } from "@/features/targets/tonight";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /targets/tonight -- the catalogue filtered by live ephemeris.
 *
 * Public: choosing what to look at does not require an account. Computed at
 * request time, never served from a static list, and never cached.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("at");
  const at = requested ? new Date(requested) : new Date();

  if (Number.isNaN(at.getTime())) {
    return apiError(422, "VALIDATION_FAILED", "`at` must be an RFC 3339 timestamp.");
  }

  return Response.json(await listTonightTargets(at));
}
