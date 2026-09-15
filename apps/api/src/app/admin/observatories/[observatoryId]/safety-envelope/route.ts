import {
  zAdminGetSafetyEnvelopePath,
  zAdminSetSafetyEnvelopePath,
  zSafetyEnvelopeConfig,
} from "@darkview/contracts/zod";

import { setSafetyEnvelope } from "@/features/admin/safety-envelope";
import { requireOperator, requireOperatorMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { ADMIN_MUTATION_POLICY, meterRequest } from "@/lib/security/rate-limit";
import { loadSafetyEnvelope } from "@/lib/safety/store";

/**
 * The safety envelope for one observatory (ADR-019).
 *
 * `maxAltitudeDegrees` is the field that matters. While it is null the system is
 * UNMEASURED and every slew is refused by the cloud and, independently, by the
 * agent. That is the state the observatory ships in, and it is left to DV-034 to
 * end by physical measurement.
 */
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ observatoryId: string }> };

export async function GET(_request: Request, context: Context) {
  const guard = await requireOperator();
  if (!guard.ok) return guard.response;

  // An unknown observatory has no envelope, and is answered the same way.
  const path = zAdminGetSafetyEnvelopePath.safeParse(await context.params);
  const envelope = path.success ? await loadSafetyEnvelope(path.data.observatoryId) : null;
  if (!envelope) {
    return apiError(404, "NOT_FOUND", "No safety envelope has been recorded.");
  }

  return Response.json(envelope);
}

export async function PUT(request: Request, context: Context) {
  const guard = await requireOperatorMutation();
  if (!guard.ok) return guard.response;

  const path = zAdminSetSafetyEnvelopePath.safeParse(await context.params);
  if (!path.success) return apiError(404, "NOT_FOUND", "No such observatory.");

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return apiError(400, "BAD_REQUEST", "Body must be JSON.");
  }

  const parsed = zSafetyEnvelopeConfig.safeParse(payload);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_FAILED", "SafetyEnvelopeConfig is malformed.", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const limited = await meterRequest({
    policy: ADMIN_MUTATION_POLICY,
    scope: "admin-safety-envelope",
    identity: guard.session.user.id,
    category: "SAFETY",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  const result = await setSafetyEnvelope({
    observatoryId: path.data.observatoryId,
    envelope: parsed.data,
    actorUserId: guard.session.user.id,
  });
  if (!result.ok) {
    return apiError(result.status, result.code, result.message, result.details);
  }

  return Response.json(result.envelope);
}
