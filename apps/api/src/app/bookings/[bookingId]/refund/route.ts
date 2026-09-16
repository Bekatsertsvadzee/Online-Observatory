import { zRefundBookingPath } from "@darkview/contracts/zod";

import { refundMyBooking } from "@/features/booking/entitlement";
import { requireApiMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { BOOKING_POLICY, meterRequest } from "@/lib/security/rate-limit";

/**
 * POST /bookings/{bookingId}/refund -- take the refund a lost slot entitles the
 * customer to (DV-111).
 *
 * Metered on its own scope under the booking policy. It can only ever succeed once
 * per entitlement, so the meter protects the database, not the money.
 */
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ bookingId: string }> },
) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  const limited = await meterRequest({
    policy: BOOKING_POLICY,
    scope: "booking-refund",
    identity: guard.session.user.id,
    category: "BOOKING",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  const path = zRefundBookingPath.safeParse(await context.params);
  if (!path.success) return apiError(404, "NOT_FOUND", "No such booking.");

  const result = await refundMyBooking({
    userId: guard.session.user.id,
    bookingId: path.data.bookingId,
    now: new Date(),
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.booking);
}
