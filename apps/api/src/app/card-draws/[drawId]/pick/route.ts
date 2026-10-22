import { zIdempotencyKey, zPickCardBody, zPickCardPath } from "@darkview/contracts/zod";

import { pickCard, type CardDrawRefusal } from "@/features/cards/draw";
import { requireApiMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

export const dynamic = "force-dynamic";

function refused(refusal: CardDrawRefusal) {
  switch (refusal.kind) {
    case "not-found":
      return apiError(404, "NOT_FOUND", "No such card draw.");
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
 * POST /card-draws/{drawId}/pick -- turn one card and win what it holds (ADR-060).
 *
 * Named by the deal's id rather than "the current week", so a pick sent a moment
 * before Monday midnight turns a card of the deal the customer was looking at, and
 * never deals and turns next week's in one go.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ drawId: string }> },
) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  const params = zPickCardPath.safeParse(await context.params);
  if (!params.success) return apiError(404, "NOT_FOUND", "No such card draw.");

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return apiError(400, "BAD_REQUEST", "Body must be JSON.");
  }
  const body = zPickCardBody.safeParse(payload);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "PickCardRequest is malformed.");
  }

  // As on POST /bookings: present but malformed is refused, never ignored.
  const header = request.headers.get("idempotency-key");
  if (header !== null && !zIdempotencyKey.safeParse(header).success) {
    return apiError(422, "VALIDATION_FAILED", "`Idempotency-Key` is malformed.");
  }

  const result = await pickCard({
    userId: guard.session.user.id,
    drawId: params.data.drawId,
    position: body.data.position,
    idempotencyKey: header,
    now: new Date(),
  });
  if (!result.ok) return refused(result.refusal);
  return Response.json(result.draw);
}
