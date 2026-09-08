import { zCreateBookingBody, zIdempotencyKey } from "@darkview/contracts/zod";

import { reserveSlot } from "@/features/booking/reserve";
import { requireApiMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { BOOKING_POLICY, meterRequest } from "@/lib/security/rate-limit";

/**
 * POST /bookings -- reserve a slot and open a payment intent.
 *
 * Not public: choosing what to look at does not need an account, but taking a
 * half hour of the telescope out of everyone else's reach does.
 *
 * Price and duration are read from the generated slot, never from the request.
 * A client that could name its own price would be a client that could set it.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  // Metered before the body is even read. A reservation takes a half hour of the
  // only telescope out of everyone else's reach, so this is the one customer
  // action that can deny the whole night's inventory to everyone else.
  const limited = await meterRequest({
    policy: BOOKING_POLICY,
    scope: "booking",
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

  const body = zCreateBookingBody.safeParse(payload);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "CreateBookingRequest is malformed.", {
      issues: body.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  // Absent is fine -- the key is optional in the contract. Present but malformed
  // is not: silently ignoring it would turn a retry into a second booking, which
  // is the exact failure the header exists to prevent.
  const header = request.headers.get("idempotency-key");
  if (header !== null && !zIdempotencyKey.safeParse(header).success) {
    return apiError(422, "VALIDATION_FAILED", "`Idempotency-Key` is malformed.");
  }

  const result = await reserveSlot({
    userId: guard.session.user.id,
    request: body.data,
    idempotencyKey: header,
    now: new Date(),
  });

  if (!result.ok) {
    return apiError(result.status, result.code, result.message);
  }

  return Response.json(result.body, { status: 201 });
}
