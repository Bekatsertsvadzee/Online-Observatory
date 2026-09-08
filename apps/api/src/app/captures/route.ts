import { pageLimitOf } from "@/features/audit/logs";
import { listCaptures } from "@/features/captures/collection";
import { requireApiSession } from "@/lib/auth/api-guard";

/**
 * GET /captures -- the signed-in user's Collection.
 *
 * No filter parameters, and none in the contract. The Collection is one person's
 * captures; a `userId` query parameter would be a way to ask for somebody else's,
 * and the answer would have to be no every time.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  const query = new URL(request.url).searchParams;

  return Response.json(
    await listCaptures({
      userId: guard.session.user.id,
      cursor: query.get("cursor") ?? undefined,
      limit: pageLimitOf(query.get("limit")),
    }),
  );
}
