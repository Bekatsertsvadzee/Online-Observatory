import { zGetCurrentCardDrawQuery } from "@darkview/contracts/zod";

import { readCurrentCardDraw, type CardDrawRefusal } from "@/features/cards/draw";
import { requireApiSession } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

export const dynamic = "force-dynamic";

function refused(refusal: CardDrawRefusal) {
  switch (refusal.kind) {
    case "not-found":
      return apiError(404, "NOT_FOUND", "No such observatory.");
    case "not-configured":
      return apiError(
        503,
        "INTERNAL",
        "The card draw is not available on this deployment.",
      );
    case "already-picked":
      return apiError(
        409,
        "CARD_ALREADY_PICKED",
        "A card has already been turned this week.",
      );
    case "closed":
      return apiError(
        409,
        "CARD_DRAW_CLOSED",
        "That week's cards can no longer be turned.",
      );
  }
}

/**
 * GET /card-draws/current?observatoryId= -- the caller's three cards for the week
 * (ADR-060), dealt on the week's first read.
 *
 * A session, not a mutation guard, although the first read writes: dealing is the
 * GET /loyalty pattern of creating the caller's own row on first sight. It issues
 * nothing and takes nothing, and the deal is the same whoever triggers it, so a
 * cross-site request can only deal the cards the account would be dealt anyway.
 * A session is a verified account; an unverified one never gets this far.
 */
export async function GET(request: Request) {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  const query = zGetCurrentCardDrawQuery.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!query.success) {
    return apiError(422, "VALIDATION_FAILED", "`observatoryId` must be a UUID.");
  }

  const result = await readCurrentCardDraw({
    userId: guard.session.user.id,
    observatoryId: query.data.observatoryId,
    now: new Date(),
  });
  if (!result.ok) return refused(result.refusal);
  return Response.json(result.draw);
}
