import { pageLimitOf } from "@/features/audit/logs";
import { listMyMissions } from "@/features/missions/mine";
import { requireApiSession } from "@/lib/auth/api-guard";

/**
 * GET /missions -- the signed-in user's upcoming and past missions. No `userId`
 * parameter, for the reason `GET /captures` has none.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  const query = new URL(request.url).searchParams;

  return Response.json(
    await listMyMissions({
      userId: guard.session.user.id,
      cursor: query.get("cursor") ?? undefined,
      limit: pageLimitOf(query.get("limit")),
    }),
  );
}
