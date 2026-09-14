import "server-only";

import type { Target, TargetPage } from "@darkview/contracts";

import { getDatabase } from "@/lib/db/client";
import { toContractTarget, type TargetRow } from "@/features/targets/projection";

/**
 * The operator-approved catalogue: every enabled target, in slug order.
 *
 * `enabled: false` is the operator's kill switch for a target that does not work
 * through this instrument, so a disabled target is not in the catalogue and not
 * readable by slug either -- a customer who kept a link to it gets 404, the same
 * as for a slug that never existed.
 *
 * `/targets/tonight` is the other reading of this table and lists disabled targets
 * too, with the reason each is not offered. This one answers "what can I look
 * at", not "why not".
 */
export async function listTargets(input: { cursor?: string; limit: number }): Promise<TargetPage> {
  const rows = await getDatabase().target.findMany({
    where: { enabled: true },
    // Slug is unique, so it orders completely and the keyset cursor cannot skip.
    orderBy: { slug: "asc" },
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });

  const items = rows.slice(0, input.limit);
  const hasMore = rows.length > input.limit;

  return {
    items: items.map((row) => toContractTarget(row as unknown as TargetRow)),
    page: { hasMore, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null },
  };
}

export async function getTargetBySlug(slug: string): Promise<Target | null> {
  const row = await getDatabase().target.findFirst({ where: { slug, enabled: true } });
  return row ? toContractTarget(row as unknown as TargetRow) : null;
}
