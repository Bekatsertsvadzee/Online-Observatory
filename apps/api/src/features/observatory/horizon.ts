import "server-only";

import type { ObservatoryHorizon } from "@darkview/contracts";

import { findBookableObservatory } from "@/features/booking/observatories";
import { getDatabase } from "@/lib/db/client";

const tenth = (value: number) => Math.round(value * 10) / 10;

/**
 * The horizon an observatory's telescope cannot see below (Phase 6.2), for the live
 * room's sky chart. Drawn only: the envelope is enforced by the cloud and the agent.
 *
 * Null when the observatory is not bookable, which the route answers with 404.
 */
export async function readObservatoryHorizon(
  observatoryId: string,
): Promise<ObservatoryHorizon | null> {
  const observatory = await findBookableObservatory(observatoryId);
  if (!observatory) return null;

  const envelope = await getDatabase().safetyEnvelope.findUnique({
    where: { observatoryId: observatory.id },
    select: {
      minAltitudeDegrees: true,
      horizonMask: {
        select: { azimuthDegrees: true, minAltitudeDegrees: true },
        orderBy: { azimuthDegrees: "asc" },
      },
    },
  });

  return {
    observatoryId: observatory.id,
    latitudeDegrees: tenth(observatory.latitude),
    longitudeDegrees: tenth(observatory.longitude),
    minAltitudeDegrees: envelope?.minAltitudeDegrees ?? null,
    mask: envelope?.horizonMask ?? [],
  };
}
