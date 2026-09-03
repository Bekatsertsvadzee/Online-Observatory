import "server-only";

export const observatoryAdapterErrorCodes = [
  "NOT_CONFIGURED",
  "INVALID_COMMAND",
  "COMMAND_EXPIRED",
  "IDEMPOTENCY_CONFLICT",
  "MISSION_CONFLICT",
  "NO_ACTIVE_MISSION",
] as const;

export type ObservatoryAdapterErrorCode = (typeof observatoryAdapterErrorCodes)[number];

export class ObservatoryAdapterError extends Error {
  constructor(
    readonly code: ObservatoryAdapterErrorCode,
    readonly operation: keyof ObservatoryAdapter,
    message: string,
  ) {
    super(message);
    this.name = "ObservatoryAdapterError";
  }
}

export type ObservatoryConnectionState =
  "OFFLINE" | "CONNECTING" | "READY" | "BUSY" | "FAULT";

export type TelescopeState = "PARKED" | "SLEWING" | "TRACKING" | "FAULT";

export type ObservatoryStatus = {
  observatoryId: string;
  connection: ObservatoryConnectionState;
  telescope: TelescopeState;
  activeMissionId: string | null;
  observedAt: string;
  simulated: boolean;
};

export type ObservatoryTarget = {
  id: string;
  catalogId: string | null;
  nameEn: string;
};

export type ObservatoryCoordinates = {
  rightAscensionHours: number;
  declinationDegrees: number;
  epoch: "J2000";
};

export type ObservatoryCommand = {
  commandId: string;
  missionId: string;
  userId: string;
  issuedAt: string;
  expiresAt: string;
};

export type StartMissionCommand = ObservatoryCommand & {
  target: ObservatoryTarget;
  coordinates: ObservatoryCoordinates;
};

export type AbortMissionCommand = ObservatoryCommand & {
  reason: string;
};

export type ParkCommand = ObservatoryCommand;

export const capturePresets = ["NATURAL", "BRIGHT", "DETAIL"] as const;
export type CapturePreset = (typeof capturePresets)[number];

export type CaptureCommand = ObservatoryCommand & {
  preset: CapturePreset;
};

export type CommandReceipt = {
  commandId: string;
  missionId: string;
  completedAt: string;
  simulated: boolean;
};

export type CaptureReceipt = CommandReceipt & {
  captureId: string;
  previewId: string;
  preset: CapturePreset;
};

export type ObservationPreview = {
  id: string;
  missionId: string;
  target: ObservatoryTarget;
  capturedAt: string;
  preset: CapturePreset;
  simulated: boolean;
};

export const observatoryMissionEventTypes = [
  "MISSION_STARTED",
  "MISSION_ABORTED",
  "TELESCOPE_PARKED",
  "CAPTURE_COMPLETED",
] as const;

export type ObservatoryMissionEvent = {
  id: string;
  missionId: string;
  commandId: string;
  userId: string;
  type: (typeof observatoryMissionEventTypes)[number];
  occurredAt: string;
  source: "SIMULATOR" | "OBSERVATORY";
};

export interface ObservatoryAdapter {
  getStatus(): Promise<ObservatoryStatus>;
  getCurrentTarget(): Promise<ObservatoryTarget | null>;
  getCoordinates(): Promise<ObservatoryCoordinates | null>;
  startMission(command: StartMissionCommand): Promise<CommandReceipt>;
  abortMission(command: AbortMissionCommand): Promise<CommandReceipt>;
  park(command: ParkCommand): Promise<CommandReceipt>;
  capture(command: CaptureCommand): Promise<CaptureReceipt>;
  getPreview(): Promise<ObservationPreview | null>;
  getMissionEvents(missionId: string): Promise<ObservatoryMissionEvent[]>;
}
