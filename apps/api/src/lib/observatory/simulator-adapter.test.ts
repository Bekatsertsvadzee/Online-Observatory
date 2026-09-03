import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ObservatoryAdapterError,
  type CaptureCommand,
  type StartMissionCommand,
} from "@/lib/observatory/adapter";
import { SimulatorObservatoryAdapter } from "@/lib/observatory/simulator-adapter";

const now = new Date("2026-08-26T20:00:00.000Z");

function simulator() {
  return new SimulatorObservatoryAdapter({
    observatoryId: "tbilisi-simulator",
    now: () => now,
  });
}

function startCommand(overrides: Partial<StartMissionCommand> = {}): StartMissionCommand {
  return {
    commandId: "command-start-1",
    missionId: "mission-1",
    userId: "user-1",
    issuedAt: "2026-08-26T19:59:00.000Z",
    expiresAt: "2026-08-26T20:01:00.000Z",
    target: { id: "saturn", catalogId: "SATURN", nameEn: "Saturn" },
    coordinates: {
      rightAscensionHours: 23.4,
      declinationDegrees: -5.2,
      epoch: "J2000",
    },
    ...overrides,
  };
}

function captureCommand(overrides: Partial<CaptureCommand> = {}): CaptureCommand {
  return {
    commandId: "command-capture-1",
    missionId: "mission-1",
    userId: "user-1",
    issuedAt: "2026-08-26T19:59:30.000Z",
    expiresAt: "2026-08-26T20:01:00.000Z",
    preset: "NATURAL",
    ...overrides,
  };
}

describe("SimulatorObservatoryAdapter", () => {
  it("starts parked and unmistakably simulated", async () => {
    await expect(simulator().getStatus()).resolves.toEqual({
      observatoryId: "tbilisi-simulator",
      connection: "READY",
      telescope: "PARKED",
      activeMissionId: null,
      observedAt: now.toISOString(),
      simulated: true,
    });
  });

  it("tracks the mission target and records simulator events", async () => {
    const adapter = simulator();
    const command = startCommand();

    await adapter.startMission(command);

    await expect(adapter.getCurrentTarget()).resolves.toEqual(command.target);
    await expect(adapter.getCoordinates()).resolves.toEqual(command.coordinates);
    await expect(adapter.getMissionEvents(command.missionId)).resolves.toEqual([
      expect.objectContaining({
        missionId: command.missionId,
        commandId: command.commandId,
        userId: command.userId,
        type: "MISSION_STARTED",
        source: "SIMULATOR",
      }),
    ]);
  });

  it("deduplicates concurrent capture retries by commandId", async () => {
    const adapter = simulator();
    await adapter.startMission(startCommand());
    const command = captureCommand();

    const [first, retry] = await Promise.all([
      adapter.capture(command),
      adapter.capture(command),
    ]);

    expect(retry).toEqual(first);
    expect(first.captureId).toBe("mission-1-sim-capture-1");
    const captureEvents = (await adapter.getMissionEvents("mission-1")).filter(
      (event) => event.type === "CAPTURE_COMPLETED",
    );
    expect(captureEvents).toHaveLength(1);
    await expect(adapter.getPreview()).resolves.toEqual(
      expect.objectContaining({
        id: first.previewId,
        missionId: "mission-1",
        simulated: true,
      }),
    );
  });

  it("rejects reuse of a commandId with different command data", async () => {
    const adapter = simulator();
    await adapter.startMission(startCommand());
    await adapter.capture(captureCommand());

    await expect(
      adapter.capture(captureCommand({ preset: "DETAIL" })),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      operation: "capture",
    });
  });

  it("rejects expired and future-issued commands", async () => {
    const adapter = simulator();

    await expect(
      adapter.startMission(
        startCommand({
          issuedAt: "2026-08-26T19:58:00.000Z",
          expiresAt: now.toISOString(),
        }),
      ),
    ).rejects.toMatchObject({ code: "COMMAND_EXPIRED" });

    await expect(
      adapter.startMission(
        startCommand({
          issuedAt: "2026-08-26T20:01:00.000Z",
          expiresAt: "2026-08-26T20:02:00.000Z",
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
  });

  it("aborts only the active mission and returns to a parked state", async () => {
    const adapter = simulator();
    await adapter.startMission(startCommand());
    await adapter.abortMission({
      commandId: "command-abort-1",
      missionId: "mission-1",
      userId: "user-1",
      issuedAt: "2026-08-26T19:59:30.000Z",
      expiresAt: "2026-08-26T20:01:00.000Z",
      reason: "Operator requested abort",
    });

    await expect(adapter.getStatus()).resolves.toMatchObject({
      connection: "READY",
      telescope: "PARKED",
      activeMissionId: null,
    });
    await expect(adapter.getCurrentTarget()).resolves.toBeNull();
  });

  it("parks idempotently without duplicating its mission event", async () => {
    const adapter = simulator();
    await adapter.startMission(startCommand());
    const command = {
      commandId: "command-park-1",
      missionId: "mission-1",
      userId: "operator-1",
      issuedAt: "2026-08-26T19:59:30.000Z",
      expiresAt: "2026-08-26T20:01:00.000Z",
    };

    const first = await adapter.park(command);
    const retry = await adapter.park(command);

    expect(retry).toEqual(first);
    const parkEvents = (await adapter.getMissionEvents("mission-1")).filter(
      (event) => event.type === "TELESCOPE_PARKED",
    );
    expect(parkEvents).toHaveLength(1);
  });

  it("uses typed adapter errors", async () => {
    const adapter = simulator();
    const failure = adapter.capture(captureCommand());
    await expect(failure).rejects.toBeInstanceOf(ObservatoryAdapterError);
    await expect(failure).rejects.toMatchObject({ code: "NO_ACTIVE_MISSION" });
  });
});
