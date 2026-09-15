import { zAdminGetObservatoryStatePath } from "@darkview/contracts/zod";

import { readOperatorObservatoryState } from "@/features/admin/observatory-state";
import { requireOperator } from "@/lib/auth/api-guard";
import { getDatabase } from "@/lib/db/client";
import { apiError } from "@/lib/http/api-error";
import { getServerEnvironment } from "@/lib/validation/env";

/**
 * GET /admin/observatories/{observatoryId}/state -- live operator telemetry (ADR-017).
 *
 * Any observatory that exists, bookable or not (ADR-019). Checked here because the
 * reader answers an unknown id with SAFETY_NOT_CONFIGURED, which would tell an
 * operator a real observatory is misconfigured when it is simply not there.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ observatoryId: string }> },
) {
  const guard = await requireOperator();
  if (!guard.ok) return guard.response;

  const path = zAdminGetObservatoryStatePath.safeParse(await context.params);
  const observatory = path.success
    ? await getDatabase().observatory.findUnique({
        where: { id: path.data.observatoryId },
        select: { id: true },
      })
    : null;
  if (!observatory) return apiError(404, "NOT_FOUND", "No such observatory.");

  const { REALTIME_INTERNAL_URL, REALTIME_INTERNAL_SECRET } = getServerEnvironment();
  const result = await readOperatorObservatoryState({
    observatoryId: observatory.id,
    realtime: { url: REALTIME_INTERNAL_URL, secret: REALTIME_INTERNAL_SECRET },
    now: new Date(),
  });

  if (!result.ok) return apiError(result.status, result.code, result.message);
  return Response.json(result.state);
}
