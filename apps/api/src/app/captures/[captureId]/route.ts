import { getCapture } from "@/features/captures/collection";
import { requireApiSession } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

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
