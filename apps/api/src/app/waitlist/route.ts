import { zJoinWaitlistBody } from "@darkview/contracts/zod";

import { joinWaitlist, listMyWaitlistEntries } from "@/features/waitlist/waitlist";
import { requireApiMutation, requireApiSession } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { BOOKING_POLICY, meterRequest } from "@/lib/security/rate-limit";

/**
 * GET /waitlist -- the caller's places, newest first.
 * POST /waitlist -- wait for a slot somebody else holds (clients ADR-068).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  return Response.json(await listMyWaitlistEntries(guard.session.user.id, new Date()));
}

export async function POST(request: Request) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  const limited = await meterRequest({
    policy: BOOKING_POLICY,
    scope: "waitlist-join",
    identity: guard.session.user.id,
    category: "BOOKING",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return apiError(400, "BAD_REQUEST", "Body must be JSON.");
  }

  const body = zJoinWaitlistBody.safeParse(payload);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "JoinWaitlistRequest is malformed.");
  }

  const result = await joinWaitlist({
    userId: guard.session.user.id,
    request: body.data,
    now: new Date(),
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.body, { status: 201 });
}
