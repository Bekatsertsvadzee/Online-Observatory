import { zListSlotTargetsQuery } from "@darkview/contracts/zod";

import { listSlotTargets } from "@/features/targets/slot";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /targets/visibility?observatoryId=...&startAt=...&durationMinutes=... --
 * which targets one slot can deliver (#151).
 *
 * Public, like `GET /targets/tonight`, and computed at request time.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const parsed = zListSlotTargetsQuery.safeParse({
    observatoryId: params.get("observatoryId") ?? undefined,
    startAt: params.get("startAt") ?? undefined,
    durationMinutes: params.has("durationMinutes")
      ? Number(params.get("durationMinutes"))
      : undefined,
  });

  if (!parsed.success) {
    return apiError(
      422,
      "VALIDATION_FAILED",
      "`observatoryId` must be a UUID, `startAt` an RFC 3339 timestamp and " +
        "`durationMinutes` an integer from 1 to 240.",
    );
  }

  const { observatoryId, startAt, durationMinutes } = parsed.data;
  const list = await listSlotTargets(observatoryId, new Date(startAt), durationMinutes);

  if (!list) return apiError(404, "NOT_FOUND", "No such observatory.");

  return Response.json(list);
}
