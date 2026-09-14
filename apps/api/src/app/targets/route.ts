import { pageLimitOf } from "@/features/audit/logs";
import { listTargets } from "@/features/targets/catalogue";

/**
 * GET /targets -- the operator-approved catalogue. Public by contract: choosing
 * what to look at does not require an account.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;

  return Response.json(
    await listTargets({
      cursor: query.get("cursor") ?? undefined,
      limit: pageLimitOf(query.get("limit")),
    }),
  );
}
