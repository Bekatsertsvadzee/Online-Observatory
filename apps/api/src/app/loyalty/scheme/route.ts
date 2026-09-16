import { readPublicLoyaltyScheme } from "@/features/loyalty/account";

/** GET /loyalty/scheme -- the club's rules, public (DV-090). */
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await readPublicLoyaltyScheme());
}
