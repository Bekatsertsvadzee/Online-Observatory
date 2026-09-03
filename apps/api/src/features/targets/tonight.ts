import "server-only";

import type { TonightTargetList } from "@darkview/contracts";

import { getDatabase } from "@/lib/db/client";
import { evaluateVisibility } from "@/lib/ephemeris/visibility";
import { toContractTarget, type TargetRow } from "@/features/targets/projection";

/**
 * The catalogue with tonight's assessment attached.
 *
 * Every catalogue target appears, observable or not, each carrying the reasons it
 * is not offered. A list that silently omitted blocked targets would leave a
 * customer wondering where Saturn went, and an operator with nothing to read.
 */
export async function listTonightTargets(at: Date): Promise<TonightTargetList> {
  const database = getDatabase();

  // Phase 1 is one observatory. When there is more than one this takes an id.
  const observatory = await database.observatory.findFirst({
    include: { safetyEnvelope: true, weatherState: true },
    orderBy: { createdAt: "asc" },
  });

  if (!observatory) {
    return { evaluatedAt: at.toISOString(), items: [] };
  }

  const targets = await database.target.findMany({ orderBy: { slug: "asc" } });

  const site = {
    latitudeDegrees: observatory.latitude,
    longitudeDegrees: observatory.longitude,
  };

  const envelope = observatory.safetyEnvelope
    ? {
        maxAltitudeDegrees: observatory.safetyEnvelope.maxAltitudeDegrees,
        minAltitudeDegrees: observatory.safetyEnvelope.minAltitudeDegrees,
      }
    : null;

  const observatoryState = {
    online: observatory.status === "ONLINE",
    weatherHold: observatory.weatherState?.holdActive ?? false,
  };

  return {
    evaluatedAt: at.toISOString(),
    items: targets.map((row) => ({
      target: toContractTarget(row as unknown as TargetRow),
      visibility: evaluateVisibility({
        target: row as unknown as Parameters<typeof evaluateVisibility>[0]["target"],
        site,
        envelope,
        observatory: observatoryState,
        at,
      }),
    })),
  };
}
