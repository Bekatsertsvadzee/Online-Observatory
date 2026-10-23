import { zLeaveWaitlistPath } from "@darkview/contracts/zod";

import { leaveWaitlist } from "@/features/waitlist/waitlist";
import { requireApiMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { BOOKING_POLICY, meterRequest } from "@/lib/security/rate-limit";

/** DELETE /waitlist/{entryId} -- leave the line, or turn an offer down (ADR-068). */
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ entryId: string }> },
) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  const limited = await meterRequest({
    policy: BOOKING_POLICY,
    scope: "waitlist-leave",
    identity: guard.session.user.id,
    category: "BOOKING",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  const path = zLeaveWaitlistPath.safeParse(await context.params);
  if (!path.success) return apiError(404, "NOT_FOUND", "No such place.");

  const result = await leaveWaitlist({
    userId: guard.session.user.id,
    entryId: path.data.entryId,
    now: new Date(),
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return new Response(null, { status: 204 });
}
