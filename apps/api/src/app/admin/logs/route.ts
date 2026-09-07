import { zAuditCategory } from "@darkview/contracts/zod";

import { listAuditEvents, pageLimitOf } from "@/features/audit/logs";
import { requireOperator } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /admin/logs -- the correlated audit event stream.
 *
 * Operator-only, and a read, so `requireOperator` rather than the mutation guard.
 *
 * An unrecognised `category` is a 422 rather than a filter that quietly matches
 * nothing. During an incident the difference between "there are no SAFETY rows"
 * and "you typed SAFTEY" is the difference between two very different nights.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = await requireOperator();
  if (!guard.ok) return guard.response;

  const query = new URL(request.url).searchParams;

  // Validated against the contract's enum, not the database's. The two agree --
  // `enum-parity.test.ts` is what keeps them agreeing -- but only one of them is
  // the definition of what may cross this boundary.
  const raw = query.get("category");
  const category = raw === null ? undefined : zAuditCategory.safeParse(raw);
  if (category && !category.success) {
    return apiError(422, "VALIDATION_FAILED", "Unknown audit category.", {
      category: raw,
      known: zAuditCategory.options,
    });
  }

  const page = await listAuditEvents({
    missionId: query.get("missionId") ?? undefined,
    category: category?.data,
    cursor: query.get("cursor") ?? undefined,
    limit: pageLimitOf(query.get("limit")),
  });

  return Response.json(page);
}
