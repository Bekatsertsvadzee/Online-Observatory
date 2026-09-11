import { zNetworkNodeApprovalStatus } from "@darkview/contracts/zod";

import { listNetworkNodes } from "@/features/admin/network";
import { pageLimitOf } from "@/features/audit/logs";
import { requireOperator } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /admin/network/nodes -- the qualification queue, and every node by status.
 *
 * DV-122. An unrecognised `approvalStatus` is refused rather than ignored: an
 * operator who asked for the review queue and was silently shown every node would
 * be told the wrong answer confidently.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = await requireOperator();
  if (!guard.ok) return guard.response;

  const query = new URL(request.url).searchParams;
  const raw = query.get("approvalStatus");

  const approvalStatus =
    raw === null ? undefined : zNetworkNodeApprovalStatus.safeParse(raw);
  if (approvalStatus && !approvalStatus.success) {
    return apiError(422, "VALIDATION_FAILED", `${raw} is not an approval status.`);
  }

  return Response.json(
    await listNetworkNodes({
      approvalStatus: approvalStatus?.data,
      cursor: query.get("cursor") ?? undefined,
      limit: pageLimitOf(query.get("limit")),
    }),
  );
}
