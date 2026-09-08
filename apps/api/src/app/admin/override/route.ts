import { zOperatorOverrideRequest } from "@darkview/contracts/zod";

import {
  issueOperatorOverride,
  overrideIsExemptFromMetering,
} from "@/features/admin/override";
import { requireOperatorMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { meterRequest, OPERATOR_OVERRIDE_POLICY } from "@/lib/security/rate-limit";

/**
 * POST /admin/override -- operator manual control, including the emergency Park.
 *
 * 202, not 200. The cloud minted the envelope and rang the relay's bell; the
 * telescope has not been asked yet, let alone obeyed. The agent validates the
 * envelope again independently and its verdict arrives later on the mission
 * channel. Answering 200 here would tell an operator the mount had done something.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requireOperatorMutation();
  if (!guard.ok) return guard.response;

  const parsed = zOperatorOverrideRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      422,
      "VALIDATION_FAILED",
      "An override needs a command type, a payload and a reason of at least eight characters.",
    );
  }

  // A stolen operator session is metered; an emergency stop is not. The exemption
  // is decided by `overrideIsExemptFromMetering`, which lives next to the list of
  // recovery commands so the two cannot drift apart.
  if (!overrideIsExemptFromMetering(parsed.data)) {
    const limited = await meterRequest({
      policy: OPERATOR_OVERRIDE_POLICY,
      scope: "operator-override",
      identity: guard.session.user.id,
      category: "OPERATOR_OVERRIDE",
      actorUserId: guard.session.user.id,
      missionId: parsed.data.missionId ?? null,
    });
    if (limited) return limited;
  }

  const result = await issueOperatorOverride({
    request: parsed.data,
    operator: { id: guard.session.user.id },
    now: new Date(),
  });

  if (!result.ok) {
    return apiError(result.status, result.code, result.message, result.details);
  }

  return Response.json(result.accepted, { status: 202 });
}
