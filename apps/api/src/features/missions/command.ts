import "server-only";

import { randomUUID } from "node:crypto";

import type {
  CommandEnvelope,
  CommandPayload,
  ErrorCode,
  GotoPayload,
  MissionCommandAccepted,
  MissionCommandRequest,
} from "@darkview/contracts";

import { getDatabase } from "@/lib/db/client";
import { equatorialFor } from "@/lib/ephemeris/visibility";
import { notifyAgent } from "@/lib/observatory/relay";
import { LIVE_MISSION_STATES } from "@/features/missions/session";

/**
 * How long a minted command stays valid.
 *
 * Criterion 6: configured, not per-request. A client cannot ask for a command that
 * outlives this, and cannot ask for one that lives longer than another. Short,
 * because the only thing expiry protects against is a command queued before a
 * reconnect firing after it -- by which time the sky, the mount and the customer's
 * intent have all moved on.
 */
export const COMMAND_TTL_SECONDS = 30;

/**
 * Fields the cloud mints and a client may never send.
 *
 * The contract marks MissionCommandRequest `additionalProperties: false`, but the
 * generated Zod strips unknown keys instead of rejecting them (issue #15). Stripping
 * is exactly wrong here: a client that sent its own `sessionId` would be quietly
 * ignored and told it succeeded, when what it attempted was to command as somebody
 * else. So the raw body is checked for these before it is parsed.
 */
export const CLOUD_MINTED_FIELDS = [
  "commandId",
  "sessionId",
  "userId",
  "issuedAt",
  "expiresAt",
] as const;

/**
 * Command types a customer may never cause, whatever they put in `type`.
 *
 * The contract: "GOTO, FOCUS, PARK and SET_PROFILE are never client-initiated: the
 * target comes from the booking and the rest are cloud or operator concerns."
 */
export const OPERATOR_ONLY_COMMANDS = ["GOTO", "FOCUS", "PARK", "SET_PROFILE"] as const;

export type MintFailure = {
  ok: false;
  status: 403 | 404 | 409 | 422;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type MintSuccess = { ok: true; accepted: MissionCommandAccepted };
export type MintResult = MintSuccess | MintFailure;

/**
 * Reject a body that tries to mint any part of its own envelope.
 *
 * Criterion 1. Separate from schema parsing and run before it, because the point
 * is to refuse the attempt rather than to sanitise it.
 */
export function rejectCloudMintedFields(body: unknown): MintFailure | null {
  if (typeof body !== "object" || body === null) return null;

  const offending = CLOUD_MINTED_FIELDS.filter((field) => field in body);
  if (offending.length === 0) return null;

  return {
    ok: false,
    status: 422,
    code: "VALIDATION_FAILED",
    message:
      "A client submits intent only. commandId, sessionId, userId, issuedAt and " +
      "expiresAt are set by the cloud.",
    details: { rejectedFields: offending },
  };
}

/**
 * Reject a command type only the cloud or an operator may cause.
 *
 * Criterion 2. Also run before schema parsing: the generated enum would refuse
 * GOTO as simply invalid, and "that is not a value" is a worse answer than "you
 * may not ask for that".
 */
export function rejectOperatorOnlyCommand(body: unknown): MintFailure | null {
  const type =
    typeof body === "object" && body !== null && "type" in body
      ? (body as { type: unknown }).type
      : undefined;

  if (typeof type !== "string") return null;
  if (!OPERATOR_ONLY_COMMANDS.includes(type as (typeof OPERATOR_ONLY_COMMANDS)[number])) {
    return null;
  }

  return {
    ok: false,
    status: 403,
    code: "FORBIDDEN",
    message: `${type} is never client-initiated.`,
    // ErrorCode has no member for this; CommandRejectionReason does, and it is the
    // vocabulary the rest of the command path speaks.
    details: { rejectionReason: "COMMAND_NOT_PERMITTED_FOR_CLIENT" },
  };
}

/**
 * Turn client intent into a CommandEnvelope, and hand it to the relay.
 *
 * The client contributes `type` and, for NUDGE and CAPTURE, a bounded payload.
 * Everything else -- who, which session, when it was issued, when it dies -- is
 * decided here. Nothing in the returned envelope came from the request except the
 * intent itself.
 */
export async function mintMissionCommand(input: {
  missionId: string;
  request: MissionCommandRequest;
  actor: { id: string; role: "USER" | "OPERATOR" };
  now: Date;
}): Promise<MintResult> {
  const database = getDatabase();
  const { missionId, request, actor, now } = input;

  const mission = await database.mission.findUnique({
    where: { id: missionId },
    include: {
      observatory: true,
      target: true,
      booking: { select: { targetId: true } },
    },
  });

  if (!mission || (actor.role !== "OPERATOR" && mission.userId !== actor.id)) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "No such mission." };
  }

  if (
    !LIVE_MISSION_STATES.includes(mission.state as (typeof LIVE_MISSION_STATES)[number])
  ) {
    return {
      ok: false,
      status: 409,
      code: "MISSION_NOT_ACTIVE",
      message: `A mission in ${mission.state} accepts no commands.`,
    };
  }

  const session = await database.missionSession.findFirst({
    where: { missionId, revokedAt: null, expiresAt: { gt: now } },
  });

  if (!session) {
    return {
      ok: false,
      status: 409,
      code: "MISSION_NOT_ACTIVE",
      message: "No session owns this mission. Start one first.",
    };
  }

  // The session owner commands. An operator who is not the owner does not get to
  // reach around the session -- that is an operator override (DV-063), which is a
  // different, audited path and not this one.
  if (session.userId !== actor.id) {
    return {
      ok: false,
      status: 409,
      code: "SESSION_NOT_OWNER",
      message: "Another session owns this mission.",
    };
  }

  const payload = buildPayload(request, mission, now);
  if ("error" in payload) return payload.error;

  const commandId = randomUUID();
  const expiresAt = new Date(now.getTime() + COMMAND_TTL_SECONDS * 1000);

  const envelope: CommandEnvelope = {
    commandId,
    missionId,
    sessionId: session.id,
    userId: session.userId,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    type: payload.type,
    payload: payload.payload,
  };

  await database.$transaction(async (tx) => {
    await tx.observatoryCommand.create({
      data: {
        id: commandId,
        missionId,
        sessionId: session.id,
        userId: session.userId,
        observatoryId: mission.observatoryId,
        type: payload.type,
        status: "RECEIVED",
        issuedAt: now,
        expiresAt,
        payload: envelope.payload as object,
        simulated: mission.observatory.mode === "SIMULATED",
        isDemo: mission.isDemo,
      },
    });

    await notifyAgent(tx, {
      kind: "COMMAND",
      commandId,
      observatoryId: mission.observatoryId,
    });
  });

  return {
    ok: true,
    accepted: {
      commandId,
      missionId,
      type: payload.type,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      status: "ACCEPTED",
    },
  };
}

type BuiltPayload =
  { type: CommandEnvelope["type"]; payload: CommandPayload } | { error: MintFailure };

/**
 * Client intent to contract payload.
 *
 * RECENTER is the interesting one. It becomes a GOTO, and its coordinates come
 * from the booked target -- never from the request, which carries none. That is
 * what stops "recentre" being a free-form slew wearing a friendlier name.
 */
function buildPayload(
  request: MissionCommandRequest,
  mission: {
    targetId: string;
    target: Parameters<typeof equatorialFor>[0] & {
      opticalConfig: string;
      imagingProfile: string;
      id: string;
    };
    booking: { targetId: string } | null;
    observatory: { latitude: number; longitude: number };
  },
  now: Date,
): BuiltPayload {
  switch (request.type) {
    case "NUDGE": {
      if (!request.nudge) {
        return { error: missingPayload("NUDGE", "nudge") };
      }
      return { type: "NUDGE", payload: request.nudge };
    }

    case "CAPTURE": {
      if (!request.capture) {
        return { error: missingPayload("CAPTURE", "capture") };
      }
      return { type: "CAPTURE", payload: request.capture };
    }

    case "ABORT": {
      return {
        type: "ABORT",
        payload: { kind: "ABORT", reason: request.reason ?? "CUSTOMER_ABORT" },
      };
    }

    case "RECENTER": {
      // The booking is the authority on what was sold. Falling back to the
      // mission's target covers operator and demo missions, which have no booking;
      // the two agree for every mission a customer created.
      const bookedTargetId = mission.booking?.targetId ?? mission.targetId;
      if (bookedTargetId !== mission.target.id) {
        return {
          error: {
            ok: false,
            status: 409,
            code: "INTERNAL",
            message: "The mission's target and its booking disagree.",
          },
        };
      }

      const coordinates = equatorialFor(mission.target, now, {
        latitudeDegrees: mission.observatory.latitude,
        longitudeDegrees: mission.observatory.longitude,
      });

      const goto: GotoPayload = {
        kind: "GOTO",
        targetId: bookedTargetId,
        coordinates,
        opticalConfig: mission.target.opticalConfig as GotoPayload["opticalConfig"],
        imagingProfile: mission.target.imagingProfile as GotoPayload["imagingProfile"],
        recenter: true,
      };

      return { type: "GOTO", payload: goto };
    }
  }
}

function missingPayload(type: string, field: string): MintFailure {
  return {
    ok: false,
    status: 422,
    code: "VALIDATION_FAILED",
    message: `A ${type} command requires a \`${field}\` payload.`,
  };
}
