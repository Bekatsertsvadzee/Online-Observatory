import { listObservatoriesForOperator } from "@/features/admin/observatories";
import { requireOperator } from "@/lib/auth/api-guard";

/**
 * GET /admin/observatories -- every observatory, for the operator console's picker
 * (ADR-074). Unlike GET /observatories this includes those no customer can book.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireOperator();
  if (!guard.ok) return guard.response;

  return Response.json(await listObservatoriesForOperator());
}
