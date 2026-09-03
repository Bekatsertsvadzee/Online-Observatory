import { listSlotsForDate } from "@/features/booking/slots";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /slots?date=YYYY-MM-DD -- bookable slots for a local observatory date.
 *
 * Public: someone deciding whether to book should not have to sign up first.
 * Computed from astronomical darkness at request time.
 */
export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const date = new URL(request.url).searchParams.get("date");

  if (!date || !ISO_DATE.test(date)) {
    return apiError(422, "VALIDATION_FAILED", "`date` must be YYYY-MM-DD.");
  }

  // A syntactically valid string can still name a day that does not exist.
  const [year, month, day] = date.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return apiError(422, "VALIDATION_FAILED", `${date} is not a real date.`);
  }

  return Response.json(await listSlotsForDate(date, new Date()));
}
