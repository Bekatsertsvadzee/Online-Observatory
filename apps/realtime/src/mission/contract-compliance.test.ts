import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { zMissionChannelMessage } from "@darkview/contracts/zod";
import {
  missionChannelError,
  missionCommandResult,
  missionStateUpdate,
  missionTelemetryUpdate,
} from "@/mission/protocol";

const MISSION = randomUUID();
const now = new Date().toISOString();

/**
 * Every message this service pushes to a client, parsed by the contract's own
 * generated validator.
 *
 * A shape assertion written by hand proves only that the code agrees with the
 * test. The client validates against `zMissionChannelMessage`, so this is the
 * check that matches what a browser would actually do with these messages.
 */
describe("every message this service emits satisfies the contract", () => {
  it("MISSION_STATE", () => {
    const parsed = zMissionChannelMessage.safeParse(
      missionStateUpdate({ missionId: MISSION, state: "OBSERVING", failureReason: null }),
    );
    expect(parsed.error?.issues ?? "ok").toEqual("ok");
  });

  it("MISSION_TELEMETRY", () => {
    const parsed = zMissionChannelMessage.safeParse(
      missionTelemetryUpdate(MISSION, {
        type: "AGENT_STATE_DELTA",
        messageId: randomUUID(),
        sentAt: now,
        missionId: MISSION,
        telemetry: {
          mode: "SIMULATED",
          link: "ONLINE",
          mount: { health: "OK", detail: null },
          camera: { health: "OK", detail: null },
          focuser: { health: "NOT_CONFIGURED", detail: null },
          weather: { status: "CLEAR", source: "OPERATOR", holdActive: false, note: null, updatedAt: now },
          pointingEquatorial: null,
          pointingHorizontal: null,
          tracking: true,
          parked: false,
          slewing: false,
          focuserPosition: null,
          ambientTemperatureC: 9.5,
          agentVersion: "0.1.0",
          reportedAt: now,
        },
        missionState: "OBSERVING",
        failureReason: null,
        centeringIteration: null,
        residualArcminutes: null,
      } as never),
    );
    expect(parsed.error?.issues ?? "ok").toEqual("ok");
  });

  it("MISSION_COMMAND_RESULT", () => {
    const parsed = zMissionChannelMessage.safeParse(
      missionCommandResult(MISSION, {
        type: "AGENT_COMMAND_ACK",
        messageId: randomUUID(),
        sentAt: now,
        commandId: randomUUID(),
        status: "REJECTED",
        rejectionReason: "SAFETY_ABOVE_MAX_ALTITUDE",
        detail: null,
      } as never),
    );
    expect(parsed.error?.issues ?? "ok").toEqual("ok");
  });

  it("MISSION_ERROR", () => {
    const parsed = zMissionChannelMessage.safeParse(
      missionChannelError("FORBIDDEN", "No live session for this mission is yours."),
    );
    expect(parsed.error?.issues ?? "ok").toEqual("ok");
  });
});
