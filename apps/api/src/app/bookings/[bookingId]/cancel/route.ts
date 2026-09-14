import { zCancelBookingBody, zCancelBookingPath } from "@darkview/contracts/zod";

import { cancelMyBooking } from "@/features/booking/manage";
import { requireApiMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { BOOKING_POLICY, meterRequest } from "@/lib/security/rate-limit";

/**
 * POST /bookings/{bookingId}/cancel -- cancel an unpaid booking and release its
 * slot. A paid one is refused with 409 until refunds exist (see cancelMyBooking).
 *
 * Metered on its own scope under the booking policy: a reserve-and-cancel loop is
 * a way to churn the night's inventory, but a customer who has used their booking
 * budget must still be able to give a slot back.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ bookingId: string }> },
) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  const limited = await meterRequest({
    policy: BOOKING_POLICY,
    scope: "booking-cancel",
    identity: guard.session.user.id,
    category: "BOOKING",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  const path = zCancelBookingPath.safeParse(await context.params);
  if (!path.success) return apiError(404, "NOT_FOUND", "No such booking.");

  // The body is optional in the contract, so an empty one is a request with no
  // reason rather than malformed JSON.
  let payload: unknown = {};
  const raw = await request.text();
  if (raw.trim() !== "") {
    try {
      payload = JSON.parse(raw);
    } catch {
      return apiError(400, "BAD_REQUEST", "Body must be JSON.");
    }
  }

  const body = zCancelBookingBody.safeParse(payload);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "CancelBookingRequest is malformed.");
  }

  const result = await cancelMyBooking({
    userId: guard.session.user.id,
    bookingId: path.data.bookingId,
    reason: body.data?.reason,
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.booking);
}
