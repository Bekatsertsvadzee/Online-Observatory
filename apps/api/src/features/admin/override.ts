import "server-only";

import { randomUUID } from "node:crypto";

import type {
  CommandEnvelope,
  ErrorCode,
  MissionCommandAccepted,
  OperatorOverrideRequest,
} from "@darkview/contracts";
import { recordAuditEvent } from "@darkview/db/audit";

import { getDatabase } from "@/lib/db/client";
import { COMMAND_TTL_SECONDS } from "@/features/missions/command";
import { LIVE_MISSION_STATES } from "@/features/missions/session";
import { horizontalAirlessOf } from "@/lib/ephemeris/engine";
import { notifyAgent } from "@/lib/observatory/relay";
import { evaluatePointing } from "@/lib/safety/envelope";
import { loadSafetyEnvelope, siteOf } from "@/lib/safety/store";

/**
 * Commands that must reach the observatory whatever the envelope says.
 *
 * The same pair the agent's validator exempts, and for the same reason: Park is
 * the answer to every unresolved condition and moves the mount to a known-safe
 * position by definition. Refusing a Park because the envelope is unmeasured would
 * strand a telescope in exactly the situation Park exists to resolve.
 *
 * They are still fully authorised. An unauthorised Park is still unauthorised.
 */
const RECOVERY_COMMANDS = ["PARK", "ABORT"] as const;

export type OverrideFailure = {
  ok: false;
  status: 404 | 409 | 422;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type OverrideResult =
  { ok: true; accepted: MissionCommandAccepted } | OverrideFailure;

/**
 * Operator manual control, separately audited and still safety-bounded.
 *
 * This is the path that exists so an operator watching something go wrong can act
 * on it. `docs/SAFETY.md` recorded its absence as a gap: until now the only ways to
 * stop a mount were to send a command as the session owner, to stop the agent
 * process, or to wait out `linkDeadSeconds`. None of those is a thing an operator
 * can do in a hurry.
 *
 * What makes it an override is that it does **not** go through the session. The
 * customer's session still owns the mission, and the operator commands anyway --
 * which is precisely why every one of them is written to the audit log with the
 * operator's identity and their stated reason, under its own category.
 *
 * What it is not is an escape from safety. The cloud pre-check below is the same
 * `evaluatePointing` a customer's command runs, and the agent checks again
 * independently and refuses if its own envelope says no. **The Sun exclusion is
 * never overridable**, by this path or any other: there is no flag here that
 * reaches it, and the agent would refuse it regardless.
 */
export async function issueOperatorOverride(input: {
  request: OperatorOverrideRequest;
  operator: { id: string };
  now: Date;
}): Promise<OverrideResult> {
  const { request, operator, now } = input;
  const database = getDatabase();

  // A standalone override -- one with no mission -- cannot be built. See
  // `standaloneOverrideIsNotBuildable` below for why, and why that is reported
  // rather than worked around.
  if (!request.missionId) return standaloneOverrideIsNotBuildable();

  const mission = await database.mission.findUnique({
    where: { id: request.missionId },
    include: {
      observatory: { select: { id: true, mode: true, latitude: true, longitude: true } },
    },
  });
  if (!mission) {
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

  // The session the customer holds, used as the envelope's session rather than
  // replaced. The agent refuses any envelope whose sessionId is not the owner it
  // last received, so an override that invented one would be refused at the
  // observatory -- and rightly: the override widens who may issue a command, not
  // which session the agent believes in.
  const session = await database.missionSession.findFirst({
    where: { missionId: mission.id, revokedAt: null, expiresAt: { gt: now } },
    select: { id: true, userId: true },
  });
  if (!session) {
    return {
      ok: false,
      status: 409,
      code: "MISSION_NOT_ACTIVE",
      message: "No session owns this mission, so the agent would refuse the envelope.",
    };
  }

  // The contract: "payload.kind MUST equal the envelope's type; both the cloud and
  // the agent reject an envelope where they disagree." The customer path cannot
  // produce a mismatch -- it builds the payload rather than accepting one -- but
  // this path takes both from the request, so it has to check.
  //
  // This is not bookkeeping. Without it an override could carry type PARK with a
  // GOTO payload, and the recovery exemption below would wave a slew straight past
  // the safety pre-check under a Park's name.
  if (request.payload.kind !== request.type) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      message: `A ${request.type} command may not carry a ${request.payload.kind} payload.`,
      details: { type: request.type, payloadKind: request.payload.kind },
    };
  }

  const refusal = await preValidate({ request, observatory: mission.observatory, now });
  if (refusal) {
    // Audited even though nothing else is written. An operator override the cloud
    // refused leaves no command row, so without this the only trace would be an
    // HTTP status nobody kept -- and a refused override is exactly the event an
    // incident review wants to find.
    await recordAuditEvent(
      {
        category: "OPERATOR_OVERRIDE",
        action: "OPERATOR_OVERRIDE_ISSUED",
        actorUserId: operator.id,
        missionId: mission.id,
        entityType: "Mission",
        entityId: mission.id,
        detail: {
          outcome: "REFUSED_BY_CLOUD",
          commandType: request.type,
          reason: request.reason,
          rejectionReason: refusal.details?.rejectionReason,
          detail: refusal.message,
        },
        isDemo: mission.isDemo,
      },
      database,
    );
    return refusal;
  }

  const commandId = randomUUID();
  const expiresAt = new Date(now.getTime() + COMMAND_TTL_SECONDS * 1000);

  const envelope: CommandEnvelope = {
    commandId,
    missionId: mission.id,
    sessionId: session.id,
    // The session's owner, not the operator. This field is what the agent matches
    // against the session owner it holds; putting the operator's id here would be
    // refused at the observatory. Who actually issued it is `issuedByOperatorId`,
    // which is the field the contract added for exactly this.
    userId: session.userId,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    type: request.type,
    payload: request.payload,
    issuedByOperatorId: operator.id,
  };

  await database.$transaction(async (tx) => {
    await tx.observatoryCommand.create({
      data: {
        id: commandId,
        missionId: mission.id,
        sessionId: session.id,
        userId: session.userId,
        observatoryId: mission.observatoryId,
        type: request.type,
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

    await recordAuditEvent(
      {
        category: "OPERATOR_OVERRIDE",
        action: "OPERATOR_OVERRIDE_ISSUED",
        actorUserId: operator.id,
        missionId: mission.id,
        commandId,
        entityType: "ObservatoryCommand",
        entityId: commandId,
        detail: {
          outcome: "RELAYED",
          commandType: request.type,
          // Verbatim, and required by the schema at eight characters minimum. An
          // override with no stated cause is indistinguishable afterwards from a
          // mistake.
          reason: request.reason,
          // Whose session was commanded around. The person watching this mission
          // did not ask for it and should be identifiable in the record.
          sessionOwnerId: session.userId,
        },
        isDemo: mission.isDemo,
      },
      tx,
    );
  });

  return {
    ok: true,
    accepted: {
      commandId,
      missionId: mission.id,
      type: request.type,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      // ACCEPTED means the cloud minted and relayed it, never that the telescope
      // obeyed. The agent validates again independently and its refusal arrives
      // later as an AGENT_COMMAND_ACK.
      status: "ACCEPTED",
    },
  };
}

/**
 * The cloud's half of the two independent checks, for an override.
 *
 * Identical to the customer path except in who is allowed to ask. An override that
 * skipped this would be the cloud minting a command it had never examined, which is
 * the exact hole DV-059 closed.
 *
 * PARK and ABORT skip it, matching the agent's own validator. Everything else is
 * judged on where the telescope would end up.
 */
async function preValidate(input: {
  request: OperatorOverrideRequest;
  observatory: { id: string; latitude: number; longitude: number };
  now: Date;
}): Promise<OverrideFailure | null> {
  const { request, observatory, now } = input;

  // Judged on the payload, never on the declared type. The two are checked to
  // agree before this runs, but exempting on `type` would still be the wrong shape:
  // it is the payload that says where the telescope would end up, and a check that
  // reads one field while acting on another is how a mismatch becomes a bypass.
  if (
    RECOVERY_COMMANDS.includes(request.payload.kind as (typeof RECOVERY_COMMANDS)[number])
  ) {
    return null;
  }

  if (request.payload.kind !== "GOTO") return null;

  const config = await loadSafetyEnvelope(observatory.id);
  const site = siteOf(observatory);

  const horizontal = horizontalAirlessOf(request.payload.coordinates, now, site);
  const verdict = evaluatePointing({
    config,
    site,
    at: now,
    altitudeDegrees: horizontal.altitudeDegrees,
    azimuthDegrees: horizontal.azimuthDegrees,
    // No override flag is passed, and there is no parameter here that could carry
    // one. `evaluatePointing`'s operator override reaches the daylight lock only;
    // the Sun exclusion is above it and is unreachable from any caller.
  });

  if (verdict.permitted) return null;

  return {
    ok: false,
    status: 409,
    code: "SAFETY_REFUSED",
    message: verdict.detail,
    details: { rejectionReason: verdict.reason },
  };
}

/**
 * Why a mission-less override is refused rather than implemented.
 *
 * `OperatorOverrideRequest.missionId` is nullable and documented as "null for a
 * standalone maintenance action outside any mission". But `CommandEnvelope`
 * requires `missionId` and `sessionId`, both non-null, and the agent independently
 * "rejects if missionId is not the mission the agent currently holds" and "rejects
 * if sessionId is not the current session owner". `ObservatoryCommand` requires
 * both columns too.
 *
 * So there is no envelope a standalone override could produce that the agent would
 * accept, and no row it could be written to. That is a contract conflict, not an
 * implementation gap, and `CLAUDE.md` says to report one rather than resolve it
 * quietly -- inventing a sentinel mission or a fake session to fill the fields
 * would be exactly the fabrication the two-validation design exists to prevent.
 *
 * The operator is not left without a way to stop a mount. A mission-scoped PARK
 * covers the case that matters, because a mount only moves while a mission is
 * live; outside one it is parked, and the watchdog parks it again if it is not.
 */
function standaloneOverrideIsNotBuildable(): OverrideFailure {
  return {
    ok: false,
    status: 422,
    code: "VALIDATION_FAILED",
    message:
      "A standalone override needs a CommandEnvelope with no missionId or " +
      "sessionId, which the contract does not define and the agent would refuse. " +
      "Name the mission to override.",
    details: { contractConflict: "OperatorOverrideRequest.missionId vs CommandEnvelope" },
  };
}
