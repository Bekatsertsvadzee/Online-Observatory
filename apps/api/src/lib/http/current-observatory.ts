import "server-only";

import { getDatabase } from "@/lib/db/client";

/**
 * The observatory the admin routes address.
 *
 * Phase 1 runs one, and the contract's admin paths carry no observatory id, so
 * every one of them means "the one we operate". The earliest row, the same way the
 * slot, target and safety-envelope routes already resolve it.
 *
 * When there is a second observatory this becomes a parameter and the contract
 * changes with it. Picking the earliest of several would be a coin toss over which
 * telescope an operator just switched to real hardware.
 */
export async function currentObservatoryId(): Promise<string | null> {
  const observatory = await getDatabase().observatory.findFirst({
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return observatory?.id ?? null;
}
