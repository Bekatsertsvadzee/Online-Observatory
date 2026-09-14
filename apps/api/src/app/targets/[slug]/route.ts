import { zGetTargetPath } from "@darkview/contracts/zod";

import { getTargetBySlug } from "@/features/targets/catalogue";
import { apiError } from "@/lib/http/api-error";

/** GET /targets/{slug} -- one enabled catalogue target. Public by contract. */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  const path = zGetTargetPath.safeParse(await context.params);
  const target = path.success ? await getTargetBySlug(path.data.slug) : null;
  if (!target) return apiError(404, "NOT_FOUND", "No such target.");

  return Response.json(target);
}
