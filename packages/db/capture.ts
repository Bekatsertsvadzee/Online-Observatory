import type { Capture } from "@darkview/contracts";

/**
 * One capture row, as the contract describes it.
 *
 * Shared by the API and the realtime service, the same way `audit.ts` is shared,
 * because both hand a `Capture` across a process boundary and two mappings of one
 * contract type is how they come to disagree. The API answers `GET /captures`;
 * realtime pushes `MISSION_CAPTURE_READY` the moment a capture is recorded. A
 * customer must not be shown one shape live and a different shape on reload.
 *
 * Several stored columns deliberately do not cross:
 *
 * - `observatoryId`, `telescopeId` — provenance the operator needs and the
 *   customer is not offered. `Capture` declares `additionalProperties: false`.
 * - `processingPreset` — a column with no contract field and, today, no chooser.
 *   See the recorder for why it is what it is.
 * - `commandId` — internal correlation and the idempotency key.
 * - `isDemo` — a seed flag, never a fact about an image.
 *
 * `thumbnailUrl` is a *signed, short-expiry* URL and is therefore never a stored
 * value. It is minted per request against the caller, or it is null.
 */
export type CaptureRow = {
  id: string;
  missionId: string;
  userId: string;
  targetId: string;
  capturedAt: Date;
  imagingProfile: Capture["imagingProfile"];
  opticalConfig: Capture["opticalConfig"];
  exposureMilliseconds: number;
  gain: number;
  framesStacked: number;
  integrationSeconds: number;
  widthPx: number | null;
  heightPx: number | null;
  solvedFocalLengthMm: number | null;
  fitsAvailable: boolean;
  visibility: Capture["visibility"];
  mode: Capture["mode"];
};

export function toContractCapture(
  row: CaptureRow,
  thumbnailUrl: string | null = null,
): Capture {
  return {
    id: row.id,
    missionId: row.missionId,
    userId: row.userId,
    targetId: row.targetId,
    capturedAt: row.capturedAt.toISOString(),
    imagingProfile: row.imagingProfile,
    opticalConfig: row.opticalConfig,
    exposureMilliseconds: row.exposureMilliseconds,
    gain: row.gain,
    framesStacked: row.framesStacked,
    integrationSeconds: row.integrationSeconds,
    widthPx: row.widthPx,
    heightPx: row.heightPx,
    solvedFocalLengthMm: row.solvedFocalLengthMm,
    fitsAvailable: row.fitsAvailable,
    visibility: row.visibility,
    // Never defaulted to REAL, and never taken from anything the agent said about
    // itself. A capture produced by the simulator is permanently marked SIMULATED
    // and is never presented as telescope output.
    mode: row.mode,
    thumbnailUrl,
  };
}

/** The columns `toContractCapture` reads. Hands Prisma exactly this and no more. */
export const CAPTURE_CONTRACT_COLUMNS = {
  id: true,
  missionId: true,
  userId: true,
  targetId: true,
  capturedAt: true,
  imagingProfile: true,
  opticalConfig: true,
  exposureMilliseconds: true,
  gain: true,
  framesStacked: true,
  integrationSeconds: true,
  widthPx: true,
  heightPx: true,
  solvedFocalLengthMm: true,
  fitsAvailable: true,
  visibility: true,
  mode: true,
} as const;
