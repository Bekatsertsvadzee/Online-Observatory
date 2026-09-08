import "server-only";

import type {
  ErrorCode,
  ObservatoryMode,
  SetObservatoryModeRequest,
  SetWeatherHoldRequest,
  WeatherState,
} from "@darkview/contracts";
import { recordAuditEvent } from "@darkview/db/audit";

import { getDatabase } from "@/lib/db/client";
import { LIVE_MISSION_STATES } from "@/features/missions/session";

export type AdminFailure = {
  ok: false;
  status: 404 | 409 | 422;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type ModeResult = { ok: true; mode: ObservatoryMode } | AdminFailure;

/**
 * Switch the observatory between the simulator and real hardware.
 *
 * `CLAUDE.md`: "The simulator is the default implementation. Always." and
 * "Real-hardware mode requires an explicit, attended operator action outside the
 * normal test workflow." This is that action, and it is the cloud's half of it --
 * the agent enforces its own half independently and will not start in REAL without
 * `DARKVIEW_AGENT_ATTENDED`, whatever this row says.
 *
 * Three things are required and none of them is a formality:
 *
 * - an **operator**, checked by the route guard before this is called;
 * - a written **reason**, stored verbatim, because a mode switch with no stated
 *   cause is indistinguishable afterwards from an accident;
 * - an affirmative **attendedOperatorPresent**, which asserts that a human is
 *   standing at the observatory. No autonomous or background session may set it,
 *   and nothing here can infer it -- which is the point of making it a field
 *   somebody has to type rather than a property of the request.
 *
 * Going back to SIMULATED needs a reason too, and no attendance: stepping away
 * from the hardware is always allowed and always worth recording.
 */
export async function setObservatoryMode(input: {
  observatoryId: string;
  request: SetObservatoryModeRequest;
  actorUserId: string;
}): Promise<ModeResult> {
  const { observatoryId, request, actorUserId } = input;

  if (request.mode === "REAL" && !request.attendedOperatorPresent) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      message:
        "REAL requires attendedOperatorPresent. Real-hardware mode is an attended " +
        "operator action: a human must be at the observatory, able to watch the " +
        "mount and cut power.",
    };
  }

  const database = getDatabase();

  const observatory = await database.observatory.findUnique({
    where: { id: observatoryId },
    select: { id: true, mode: true },
  });
  if (!observatory) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "No such observatory." };
  }

  // Not while a mission is running. Switching under a live mission would change
  // what `Mission.mode` means halfway through it -- a session that began against
  // the simulator would finish against a telescope, or the reverse, and the
  // capture it produced could no longer be honestly labelled either way.
  const live = await database.mission.findFirst({
    where: { observatoryId, state: { in: [...LIVE_MISSION_STATES] } },
    select: { id: true, state: true },
  });
  if (live && observatory.mode !== request.mode) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: `Mission ${live.id} is ${live.state}. End it before changing mode.`,
      details: { missionId: live.id, state: live.state },
    };
  }

  await database.$transaction(async (tx) => {
    await tx.observatory.update({
      where: { id: observatoryId },
      data: { mode: request.mode },
    });

    // In the transaction with the update, so the record and the fact share a fate.
    // A mode switch nobody can account for afterwards is the one this repository
    // most needs written down.
    await recordAuditEvent(
      {
        category: "OBSERVATORY_MODE",
        action: "OBSERVATORY_MODE_CHANGED",
        actorUserId,
        entityType: "Observatory",
        entityId: observatoryId,
        detail: {
          from: observatory.mode,
          to: request.mode,
          // Verbatim. Not summarised, not normalised.
          reason: request.reason,
          attendedOperatorPresent: request.attendedOperatorPresent,
        },
      },
      tx,
    );
  });

  return { ok: true, mode: request.mode };
}

export type WeatherResult = { ok: true; weather: WeatherState } | AdminFailure;

/**
 * Set or clear the operator's weather hold.
 *
 * Phase 1 has no sky sensor, so this is the only thing that can declare the
 * weather unsafe. `Watchdog.weather_unsafe` on the agent has no caller for the
 * same reason; DV-039 is what connects them. Until then a hold is a cloud-side
 * refusal to start new missions, and it does not stop one already running.
 *
 * Recorded under SAFETY rather than MISSION. A hold is a statement about whether
 * it is safe to open the roof, and it belongs with the refusals rather than with
 * the operations.
 */
export async function setWeatherHold(input: {
  observatoryId: string;
  request: SetWeatherHoldRequest;
  actorUserId: string;
}): Promise<WeatherResult> {
  const { observatoryId, request, actorUserId } = input;
  const database = getDatabase();

  const observatory = await database.observatory.findUnique({
    where: { id: observatoryId },
    select: { id: true },
  });
  if (!observatory) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "No such observatory." };
  }

  const row = await database.$transaction(async (tx) => {
    const previous = await tx.weatherState.findUnique({
      where: { observatoryId },
      select: { holdActive: true, status: true },
    });

    const state = await tx.weatherState.upsert({
      where: { observatoryId },
      create: {
        observatoryId,
        status: request.status,
        holdActive: request.holdActive,
        note: request.note ?? null,
        setByUserId: actorUserId,
      },
      update: {
        status: request.status,
        holdActive: request.holdActive,
        note: request.note ?? null,
        setByUserId: actorUserId,
      },
    });

    await recordAuditEvent(
      {
        category: "SAFETY",
        action: request.holdActive ? "WEATHER_HOLD_SET" : "WEATHER_HOLD_CLEARED",
        actorUserId,
        entityType: "Observatory",
        entityId: observatoryId,
        detail: {
          from: previous
            ? { holdActive: previous.holdActive, status: previous.status }
            : null,
          to: { holdActive: request.holdActive, status: request.status },
          note: request.note ?? null,
        },
      },
      tx,
    );

    return state;
  });

  return {
    ok: true,
    weather: {
      status: row.status,
      // OPERATOR, and it is a fact rather than a default: this endpoint is the
      // only writer of weather in Phase 1, and no sensor is fitted. SENSOR becomes
      // reachable when DV-039 gives one a writer, and at that point the source has
      // to be stored rather than asserted here.
      source: "OPERATOR",
      holdActive: row.holdActive,
      note: row.note,
      updatedAt: row.updatedAt.toISOString(),
    },
  };
}
