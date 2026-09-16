import { zRescheduleBookingBody, zRescheduleBookingPath } from "@darkview/contracts/zod";

import { rescheduleMyBooking } from "@/features/booking/entitlement";
import { requireApiMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { BOOKING_POLICY, meterRequest } from "@/lib/security/rate-limit";

/**
 * POST /bookings/{bookingId}/reschedule -- book a free replacement slot with the
 * entitlement a lost slot gave (DV-111).
 *
 * Metered like a reservation, which it is: it takes a slot out of everyone else's
 * reach.
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
    scope: "booking-reschedule",
    identity: guard.session.user.id,
    category: "BOOKING",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  const path = zRescheduleBookingPath.safeParse(await context.params);
  if (!path.success) return apiError(404, "NOT_FOUND", "No such booking.");

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return apiError(400, "BAD_REQUEST", "Body must be JSON.");
  }

  const body = zRescheduleBookingBody.safeParse(payload);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "RescheduleBookingRequest is malformed.");
  }

  const result = await rescheduleMyBooking({
    userId: guard.session.user.id,
    bookingId: path.data.bookingId,
    request: body.data,
    now: new Date(),
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.booking, { status: 201 });
}
