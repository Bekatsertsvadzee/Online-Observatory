import { zRegisterNetworkNodeRequest } from "@darkview/contracts/zod";

import { listMyNetworkNodes, registerNetworkNode } from "@/features/network/nodes";
import { requireApiMutation, requireApiSession } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { ADMIN_MUTATION_POLICY, meterRequest } from "@/lib/security/rate-limit";

/**
 * Partner observatories the caller owns (ADR-013).
 *
 * Registration creates a site, an instrument and a node in DRAFT. DRAFT refuses
 * everything, so this endpoint hands out nothing but a row to fill in.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  return Response.json({ items: await listMyNetworkNodes(guard.session.user.id) });
}

export async function POST(request: Request) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  // Metered: registration writes an Observatory, a Telescope and a node, so an
  // unmetered loop here fills the operator's review queue with sites nobody owns.
  const limited = await meterRequest({
    policy: ADMIN_MUTATION_POLICY,
    scope: "network-node-register",
    identity: guard.session.user.id,
    category: "OBSERVATORY_MODE",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  const body = zRegisterNetworkNodeRequest.safeParse(
    await request.json().catch(() => null),
  );
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "RegisterNetworkNodeRequest is malformed.", {
      issues: body.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const result = await registerNetworkNode({
    ownerId: guard.session.user.id,
    request: body.data,
    now: new Date(),
  });

  return Response.json(result.node, { status: 201 });
}
