import type { CaptureAssetKind, ObservatoryCommandStatus } from "@darkview/db/enums";

import type {
  AgentPosture,
  Capture,
  DisarmReason,
  ImagingProfile,
  NetworkNodeApprovalStatus,
  OpticalConfig,
  SafetyEnvelopeConfig,
  CommandAcceptanceStatus,
  CommandEnvelope,
  CommandRejectionReason,
  MissionFailureReason,
  MissionState,
  ObservatoryMode,
  WeatherState,
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
 * `docs/ENGINEERING.md` also lists WEATHER_HOLD, NOT_VISIBLE and HARDWARE_ERROR as failure
 * or hold states, and they are deliberately absent: a hold can be lifted and a
 * hardware fault can be cleared by an operator, so a later transition out of one
 * is legitimate. These three are the ones nothing may transition out of.
 */
export const TERMINAL_MISSION_STATES = ["COMPLETE", "CANCELLED", "FAILED"] as const;

/**
 * The states that are already an answer about why an observation did not happen.
 *
 * They are not terminal -- a hold can be lifted and a fault can be cleared -- but
 * they are not overwritten by a later, vaguer ending either. `refunds/
 * entitlements.ts` classifies a weather refund from exactly this state and its
 * failureReason, so an agent that parks for weather and then reports the park as
 * an operator abort must not be able to turn the customer's refund into a
 * different kind of refund on the way past.
 */
export const HOLD_MISSION_STATES = [
  "WEATHER_HOLD",
  "NOT_VISIBLE",
  "HARDWARE_ERROR",
] as const;

/**
 * Which state an agent-reported mission event may arrive from.
 *
 * The cloud's mission row is written from a message an observatory sent. Until
 * this table existed the only question asked of that message was whether the
 * mission had already finished, so an agent -- buggy, replaying, or hostile --
 * could walk a live mission back to SCHEDULED, jump it from PREPARING straight
 * to COMPLETE, or lift its own weather hold and carry on observing.
 *
 * The table is the agent's own state machine, read off
 * `agent/darkview_agent/mission/runner.py`, and nothing else is legal. Two
 * entries are deliberately empty: REQUESTED and SCHEDULED are the cloud's own
 * states, before the observatory has been told anything, and no observatory has
 * standing to report them.
 *
 * A state may always be re-reported -- a retried event is the ordinary case, and
 * refusing it would turn a lost ack into a lost mission.
 */
const LEGAL_PREDECESSORS: Record<MissionState, readonly MissionState[]> = {
  REQUESTED: [],
  SCHEDULED: [],
  // A hold that lifts starts the mission again from the top.
  PREPARING: ["SCHEDULED", ...HOLD_MISSION_STATES],
  // Re-entered from CENTERING: a corrected position is slewed to again.
  SLEWING: ["PREPARING", "CENTERING"],
  VERIFYING: ["SLEWING"],
  CENTERING: ["VERIFYING"],
  OBSERVING: ["VERIFYING"],
  CAPTURING: ["OBSERVING"],
  PROCESSING: ["CAPTURING"],
  COMPLETE: ["PROCESSING"],
  // An observation can stop at any point up to the moment it is finished, and a
  // hold is an ending in its own right -- it is not replaced by a later one.
  WEATHER_HOLD: [...LIVE_MISSION_STATES, "SCHEDULED"],
  NOT_VISIBLE: [...LIVE_MISSION_STATES, "SCHEDULED"],
  HARDWARE_ERROR: [...LIVE_MISSION_STATES, "SCHEDULED"],
  CANCELLED: [...LIVE_MISSION_STATES, "SCHEDULED", "PROCESSING"],
  FAILED: [...LIVE_MISSION_STATES, "SCHEDULED", "PROCESSING"],
};

/**
 * Every state this event may be applied from, including the state itself.
 *
 * Shaped as a list because the Prisma store puts it straight into the WHERE
 * clause of a single guarded UPDATE: the check and the write have to be one
 * statement, or two events racing each other both pass a read-then-write.
 */
export function legalPredecessorsOf(to: MissionState): MissionState[] {
  return [to, ...LEGAL_PREDECESSORS[to]];
}

/** Whether an agent may move a mission from `from` to `to`. */
export function isLegalMissionTransition(from: MissionState, to: MissionState): boolean {
  return legalPredecessorsOf(to).includes(from);
}

/**
 * Command statuses that mean the agent never started the mission.
 *
 * REJECTED was handled from the beginning; EXPIRED and FAILED were not, and they
 * end the same way -- the starting GOTO did not run. A mission left in PREPARING
 * by one of them holds the observatory against every later booking while nobody
 * is flying it.
 */
export const START_NOT_RUN_STATUSES = ["REJECTED", "EXPIRED", "FAILED"] as const;

/**
 * Is this the GOTO that starts a mission, rather than a recentring one?
 *
 * ADR-018 mints it with `recenter: false`; RECENTER mints `recenter: true`. Both
 * stores read this rather than restating it.
 */
export function isStartingGoto(type: string, payload: unknown): boolean {
  if (type !== "GOTO" || typeof payload !== "object" || payload === null) return false;
  const goto = payload as { kind?: unknown; recenter?: unknown };
  return goto.kind === "GOTO" && goto.recenter !== true;
}

/**
 * What a refused start is filed as. A SAFETY_ refusal is the agent's envelope saying
 * no, which the contract names SAFETY_REFUSED; anything else has no failure reason
 * that would not be a guess, and the command row keeps the agent's own words.
 */
export function failureReasonForRefusedStart(
  rejectionReason: CommandRejectionReason | null,
): MissionFailureReason | null {
  return rejectionReason?.startsWith("SAFETY_") ? "SAFETY_REFUSED" : null;
}

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
/**
 * What the agent reported about one finished capture.
 *
 * Storage keys, never URLs. The agent writes objects; the cloud signs a
 * short-expiry URL at request time, and a public bucket path is never stored,
 * relayed, or returned.
 */
export type CaptureRecord = {
  observatoryId: string;
  missionId: string;
  /** The CAPTURE command this came from. Also the idempotency key. */
  commandId: string;
  capturedAt: Date;
  imagingProfile: ImagingProfile;
  opticalConfig: OpticalConfig;
  exposureMilliseconds: number;
  gain: number;
  framesStacked: number;
  integrationSeconds: number;
  widthPx: number | null;
  heightPx: number | null;
  solvedFocalLengthMm: number | null;
  assets: { kind: CaptureAssetKind; storageKey: string }[];
};

export type CaptureOutcome =
  /** Written, and the customer has not been told yet. */
  | { outcome: "RECORDED"; capture: Capture }
  /** Already written. The agent re-sent it; nothing changed and nobody is re-told. */
  | { outcome: "DUPLICATE" }
  | { outcome: "NOT_FOUND" }
  | { outcome: "WRONG_OBSERVATORY" };

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

  /**
   * Record the posture the agent reported (ADR-024), with an audit row.
   *
   * Called only when it differs from what this link last recorded, so a heartbeat
   * every five seconds does not become a write every five seconds.
   */
  recordPosture(input: {
    observatoryId: string;
    posture: AgentPosture;
    disarmReason: DisarmReason | null;
  }): Promise<void>;

  /**
   * The observatory's network node approval status, for CLOUD_OPERATING_UPDATE.
   *
   * DRAFT when the observatory has no node: no node is no approval, and the agent
   * reads anything but APPROVED as a reason to disarm.
   */
  loadApprovalStatus(observatoryId: string): Promise<NetworkNodeApprovalStatus>;

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
   * ADR-018 §4: close every booked mission nobody started before its slot ended.
   *
   * CANCELLED with SESSION_EXPIRED, a CLOUD event and a MISSION_NOT_STARTED audit
   * row. The booking is left CONFIRMED -- the money is the refund engine's. Returns
   * the ids closed. Commands nothing: a mission that never started holds no mount.
   */
  closeUnstartedMissions(now: Date): Promise<string[]>;

  /**
   * Record the agent's verdict on one command.
   *
   * ADR-018 §3: a REJECTED verdict on the GOTO that started a mission, while that
   * mission is still PREPARING, also fails the mission and revokes its session, so a
   * start the observatory refused cannot hold Mission_active_per_observatory_unique.
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

  /**
   * Does this observatory own this mission?
   *
   * The scoping check for the one inbound message that carries a missionId and is
   * not written through a store method that scopes it already. `applyMissionEvent`
   * and `recordCommandVerdict` both take the reporting observatory and answer
   * WRONG_OBSERVATORY; a telemetry delta is relayed, not written, so it needs this.
   */
  observatoryOwnsMission(observatoryId: string, missionId: string): Promise<boolean>;

  /**
   * The stored safety envelope for this observatory, or null when none exists.
   *
   * Null and an envelope whose `maxAltitudeDegrees` is null mean the same thing to
   * the agent: UNMEASURED, refuse every slew. There is no permissive default and
   * this must never invent one.
   */
  loadSafetyEnvelope(observatoryId: string): Promise<SafetyEnvelopeConfig | null>;

  /**
   * The operator's stored weather for this observatory, or null when no row
   * exists.
   *
   * Null is not "the sky is clear". It is "nobody has said", and the agent is
   * left holding whatever it already had -- which after a restart is whatever it
   * recovered from its own store.
   */
  loadWeather(observatoryId: string): Promise<WeatherState | null>;

  /**
   * Record one finished capture and put it in its owner's Collection.
   *
   * Scoped by the reporting observatory, and by the command: the commandId is the
   * idempotency key, so an agent must not be able to attach a capture to a command
   * that is not this observatory's, on this mission. Doing so would let one
   * observatory occupy another's row in `Capture_command_unique`.
   *
   * The owner is the mission's own user and nobody else. ADR-007: an observer
   * receives mission state and the live view and nothing else -- "nothing from this
   * mission enters the observer's Collection".
   */
  recordCapture(capture: CaptureRecord): Promise<CaptureOutcome>;
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
  /**
   * The command that caused the transition, when one did.
   *
   * AgentMissionEvent has carried this since the contract was written and the
   * cloud discarded it until DV-062, which left the trail chronological but not
   * correlated: nothing recorded which nudge produced which CENTERING.
   */
  commandId: string | null;
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
