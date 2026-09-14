import { zGetBookingPath } from "@darkview/contracts/zod";

import { getMyBooking } from "@/features/booking/manage";
import { requireApiSession } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /bookings/{bookingId} -- one booking the caller owns. Somebody else's and a
 * malformed id both answer 404.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ bookingId: string }> },
) {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  const path = zGetBookingPath.safeParse(await context.params);
  const booking = path.success
    ? await getMyBooking({ userId: guard.session.user.id, bookingId: path.data.bookingId })
    : null;
  if (!booking) return apiError(404, "NOT_FOUND", "No such booking.");

  return Response.json(booking);
}
