import { zSubscribeBody } from "@darkview/contracts/zod";

import { readMySubscription, subscribe } from "@/features/subscriptions/subscriptions";
import { requireApiMutation, requireApiSession } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { meterRequest, SUBSCRIPTION_POLICY } from "@/lib/security/rate-limit";

/**
 * GET /subscription -- the signed-in user's subscription and remaining minutes.
 * POST /subscription -- subscribe to a plan (ADR-022).
 *
 * The price is Darkview's, read from the plan row; the body names only the plan.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  return Response.json(await readMySubscription(guard.session.user.id));
}

export async function POST(request: Request) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  const limited = await meterRequest({
    policy: SUBSCRIPTION_POLICY,
    scope: "subscription",
    identity: guard.session.user.id,
    category: "SUBSCRIPTION",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return apiError(400, "BAD_REQUEST", "Body must be JSON.");
  }

  const body = zSubscribeBody.safeParse(payload);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "SubscribeRequest is malformed.");
  }

  const result = await subscribe({
    userId: guard.session.user.id,
    request: body.data,
    now: new Date(),
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.body, { status: 201 });
}
