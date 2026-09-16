import { readLoyaltyAccount } from "@/features/loyalty/account";
import { requireApiSession } from "@/lib/auth/api-guard";

/** GET /loyalty -- the signed-in user's points, tier and referral code (DV-091). */
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  return Response.json(await readLoyaltyAccount(guard.session.user.id));
}
