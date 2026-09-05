import "server-only";

import type { SafetyEnvelopeConfig } from "@darkview/contracts";

import { getDatabase } from "@/lib/db/client";
import type { Site } from "@/lib/ephemeris/engine";

/**
 * The stored envelope for one observatory, as the contract type.
 *
 * Null means no envelope row exists, which `isMeasured` treats exactly like a null
 * `maxAltitudeDegrees`: UNMEASURED, and nothing moves. An observatory with no
 * envelope is not an observatory with permissive defaults.
 */
export async function loadSafetyEnvelope(
  observatoryId: string,
): Promise<SafetyEnvelopeConfig | null> {
  const row = await getDatabase().safetyEnvelope.findUnique({
    where: { observatoryId },
    include: {
      horizonMask: { orderBy: { azimuthDegrees: "asc" } },
      forbiddenAzimuthSectors: true,
    },
  });

  return row === null ? null : toContractEnvelope(row);
}

type EnvelopeRow = {
  observatoryId: string;
  minAltitudeDegrees: number;
  maxAltitudeDegrees: number | null;
  maxAltitudeMeasuredAt: Date | null;
  maxAltitudeMeasuredBy: string | null;
  maxAltitudeMeasurementNote: string | null;
  sunExclusionDegrees: number;
  daylightLockSunAltitudeDegrees: number;
  nudgeMaxDegrees: number;
  nudgeRateDegreesPerSecond: number;
  slewTimeoutSeconds: number;
  heartbeatLossSeconds: number;
  linkDeadSeconds: number;
  refocusTemperatureDeltaC: number;
  updatedAt: Date;
  horizonMask: { azimuthDegrees: number; minAltitudeDegrees: number }[];
  forbiddenAzimuthSectors: { fromDegrees: number; toDegrees: number }[];
};

export function toContractEnvelope(row: EnvelopeRow): SafetyEnvelopeConfig {
  return {
    observatoryId: row.observatoryId,
    minAltitudeDegrees: row.minAltitudeDegrees,
    maxAltitudeDegrees: row.maxAltitudeDegrees,
    maxAltitudeMeasuredAt: row.maxAltitudeMeasuredAt?.toISOString() ?? null,
    maxAltitudeMeasuredBy: row.maxAltitudeMeasuredBy,
    maxAltitudeMeasurementNote: row.maxAltitudeMeasurementNote,
    horizonMask: row.horizonMask.map((entry) => ({
      azimuthDegrees: entry.azimuthDegrees,
      minAltitudeDegrees: entry.minAltitudeDegrees,
    })),
    forbiddenAzimuthSectors: row.forbiddenAzimuthSectors.map((sector) => ({
      fromDegrees: sector.fromDegrees,
      toDegrees: sector.toDegrees,
    })),
    sunExclusionDegrees: row.sunExclusionDegrees,
    daylightLockSunAltitudeDegrees: row.daylightLockSunAltitudeDegrees,
    nudgeMaxDegrees: row.nudgeMaxDegrees,
    nudgeRateDegreesPerSecond: row.nudgeRateDegreesPerSecond,
    slewTimeoutSeconds: row.slewTimeoutSeconds,
    heartbeatLossSeconds: row.heartbeatLossSeconds,
    linkDeadSeconds: row.linkDeadSeconds,
    refocusTemperatureDeltaC: row.refocusTemperatureDeltaC,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The observatory's own coordinates.
 *
 * The cloud computes the Sun from the database; the agent computes it from its
 * local configuration and never from anything the cloud sends. Two sites that
 * disagree would show up as a disagreement about where the Sun is, which is
 * exactly the kind of thing the second check exists to catch.
 */
export function siteOf(observatory: { latitude: number; longitude: number }): Site {
  return {
    latitudeDegrees: observatory.latitude,
    longitudeDegrees: observatory.longitude,
  };
}
