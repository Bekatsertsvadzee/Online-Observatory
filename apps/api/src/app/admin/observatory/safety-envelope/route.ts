import { zSafetyEnvelopeConfig } from "@darkview/contracts/zod";

import { setSafetyEnvelope } from "@/features/admin/safety-envelope";
import { requireOperator, requireOperatorMutation } from "@/lib/auth/api-guard";
import { getDatabase } from "@/lib/db/client";
import { apiError } from "@/lib/http/api-error";
import { loadSafetyEnvelope } from "@/lib/safety/store";

/**
 * The safety envelope for the observatory.
 *
 * Phase 1 runs one observatory, so this addresses it the same way the slot and
 * target routes do -- the earliest one -- rather than inventing an id parameter
 * the contract does not have.
 *
 * `maxAltitudeDegrees` is the field that matters. While it is null the system is
 * UNMEASURED and every slew is refused by the cloud and, independently, by the
 * agent. That is the state the observatory ships in, and it is left to DV-034 to
 * end by physical measurement.
 */
export const dynamic = "force-dynamic";

async function currentObservatoryId(): Promise<string | null> {
  const observatory = await getDatabase().observatory.findFirst({
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return observatory?.id ?? null;
}

export async function GET() {
  const guard = await requireOperator();
  if (!guard.ok) return guard.response;

  const observatoryId = await currentObservatoryId();
  if (!observatoryId) {
    return apiError(404, "NOT_FOUND", "No observatory is configured.");
  }

  const envelope = await loadSafetyEnvelope(observatoryId);
  if (!envelope) {
    return apiError(404, "NOT_FOUND", "No safety envelope has been recorded.");
  }

  return Response.json(envelope);
}

export async function PUT(request: Request) {
  const guard = await requireOperatorMutation();
  if (!guard.ok) return guard.response;

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

  const observatoryId = await currentObservatoryId();
  if (!observatoryId) {
    return apiError(404, "NOT_FOUND", "No observatory is configured.");
  }

  const result = await setSafetyEnvelope({ observatoryId, envelope: parsed.data });
  if (!result.ok) {
    return apiError(result.status, result.code, result.message, result.details);
  }

  return Response.json(result.envelope);
}
