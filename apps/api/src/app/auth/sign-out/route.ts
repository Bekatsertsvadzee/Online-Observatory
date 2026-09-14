import { requireApiMutation } from "@/lib/auth/api-guard";
import { recordAuthEvent } from "@/lib/auth/audit";
import { deleteCurrentSession } from "@/lib/auth/session";

/**
 * POST /auth/sign-out -- ADR-016. Deletes the session row, not only the cookies:
 * a copied cookie must stop working the moment its owner signs out.
 */
export const dynamic = "force-dynamic";

export async function POST() {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  await deleteCurrentSession();
  await recordAuthEvent("LOGGED_OUT", { userId: guard.session.user.id });
  return new Response(null, { status: 204 });
}
