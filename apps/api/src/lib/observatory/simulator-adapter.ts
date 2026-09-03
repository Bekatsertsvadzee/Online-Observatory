import "server-only";

import {
  ObservatoryAdapterError,
  type AbortMissionCommand,
  type CaptureCommand,
  type CaptureReceipt,
  type CommandReceipt,
  type ObservationPreview,
  type ObservatoryAdapter,
  type ObservatoryCommand,
  type ObservatoryCoordinates,
  type ObservatoryMissionEvent,
  type ObservatoryStatus,
  type ObservatoryTarget,
  type ParkCommand,
  type StartMissionCommand,
} from "@/lib/observatory/adapter";

type SimulatorOptions = {
  observatoryId?: string;
  now?: () => Date;
};

type CommandLedgerEntry = {
  fingerprint: string;
  result: Promise<unknown>;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export class SimulatorObservatoryAdapter implements ObservatoryAdapter {
  private readonly observatoryId: string;
  private readonly now: () => Date;
  private readonly commandLedger = new Map<string, CommandLedgerEntry>();
  private readonly events = new Map<string, ObservatoryMissionEvent[]>();
  private activeMissionId: string | null = null;
  private currentTarget: ObservatoryTarget | null = null;
  private coordinates: ObservatoryCoordinates | null = null;
  private preview: ObservationPreview | null = null;
  private telescope: ObservatoryStatus["telescope"] = "PARKED";

  constructor(options: SimulatorOptions = {}) {
    this.observatoryId = options.observatoryId ?? "tbilisi-simulator";
    this.now = options.now ?? (() => new Date());
  }

  async getStatus(): Promise<ObservatoryStatus> {
    return {
      observatoryId: this.observatoryId,
      connection: this.activeMissionId ? "BUSY" : "READY",
      telescope: this.telescope,
      activeMissionId: this.activeMissionId,
      observedAt: this.now().toISOString(),
      simulated: true,
    };
  }

  async getCurrentTarget() {
    return this.currentTarget ? { ...this.currentTarget } : null;
  }

  async getCoordinates() {
    return this.coordinates ? { ...this.coordinates } : null;
  }

  startMission(command: StartMissionCommand) {
    return this.execute("startMission", command, () => {
      if (
        !command.target.id.trim() ||
        !command.target.nameEn.trim() ||
        // catalogId is optional -- the Moon and the planets have no catalogue
        // designation -- but an empty string is a bug, not an absent value.
        command.target.catalogId?.trim() === "" ||
        command.coordinates.rightAscensionHours < 0 ||
        command.coordinates.rightAscensionHours >= 24 ||
        command.coordinates.declinationDegrees < -90 ||
        command.coordinates.declinationDegrees > 90
      ) {
        throw new ObservatoryAdapterError(
          "INVALID_COMMAND",
          "startMission",
          "The mission target or coordinates are invalid",
        );
      }
      if (this.activeMissionId && this.activeMissionId !== command.missionId) {
        throw new ObservatoryAdapterError(
          "MISSION_CONFLICT",
          "startMission",
          "The simulator is already assigned to another mission",
        );
      }

      this.activeMissionId = command.missionId;
      this.currentTarget = { ...command.target };
      this.coordinates = { ...command.coordinates };
      this.telescope = "TRACKING";
      this.appendEvent(command, "MISSION_STARTED");
      return this.receipt(command);
    });
  }

  abortMission(command: AbortMissionCommand) {
    return this.execute("abortMission", command, () => {
      this.requireActiveMission(command, "abortMission");
      this.appendEvent(command, "MISSION_ABORTED");
      this.clearMission();
      return this.receipt(command);
    });
  }

  park(command: ParkCommand) {
    return this.execute("park", command, () => {
      if (this.activeMissionId && this.activeMissionId !== command.missionId) {
        throw new ObservatoryAdapterError(
          "MISSION_CONFLICT",
          "park",
          "The park command does not match the active simulator mission",
        );
      }
      this.telescope = "PARKED";
      this.appendEvent(command, "TELESCOPE_PARKED");
      this.activeMissionId = null;
      this.currentTarget = null;
      this.coordinates = null;
      return this.receipt(command);
    });
  }

  capture(command: CaptureCommand) {
    return this.execute("capture", command, () => {
      this.requireActiveMission(command, "capture");
      if (!this.currentTarget || this.telescope !== "TRACKING") {
        throw new ObservatoryAdapterError(
          "NO_ACTIVE_MISSION",
          "capture",
          "The simulator has no tracked target to capture",
        );
      }

      const capturedAt = this.now().toISOString();
      const captureNumber =
        (this.events.get(command.missionId) ?? []).filter(
          (event) => event.type === "CAPTURE_COMPLETED",
        ).length + 1;
      const captureId = `${command.missionId}-sim-capture-${captureNumber}`;
      const previewId = `${captureId}-preview`;
      this.preview = {
        id: previewId,
        missionId: command.missionId,
        target: { ...this.currentTarget },
        capturedAt,
        preset: command.preset,
        simulated: true,
      };
      this.appendEvent(command, "CAPTURE_COMPLETED", capturedAt);
      return {
        ...this.receipt(command, capturedAt),
        captureId,
        previewId,
        preset: command.preset,
      } satisfies CaptureReceipt;
    });
  }

  async getPreview() {
    return this.preview ? { ...this.preview, target: { ...this.preview.target } } : null;
  }

  async getMissionEvents(missionId: string) {
    return (this.events.get(missionId) ?? []).map((event) => ({ ...event }));
  }

  private async execute<Result>(
    operation: "startMission" | "abortMission" | "park" | "capture",
    command: ObservatoryCommand,
    run: () => Result,
  ): Promise<Result> {
    const fingerprint = JSON.stringify(canonicalize({ operation, command }));
    const existing = this.commandLedger.get(command.commandId);

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ObservatoryAdapterError(
          "IDEMPOTENCY_CONFLICT",
          operation,
          "The commandId was already used with different command data",
        );
      }
      return existing.result as Promise<Result>;
    }

    this.validateCommand(command, operation);
    const result = Promise.resolve().then(run);
    this.commandLedger.set(command.commandId, { fingerprint, result });
    result.catch(() => this.commandLedger.delete(command.commandId));
    return result;
  }

  private validateCommand(
    command: ObservatoryCommand,
    operation: "startMission" | "abortMission" | "park" | "capture",
  ) {
    const issuedAt = new Date(command.issuedAt);
    const expiresAt = new Date(command.expiresAt);
    const now = this.now();
    const requiredValues = [command.commandId, command.missionId, command.userId];

    if (
      requiredValues.some((value) => value.trim().length === 0) ||
      Number.isNaN(issuedAt.getTime()) ||
      Number.isNaN(expiresAt.getTime()) ||
      expiresAt <= issuedAt ||
      issuedAt > now
    ) {
      throw new ObservatoryAdapterError(
        "INVALID_COMMAND",
        operation,
        "The command envelope is invalid",
      );
    }
    if (expiresAt <= now) {
      throw new ObservatoryAdapterError(
        "COMMAND_EXPIRED",
        operation,
        "The command has expired",
      );
    }
  }

  private requireActiveMission(
    command: ObservatoryCommand,
    operation: "abortMission" | "capture",
  ) {
    if (this.activeMissionId !== command.missionId) {
      throw new ObservatoryAdapterError(
        "NO_ACTIVE_MISSION",
        operation,
        "The command does not match the active simulator mission",
      );
    }
  }

  private receipt(command: ObservatoryCommand, completedAt = this.now().toISOString()) {
    return {
      commandId: command.commandId,
      missionId: command.missionId,
      completedAt,
      simulated: true,
    } satisfies CommandReceipt;
  }

  private appendEvent(
    command: ObservatoryCommand,
    type: ObservatoryMissionEvent["type"],
    occurredAt = this.now().toISOString(),
  ) {
    const missionEvents = this.events.get(command.missionId) ?? [];
    missionEvents.push({
      id: `${command.missionId}-adapter-event-${missionEvents.length + 1}`,
      missionId: command.missionId,
      commandId: command.commandId,
      userId: command.userId,
      type,
      occurredAt,
      source: "SIMULATOR",
    });
    this.events.set(command.missionId, missionEvents);
  }

  private clearMission() {
    this.activeMissionId = null;
    this.currentTarget = null;
    this.coordinates = null;
    this.telescope = "PARKED";
  }
}
