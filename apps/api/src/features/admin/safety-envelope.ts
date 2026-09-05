import "server-only";

import type { ErrorCode, SafetyEnvelopeConfig } from "@darkview/contracts";

import { getDatabase } from "@/lib/db/client";
import { notifyAgent } from "@/lib/observatory/relay";
import { toContractEnvelope } from "@/lib/safety/store";

export type EnvelopeFailure = {
  ok: false;
  status: 404 | 422;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type EnvelopeResult =
  { ok: true; envelope: SafetyEnvelopeConfig } | EnvelopeFailure;

/**
 * Record a measured safety envelope.
 *
 * `maxAltitudeDegrees` is not a configuration preference. It is MAX_ALT_SAFE, read
 * off the assembled optical train by raising the altitude in five-degree steps with
 * the power off and watching the rear of the camera train against the fork base.
 * The provenance is therefore part of the value: a number with no measuredAt and no
 * measuredBy is somebody's guess, and a guess here is how an optical train meets a
 * fork arm.
 *
 * So supplying it requires both. Null is always accepted -- that is the UNMEASURED
 * state every observatory ships in, and while it holds, both the cloud and the
 * agent refuse every slew.
 */
export async function setSafetyEnvelope(input: {
  observatoryId: string;
  envelope: SafetyEnvelopeConfig;
}): Promise<EnvelopeResult> {
  const { observatoryId, envelope } = input;

  const missing = provenanceGapsOf(envelope);
  if (missing.length > 0) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      message:
        "maxAltitudeDegrees is a measured value. Recording one requires " +
        "maxAltitudeMeasuredAt and maxAltitudeMeasuredBy.",
      details: { missing },
    };
  }

  const database = getDatabase();
  const observatory = await database.observatory.findUnique({
    where: { id: observatoryId },
    select: { id: true },
  });
  if (!observatory) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "No such observatory." };
  }

  const scalars = {
    minAltitudeDegrees: envelope.minAltitudeDegrees,
    maxAltitudeDegrees: envelope.maxAltitudeDegrees,
    maxAltitudeMeasuredAt: envelope.maxAltitudeMeasuredAt
      ? new Date(envelope.maxAltitudeMeasuredAt)
      : null,
    maxAltitudeMeasuredBy: envelope.maxAltitudeMeasuredBy ?? null,
    maxAltitudeMeasurementNote: envelope.maxAltitudeMeasurementNote ?? null,
    sunExclusionDegrees: envelope.sunExclusionDegrees,
    daylightLockSunAltitudeDegrees: envelope.daylightLockSunAltitudeDegrees,
    nudgeMaxDegrees: envelope.nudgeMaxDegrees,
    nudgeRateDegreesPerSecond: envelope.nudgeRateDegreesPerSecond,
    slewTimeoutSeconds: envelope.slewTimeoutSeconds,
    heartbeatLossSeconds: envelope.heartbeatLossSeconds,
    linkDeadSeconds: envelope.linkDeadSeconds,
    refocusTemperatureDeltaC: envelope.refocusTemperatureDeltaC,
  };

  const stored = await database.$transaction(async (tx) => {
    const row = await tx.safetyEnvelope.upsert({
      where: { observatoryId },
      create: { observatoryId, ...scalars },
      update: scalars,
    });

    // Replaced wholesale rather than merged. A survey is one document: leaving a
    // bearing behind from a previous survey would build a horizon out of two.
    await tx.horizonMaskEntry.deleteMany({ where: { safetyEnvelopeId: row.id } });
    await tx.azimuthSector.deleteMany({ where: { safetyEnvelopeId: row.id } });

    if (envelope.horizonMask.length > 0) {
      await tx.horizonMaskEntry.createMany({
        data: envelope.horizonMask.map((entry) => ({
          safetyEnvelopeId: row.id,
          azimuthDegrees: entry.azimuthDegrees,
          minAltitudeDegrees: entry.minAltitudeDegrees,
        })),
      });
    }
    if (envelope.forbiddenAzimuthSectors.length > 0) {
      await tx.azimuthSector.createMany({
        data: envelope.forbiddenAzimuthSectors.map((sector) => ({
          safetyEnvelopeId: row.id,
          fromDegrees: sector.fromDegrees,
          toDegrees: sector.toDegrees,
        })),
      });
    }

    // Inside the transaction, like every other agent notification: the agent is
    // never told about an envelope that did not commit.
    await notifyAgent(tx, { kind: "ENVELOPE", observatoryId });

    return tx.safetyEnvelope.findUniqueOrThrow({
      where: { observatoryId },
      include: {
        horizonMask: { orderBy: { azimuthDegrees: "asc" } },
        forbiddenAzimuthSectors: true,
      },
    });
  });

  return { ok: true, envelope: toContractEnvelope(stored) };
}

/** Which pieces of the measurement's provenance are missing. Empty when null. */
export function provenanceGapsOf(envelope: SafetyEnvelopeConfig): string[] {
  if (envelope.maxAltitudeDegrees === null || envelope.maxAltitudeDegrees === undefined) {
    return [];
  }

  const missing: string[] = [];
  if (!envelope.maxAltitudeMeasuredAt) missing.push("maxAltitudeMeasuredAt");
  if (!envelope.maxAltitudeMeasuredBy) missing.push("maxAltitudeMeasuredBy");
  return missing;
}
