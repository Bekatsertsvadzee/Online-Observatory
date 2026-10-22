import { listMyCardPrizes } from "@/features/cards/draw";
import { requireApiSession } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

export const dynamic = "force-dynamic";

/** GET /prizes -- the card-draw prizes the signed-in account has won (ADR-060). */
export async function GET() {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  const prizes = await listMyCardPrizes(guard.session.user.id, new Date());
  if (!prizes) {
    return apiError(
      503,
      "INTERNAL",
      "The card draw is not available on this deployment.",
    );
  }
  return Response.json(prizes);
}
