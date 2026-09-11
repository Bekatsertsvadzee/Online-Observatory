import "server-only";

import type { TonightTargetList } from "@darkview/contracts";

import { findBookableObservatory } from "@/features/booking/observatories";
import { getDatabase } from "@/lib/db/client";
import { evaluateVisibility } from "@/lib/ephemeris/visibility";
import { toContractTarget, type TargetRow } from "@/features/targets/projection";

/**
 * The catalogue with tonight's assessment attached, at one observatory.
 *
 * Every catalogue target appears, observable or not, each carrying the reasons it
 * is not offered. A list that silently omitted blocked targets would leave a
 * customer wondering where Saturn went, and an operator with nothing to read.
 *
 * At one observatory because visibility is a fact about a site (DV-067). Before
 * this it was evaluated at the earliest observatory row whichever telescope the
 * customer had chosen, so a customer booking a partner in Santiago was offered
 * targets by Tbilisi's sky.
 *
 * Null when the observatory is not bookable, which the route answers with 404 --
 * the same resolver and the same answer as `GET /slots`.
 */
export async function listTonightTargets(
  observatoryId: string,
  at: Date,
): Promise<TonightTargetList | null> {
  const database = getDatabase();

  const observatory = await findBookableObservatory(observatoryId);
  if (!observatory) return null;

  // The resolver answers "may this be booked?" and has no use for the envelope,
  // so it is read here rather than carried by every booking surface. Scoped by the
  // same id, and unique per observatory, so it cannot be another site's limits.
  const safetyEnvelope = await database.safetyEnvelope.findUnique({
    where: { observatoryId: observatory.id },
    select: { maxAltitudeDegrees: true, minAltitudeDegrees: true },
  });

  const targets = await database.target.findMany({ orderBy: { slug: "asc" } });

  const site = {
    latitudeDegrees: observatory.latitude,
    longitudeDegrees: observatory.longitude,
  };

  const envelope = safetyEnvelope
    ? {
        maxAltitudeDegrees: safetyEnvelope.maxAltitudeDegrees,
        minAltitudeDegrees: safetyEnvelope.minAltitudeDegrees,
      }
    : null;

  const observatoryState = {
    online: observatory.status === "ONLINE",
    weatherHold: observatory.weatherHold,
  };

  return {
    observatoryId: observatory.id,
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
