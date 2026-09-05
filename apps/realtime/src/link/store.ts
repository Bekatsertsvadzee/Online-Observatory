import type { ObservatoryCommandStatus } from "@darkview/db/enums";

import type {
  CommandAcceptanceStatus,
  CommandEnvelope,
  CommandRejectionReason,
  MissionFailureReason,
  MissionState,
  ObservatoryMode,
} from "@darkview/contracts";

/**
 * The mission states during which a session may command the mount.
 *
 * The same list as `LIVE_MISSION_STATES` in the API's mission orchestrator and as
 * the predicate of Mission_active_per_observatory_unique. Duplicated across the
 * two services rather than imported, because this service does not depend on the
 * Next.js app; if one changes, all three change. Inside this service there is one
 * copy, here, and both store implementations use it.
 */
export const LIVE_MISSION_STATES = [
  "PREPARING",
  "SLEWING",
  "VERIFYING",
  "CENTERING",
  "OBSERVING",
  "CAPTURING",
] as const;

/**
 * The states a mission never leaves.
 *
 * `CLAUDE.md` also lists WEATHER_HOLD, NOT_VISIBLE and HARDWARE_ERROR as failure
 * or hold states, and they are deliberately absent: a hold can be lifted and a
 * hardware fault can be cleared by an operator, so a later transition out of one
 * is legitimate. These three are the ones nothing may transition out of.
 */
export const TERMINAL_MISSION_STATES = ["COMPLETE", "CANCELLED", "FAILED"] as const;

/** The command statuses a later ack must not overwrite. */
export const TERMINAL_COMMAND_STATUSES = [
  "COMPLETED",
  "REJECTED",
  "EXPIRED",
  "FAILED",
] as const;

/**
 * The agent's verdict, as a row status.
 *
 * DUPLICATE maps to nothing on purpose. It means the agent had already seen this
 * commandId, so the verdict that matters arrived with the original ack; writing
 * this one would replace the record of what actually happened with "I have seen
 * this before".
 */
export const COMMAND_STATUS_FOR: Record<
  CommandAcceptanceStatus,
  ObservatoryCommandStatus | null
> = {
  ACCEPTED: "EXECUTING",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  DUPLICATE: null,
};

export function isTerminalCommandStatus(status: ObservatoryCommandStatus): boolean {
  return (TERMINAL_COMMAND_STATUSES as readonly string[]).includes(status);
}

/**
 * Everything the agent link needs from storage, and nothing else.
 *
 * The link's rules -- one connection per observatory, heartbeat expiry, replay
 * that does not duplicate -- are the part that is hard to get right and the part
 * worth testing exhaustively. Keeping them behind this interface means those
 * tests run against an in-memory fake in CI, which has no database, while the
 * process uses the Prisma implementation.
 */
export interface LinkStore {
  /**
   * Resolve a presented device token to the observatory that owns it.
   * Takes the SHA-256 of the token, never the token: nothing below this line
   * has any reason to see the credential itself.
   */
  findObservatoryByTokenHash(tokenHash: string): Promise<ObservatoryRecord | null>;

  /**
   * Record an accepted inbound message.
   * Returns false if this messageId has been seen before, which is the agent
   * replaying its queue after an outage -- expected, not an error.
   */
  recordInboundMessage(message: InboundMessageRecord): Promise<boolean>;

  markLinkUp(observatoryId: string): Promise<void>;
  markLinkLost(observatoryId: string, at: Date): Promise<void>;

  /** One minted command, by its commandId. Null when it is gone or not ours. */
  loadCommand(commandId: string): Promise<RelayableCommand | null>;

  /**
   * Commands written but never put on the wire.
   *
   * ADR-009's fallback: `NOTIFY` is not delivered to a listener that was
   * disconnected at that instant, so the row -- which is the source of truth --
   * is swept for. Expired commands are excluded; the agent would refuse them and
   * relaying one would only produce a confusing ack.
   */
  pendingCommands(observatoryId: string, now: Date): Promise<RelayableCommand[]>;

  markCommandRelayed(commandId: string, at: Date): Promise<void>;

  /**
   * One session by id, or null when it is gone, revoked or lapsed.
   *
   * ADR-009 again: the notification is a wake-up and the row is the truth. A
   * session revoked between the NOTIFY and this read must reach the agent as a
   * revocation, not as the grant the notification was written for.
   */
  loadSession(sessionId: string): Promise<ActiveSession | null>;

  /**
   * Whoever owns this observatory's live mission right now.
   *
   * Re-sent on reconnect. The agent holds ownership in memory, so an agent that
   * restarted or dropped its link has forgotten who owns it, and would refuse
   * every command until the customer noticed and reopened their session.
   */
  activeSession(observatoryId: string, now: Date): Promise<ActiveSession | null>;

  /**
   * Apply one AGENT_MISSION_EVENT.
   *
   * The agent runs the mission state machine; this is where its transitions reach
   * the database. Without it `Mission.state` is written once, at creation, and
   * never again -- and a mission that never leaves a live state occupies
   * Mission_active_per_observatory_unique forever, refusing every later mission at
   * that observatory.
   *
   * Scoped by the reporting observatory. The agent is authenticated as one
   * observatory and must not be able to move another's mission.
   */
  applyMissionEvent(event: MissionEventRecord): Promise<MissionEventOutcome>;

  /**
   * Close out the mission an agent came back holding.
   *
   * DV-027: an agent that restarts mid-observation recovers the mission id from
   * its local state store, parks the mount because it has lost the state
   * machine's progress, and reports the id in `AgentHello.resumeMissionId`. The
   * mount is already safe by the time this runs; what is left is the bookkeeping
   * the observatory cannot run another mission without.
   */
  resolveResumedMission(input: {
    observatoryId: string;
    missionId: string;
    now: Date;
  }): Promise<ResumeOutcome>;

  /**
   * Record the agent's verdict on one command.
   *
   * The agent decides every command independently of the cloud, and a REJECTED
   * ack carrying a SAFETY_ reason after the cloud approved the command is the
   * two-validation design working. That refusal must not exist only on the
   * observatory's disk: `docs/security.md` calls for a server-side command audit.
   */
  recordCommandVerdict(verdict: CommandVerdictRecord): Promise<CommandVerdictOutcome>;

  /**
   * The mission the cloud believes this observatory is running, if any.
   *
   * Answers `CloudWelcome.expectedMissionId`. Deliberately not derived from
   * `activeSession`: a mission in PREPARING that nobody has opened a session on
   * is still a mission the agent should be holding.
   */
  liveMissionId(observatoryId: string): Promise<string | null>;
}

/** A state transition the agent reported, as it reported it. */
export type MissionEventRecord = {
  /** The observatory the reporting agent authenticated as. Scopes the write. */
  observatoryId: string;
  missionId: string;
  state: MissionState;
  failureReason: MissionFailureReason | null;
  /**
   * The observatory clock, carried through unchanged. The contract is explicit
   * that it is "replayed unchanged after a reconnect; never rewritten to look
   * contemporaneous" -- a twenty-minute outage must not produce an audit trail
   * claiming everything happened at once.
   */
  occurredAt: Date;
  detail: string | null;
};

/**
 * - `APPLIED` -- the event was written and the mission moved.
 * - `RECORDED` -- the event was written and the mission did not move, because it
 *   had already reached a terminal state. A `COMPLETE` arriving after the agent
 *   reported `FAILED` is an ordering artefact of a link that does not guarantee
 *   order, not an instruction to revive the mission.
 */
export type MissionEventOutcome =
  "APPLIED" | "RECORDED" | "WRONG_OBSERVATORY" | "NOT_FOUND";

/**
 * - `RESOLVED` -- a live mission was failed and its session revoked.
 * - `NOT_LIVE` -- nothing to do. The agent may report the same id twice if it
 *   restarted again before reaching the cloud, and that is not an error.
 */
export type ResumeOutcome = "RESOLVED" | "NOT_LIVE" | "WRONG_OBSERVATORY" | "NOT_FOUND";

export type CommandVerdictRecord = {
  /** The observatory the reporting agent authenticated as. Scopes the write. */
  observatoryId: string;
  commandId: string;
  status: CommandAcceptanceStatus;
  rejectionReason: CommandRejectionReason | null;
  detail: string | null;
  /**
   * When the agent decided, on the agent's clock -- the ack's `sentAt`. Same rule
   * as `MissionEventRecord.occurredAt`: the observatory's account of when it acted
   * is never replaced with the moment the cloud happened to hear about it.
   */
  decidedAt: Date;
};

/**
 * - `RECORDED` -- the verdict is on the row.
 * - `DUPLICATE_ACK` -- the agent said it had already seen this commandId. That
 *   says nothing new about the command's fate, so the row is left exactly as the
 *   original ack left it; the message itself is still in `AgentMessage`.
 * - `IGNORED_STALE` -- the row had already reached a terminal status. A late ack
 *   does not overwrite the record of what actually happened.
 */
export type CommandVerdictOutcome =
  "RECORDED" | "DUPLICATE_ACK" | "IGNORED_STALE" | "WRONG_OBSERVATORY" | "NOT_FOUND";

export type ActiveSession = {
  sessionId: string;
  missionId: string;
  userId: string;
  expiresAt: Date;
};

export type RelayableCommand = {
  observatoryId: string;
  envelope: CommandEnvelope;
};

export type ObservatoryRecord = {
  id: string;
  slug: string;
  mode: ObservatoryMode;
};

export type InboundMessageRecord = {
  messageId: string;
  observatoryId: string;
  type: string;
  sentAt: Date;
};
