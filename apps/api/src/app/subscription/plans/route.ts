import { readSubscriptionPlans } from "@/features/subscriptions/subscriptions";

/** GET /subscription/plans -- the plans on sale, public (ADR-022). */
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await readSubscriptionPlans());
}
