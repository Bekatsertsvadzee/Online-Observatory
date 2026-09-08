import { zMissionId } from "@darkview/contracts/zod";

import {
  listMissionObservers,
  releaseObserverSeat,
} from "@/features/missions/observers";
import { requireApiMutation, requireApiSession } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { meterRequest, OBSERVER_SEAT_POLICY } from "@/lib/security/rate-limit";

/**
 * Observer seats on a live mission (ADR-007).
 *
 * POST is the customer-facing join, and it does not work yet -- see
 * `refuseUntilObserverPaymentExists`. The seat model behind it is complete and
 * tested; what is missing is the only thing that makes a seat legitimate.
 */
export const dynamic = "force-dynamic";

/**
 * A seat requires a settled Observer Pack payment, and nothing can settle one.
 *
 * DV-102 owns Observer Pack payment and lands with DV-056. Until it does there is
 * no such thing as a settled payment, so this route refuses rather than handing
 * out free seats -- the same choice DV-040 made for CAPTURE, FOCUS and
 * SET_PROFILE: a command nothing performs must not be answered ACCEPTED, and a
 * paid seat nobody paid for must not be answered 201.
 *
 * `takeObserverSeat` is deliberately not imported here. It is complete and tested,
 * and reachable by operators, tests and DV-103's channel work; what must not exist
 * is a path where a customer gets a seat for nothing. DV-102 imports it.
 */
function refuseUntilObserverPaymentExists() {
  return apiError(
    402,
    "PAYMENT_REQUIRED",
    "An Observer Pack seat requires a settled payment, and Observer Pack payment " +
      "is not built yet (DV-102).",
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ missionId: string }> },
) {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  const { missionId } = await context.params;
  if (!zMissionId.safeParse(missionId).success) {
    return apiError(404, "NOT_FOUND", "No such mission.");
  }

  const result = await listMissionObservers({
    missionId,
    actor: { id: guard.session.user.id, role: guard.session.user.role },
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.value);
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ missionId: string }> },
) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  const { missionId } = await context.params;
  if (!zMissionId.safeParse(missionId).success) {
    return apiError(404, "NOT_FOUND", "No such mission.");
  }

  return refuseUntilObserverPaymentExists();
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ missionId: string }> },
) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  const { missionId } = await context.params;
  if (!zMissionId.safeParse(missionId).success) {
    return apiError(404, "NOT_FOUND", "No such mission.");
  }

  // Metered, even though leaving is always allowed. ADR-007 caps a mission at
  // five seats; taking and releasing in a loop is how you would hold that cap
  // against other people without ever exceeding it.
  const limited = await meterRequest({
    policy: OBSERVER_SEAT_POLICY,
    scope: "observer-seat",
    identity: guard.session.user.id,
    category: "MISSION",
    actorUserId: guard.session.user.id,
    missionId,
  });
  if (limited) return limited;

  // Leaving is not gated on payment. Somebody holding a seat must always be able
  // to give it back, whatever the state of the thing that granted it.
  const result = await releaseObserverSeat({
    missionId,
    userId: guard.session.user.id,
    now: new Date(),
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return new Response(null, { status: 204 });
}
