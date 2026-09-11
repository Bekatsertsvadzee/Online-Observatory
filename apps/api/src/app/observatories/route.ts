import { listBookableObservatories } from "@/features/booking/observatories";

/**
 * GET /observatories -- the telescopes a customer may book (ADR-015).
 *
 * Public, for the same reason GET /slots is: choosing a telescope should not need
 * an account. Read at request time, so a node an operator suspends leaves this list
 * on the next request rather than on the next deploy.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await listBookableObservatories());
}
