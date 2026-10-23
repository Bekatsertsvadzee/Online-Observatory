import { readTonight } from "@/features/missions/broadcast";

/**
 * GET /tonight -- the session open to anyone right now, or none (clients ADR-066).
 * Public; it names the target and never a person.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await readTonight(), { headers: { "cache-control": "no-store" } });
}
