import { requireApiSession } from "@/lib/auth/api-guard";
import { toContractUser } from "@/features/identity/user";

/**
 * GET /me -- the signed-in user, in the contract's User shape.
 *
 * 401 without a session. The response body is built by toContractUser so that the
 * projection is testable on its own and cannot drift per route.
 */
export async function GET() {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  return Response.json(toContractUser(guard.session.user));
}
