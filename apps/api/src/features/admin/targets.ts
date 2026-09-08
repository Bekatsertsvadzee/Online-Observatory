import "server-only";

import type {
  AdminUpdateTargetRequest,
  ErrorCode,
  Target as ContractTarget,
} from "@darkview/contracts";
import { recordAuditEvent } from "@darkview/db/audit";

import { getDatabase } from "@/lib/db/client";
import { toContractTarget, type TargetRow } from "@/features/targets/projection";

export type TargetFailure = {
  ok: false;
  status: 404 | 422;
  code: ErrorCode;
  message: string;
};

export type TargetResult = { ok: true; target: ContractTarget } | TargetFailure;

/**
 * Enable, disable or tune one catalogue target.
 *
 * A partial update: every field is optional and only the ones present are written.
 * That matters more than usual here, because a full replace would let an operator
 * changing `enabled` silently reset the imaging profile beside it to whatever their
 * client last read.
 *
 * `enabled: false` is the operator's kill switch for a target that turns out not to
 * work through this instrument -- too faint, too large for the field, or ruined by
 * a rooftop obstruction the compass survey did not catch. It removes the target
 * from what can be booked. It does not touch a mission already running against it:
 * ending one of those is a cancellation, and that is a different, audited call.
 *
 * `previewImageUrl` is settable and deserves a warning it cannot enforce. The
 * schema's own words are that it must be "an image this telescope actually
 * produced... never a stock image and never output from another instrument". No
 * code here can tell the difference. The audit row records who set it, which is the
 * only check that exists.
 */
export async function updateTargetAsOperator(input: {
  targetId: string;
  request: AdminUpdateTargetRequest;
  operatorId: string;
}): Promise<TargetResult> {
  const { targetId, request, operatorId } = input;

  // An empty body writes nothing and would still return 200 with an audit row
  // saying an operator changed nothing. Refused so the log stays a record of
  // changes rather than of requests.
  if (Object.keys(request).length === 0) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      message: "Name at least one field to change.",
    };
  }

  const database = getDatabase();

  return database.$transaction(async (tx) => {
    const before = await tx.target.findUnique({ where: { id: targetId } });
    if (!before) {
      return { ok: false, status: 404, code: "NOT_FOUND", message: "No such target." };
    }

    const row = await tx.target.update({
      where: { id: targetId },
      // Spread of the request itself, which is safe only because the generated
      // schema rejects an undeclared property outright. Without that this would be
      // a mass-assignment: a body carrying `slug` or `positionSource` would rewrite
      // the identity of a catalogue entry through an endpoint that exists to tune
      // one.
      data: { ...request },
    });

    await recordAuditEvent(
      {
        category: "MISSION",
        action: "OPERATOR_TARGET_UPDATED",
        actorUserId: operatorId,
        entityType: "Target",
        entityId: targetId,
        // Both sides of every field that moved, and only the ones that moved. A
        // row saying "enabled was set to false" is worth less than one saying it
        // was true before.
        detail: { changed: changesBetween(before, request) },
        isDemo: before.isDemo,
      },
      tx,
    );

    return { ok: true, target: toContractTarget(row as unknown as TargetRow) };
  });
}

/** The fields the request actually moves, each with its previous value. */
function changesBetween(
  before: Record<string, unknown>,
  request: AdminUpdateTargetRequest,
): Record<string, { from: unknown; to: unknown }> {
  const changed: Record<string, { from: unknown; to: unknown }> = {};

  for (const [field, to] of Object.entries(request)) {
    const from = before[field] ?? null;
    if (from === to) continue;
    changed[field] = { from, to };
  }

  return changed;
}
