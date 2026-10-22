import { readCardDrawOdds } from "@/features/cards/draw";

export const dynamic = "force-dynamic";

/**
 * GET /card-draws/odds -- the weekly card draw's odds and rules (ADR-060).
 *
 * Public: the Terms publish them, and reading them needs no account.
 */
export async function GET() {
  return Response.json(await readCardDrawOdds());
}
