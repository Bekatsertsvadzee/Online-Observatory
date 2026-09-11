import { zListSlotsQuery } from "@darkview/contracts/zod";

import { listSlotsForDate } from "@/features/booking/slots";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /slots?observatoryId=...&date=YYYY-MM-DD -- bookable slots on one
 * observatory, for one of its local dates.
 *
 * Public: someone deciding whether to book should not have to sign up first.
 * Computed from astronomical darkness at request time.
 */
export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const observatoryId = params.get("observatoryId");
  const date = params.get("date");

  // Required since DV-066 (ADR-015). There is no list of "the slots" without an
  // instrument, and defaulting to one would be the findFirst this replaced.
  if (!zListSlotsQuery.shape.observatoryId.safeParse(observatoryId).success) {
    return apiError(422, "VALIDATION_FAILED", "`observatoryId` must be a UUID.");
  }

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

  const slots = await listSlotsForDate(observatoryId as string, date, new Date());

  // Unknown and not bookable are one answer. Whether a suspended partner node
  // exists is not something a caller may learn by probing ids.
  if (!slots) return apiError(404, "NOT_FOUND", "No such observatory.");

  return Response.json(slots);
}
