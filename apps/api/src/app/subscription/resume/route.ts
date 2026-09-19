import { resumeMySubscription } from "@/features/subscriptions/subscriptions";
import { requireApiMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { meterRequest, SUBSCRIPTION_POLICY } from "@/lib/security/rate-limit";

/** POST /subscription/resume (ADR-022 section 9). Idempotent. */
export const dynamic = "force-dynamic";

export async function POST() {
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

  const result = await resumeMySubscription({ userId: guard.session.user.id });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.body);
}
