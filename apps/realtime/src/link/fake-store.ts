import type { ObservatoryCommandStatus } from "@darkview/db/enums";

import type {
  MissionEventSource,
  MissionFailureReason,
  MissionState,
  ObservatoryMode,
  SafetyEnvelopeConfig,
} from "@darkview/contracts";

import {
  COMMAND_STATUS_FOR,
  LIVE_MISSION_STATES,
  TERMINAL_MISSION_STATES,
  isTerminalCommandStatus,
  type ActiveSession,
  type CommandVerdictOutcome,
  type CommandVerdictRecord,
  type InboundMessageRecord,
  type LinkStore,
  type MissionEventOutcome,
  type MissionEventRecord,
  type ObservatoryRecord,
  type RelayableCommand,
  type ResumeOutcome,
} from "@/link/store";
import type { ChannelUser, MissionChannelStore, MissionSnapshot } from "@/mission/store";

export type FakeMission = {
  observatoryId: string;
  state: MissionState;
  failureReason: MissionFailureReason | null;
  mode: ObservatoryMode;
  isDemo: boolean;
};

export type FakeMissionEvent = {
  missionId: string;
  state: MissionState;
  failureReason: MissionFailureReason | null;
  source: MissionEventSource;
  commandId: string | null;
  message: string | null;
  occurredAt: Date;
  simulated: boolean;
  isDemo: boolean;
};

/**
 * An audit row, as the fake keeps it.
 *
 * The fake records them so that "the link going down is written down" can be
 * asserted in CI, which has no database. Without this the only proof would be a
 * line of code, and issues #25 and #27 are what happens when a line of code is
 * the proof.
 */
export type FakeAuditEvent = {
  category: string;
  action: string;
  missionId: string | null;
  commandId: string | null;
  entityId: string | null;
  detail: Record<string, unknown> | null;
};

export type FakeCommandVerdict = {
  status: string;
  rejectionReason: string | null;
  detail: string | null;
  decidedAt: Date;
};

/**
 * In-memory store for tests, covering both channels. CI has no database, and the
 * rules worth proving here -- refusal, expiry, replay, who may watch what -- are
 * about the channels, not about SQL.
 */
export class FakeLinkStore implements LinkStore, MissionChannelStore {
  readonly recorded: InboundMessageRecord[] = [];
  readonly linkUp: string[] = [];
  readonly linkLost: { observatoryId: string; at: Date }[] = [];

  readonly relayed = new Map<string, Date>();
  readonly missions = new Map<string, FakeMission>();
  readonly missionEvents: FakeMissionEvent[] = [];
  readonly auditEvents: FakeAuditEvent[] = [];
  readonly revoked: { sessionId: string; reason: string }[] = [];
  readonly completedAt = new Map<string, Date>();

  private readonly envelopes = new Map<string, SafetyEnvelopeConfig>();
  private readonly commandStatuses = new Map<string, ObservatoryCommandStatus>();
  private readonly verdicts = new Map<string, FakeCommandVerdict>();

  private readonly observatories = new Map<string, ObservatoryRecord>();
  private readonly seen = new Set<string>();
  private readonly commands = new Map<string, RelayableCommand>();
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly observatoryOf = new Map<string, string>();
  private readonly userSessions = new Map<
    string,
    { user: ChannelUser; expiresAt: Date }
  >();

  registerToken(tokenHash: string, observatory: ObservatoryRecord) {
    this.observatories.set(tokenHash, observatory);
  }

  async findObservatoryByTokenHash(tokenHash: string) {
    return this.observatories.get(tokenHash) ?? null;
  }

  async recordInboundMessage(message: InboundMessageRecord) {
    if (this.seen.has(message.messageId)) return false;
    this.seen.add(message.messageId);
    this.recorded.push(message);
    return true;
  }

  async markLinkUp(observatoryId: string) {
    this.linkUp.push(observatoryId);
    this.audit("AGENT_LINK", "AGENT_LINK_UP", { entityId: observatoryId });
  }

  async markLinkLost(observatoryId: string, at: Date) {
    this.linkLost.push({ observatoryId, at });
    this.audit("AGENT_LINK", "AGENT_LINK_LOST", {
      entityId: observatoryId,
      detail: { lostAt: at.toISOString() },
    });
  }

  private audit(
    category: string,
    action: string,
    fields: Partial<Omit<FakeAuditEvent, "category" | "action">> = {},
  ) {
    this.auditEvents.push({
      category,
      action,
      missionId: fields.missionId ?? null,
      commandId: fields.commandId ?? null,
      entityId: fields.entityId ?? null,
      detail: fields.detail ?? null,
    });
  }

  addCommand(command: RelayableCommand) {
    this.commands.set(command.envelope.commandId, command);
  }

  /** Put a live session in the store, owned by `observatoryId`. */
  setActiveSession(observatoryId: string, session: ActiveSession) {
    this.sessions.set(session.sessionId, session);
    this.observatoryOf.set(session.sessionId, observatoryId);
  }

  revokeSession(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  async loadCommand(commandId: string) {
    return this.commands.get(commandId) ?? null;
  }

  async pendingCommands(observatoryId: string, now: Date) {
    return [...this.commands.values()].filter(
      (command) =>
        command.observatoryId === observatoryId &&
        !this.relayed.has(command.envelope.commandId) &&
        Date.parse(command.envelope.expiresAt) > now.getTime(),
    );
  }

  async markCommandRelayed(commandId: string, at: Date) {
    this.relayed.set(commandId, at);
    this.commandStatuses.set(commandId, "EXECUTING");
  }

  async loadSession(sessionId: string) {
    return this.sessions.get(sessionId) ?? null;
  }

  async activeSession(observatoryId: string, now: Date) {
    for (const session of this.sessions.values()) {
      if (
        this.observatoryOf.get(session.sessionId) === observatoryId &&
        session.expiresAt > now
      ) {
        return session;
      }
    }
    return null;
  }

  /**
   * The rules below deliberately mirror `createPrismaStore` line for line, and
   * share its decision tables rather than restating them. A fake that decided for
   * itself which transitions were legal could pass every test while the store the
   * telescope actually runs against was wrong.
   */
  addMission(
    missionId: string,
    mission: Partial<FakeMission> & { observatoryId: string },
  ) {
    this.missions.set(missionId, {
      state: "OBSERVING",
      failureReason: null,
      mode: "SIMULATED",
      isDemo: false,
      ...mission,
    });
  }

  mission(missionId: string): FakeMission | undefined {
    return this.missions.get(missionId);
  }

  commandStatusOf(commandId: string): ObservatoryCommandStatus {
    return this.commandStatuses.get(commandId) ?? "RECEIVED";
  }

  verdictOf(commandId: string): FakeCommandVerdict | undefined {
    return this.verdicts.get(commandId);
  }

  /** Put a signed-in browser session in the store, as the API's cookie would present it. */
  registerUserSession(tokenHash: string, user: ChannelUser, expiresAt: Date) {
    this.userSessions.set(tokenHash, { user, expiresAt });
  }

  async findUserBySessionTokenHash(tokenHash: string, now: Date) {
    const found = this.userSessions.get(tokenHash);
    if (!found || found.expiresAt <= now) return null;
    return found.user;
  }

  async loadMissionSnapshot(missionId: string): Promise<MissionSnapshot | null> {
    const mission = this.missions.get(missionId);
    if (!mission) return null;
    return {
      missionId,
      state: mission.state,
      failureReason: mission.failureReason,
    };
  }

  async observatoryOwnsMission(observatoryId: string, missionId: string) {
    return this.missions.get(missionId)?.observatoryId === observatoryId;
  }

  async applyMissionEvent(event: MissionEventRecord): Promise<MissionEventOutcome> {
    const mission = this.missions.get(event.missionId);
    if (!mission) return "NOT_FOUND";
    if (mission.observatoryId !== event.observatoryId) return "WRONG_OBSERVATORY";

    this.missionEvents.push({
      missionId: event.missionId,
      state: event.state,
      failureReason: event.failureReason,
      source: "AGENT",
      // The same scoping the Prisma store applies: a correlation to a command
      // this cloud did not mint for this observatory is dropped, not written.
      commandId: this.commandOf(event.observatoryId, event.commandId),
      message: event.detail,
      occurredAt: event.occurredAt,
      simulated: mission.mode === "SIMULATED",
      isDemo: mission.isDemo,
    });

    if (isTerminal(mission.state)) return "RECORDED";

    mission.state = event.state;
    mission.failureReason = event.failureReason;
    return "APPLIED";
  }

  async resolveResumedMission(input: {
    observatoryId: string;
    missionId: string;
    now: Date;
  }): Promise<ResumeOutcome> {
    const mission = this.missions.get(input.missionId);
    if (!mission) return "NOT_FOUND";
    if (mission.observatoryId !== input.observatoryId) return "WRONG_OBSERVATORY";
    if (!isLive(mission.state)) return "NOT_LIVE";

    mission.state = "FAILED";
    mission.failureReason = "AGENT_LINK_LOST";

    this.missionEvents.push({
      missionId: input.missionId,
      state: "FAILED",
      failureReason: "AGENT_LINK_LOST",
      source: "CLOUD",
      commandId: null,
      message:
        "Agent restarted holding this mission. The mount parked locally and the cloud closed the mission out.",
      occurredAt: input.now,
      simulated: mission.mode === "SIMULATED",
      isDemo: mission.isDemo,
    });

    for (const session of [...this.sessions.values()]) {
      if (session.missionId !== input.missionId) continue;
      this.sessions.delete(session.sessionId);
      this.revoked.push({ sessionId: session.sessionId, reason: "AGENT_LINK_LOST" });
    }

    this.audit("MISSION", "MISSION_RESOLVED_AFTER_AGENT_RESTART", {
      missionId: input.missionId,
      entityId: input.observatoryId,
      detail: { failureReason: "AGENT_LINK_LOST" },
    });

    return "RESOLVED";
  }

  async recordCommandVerdict(
    verdict: CommandVerdictRecord,
  ): Promise<CommandVerdictOutcome> {
    const command = this.commands.get(verdict.commandId);
    if (!command) return "NOT_FOUND";
    if (command.observatoryId !== verdict.observatoryId) return "WRONG_OBSERVATORY";

    const status = COMMAND_STATUS_FOR[verdict.status];
    if (status === null) return "DUPLICATE_ACK";

    if (isTerminalCommandStatus(this.commandStatusOf(verdict.commandId))) {
      return "IGNORED_STALE";
    }

    this.commandStatuses.set(verdict.commandId, status);
    if (isTerminalCommandStatus(status)) {
      this.completedAt.set(verdict.commandId, verdict.decidedAt);
    }
    this.verdicts.set(verdict.commandId, {
      status: verdict.status,
      rejectionReason: verdict.rejectionReason,
      detail: verdict.detail,
      decidedAt: verdict.decidedAt,
    });

    this.audit("COMMAND", "COMMAND_VERDICT_RECORDED", {
      commandId: verdict.commandId,
      entityId: verdict.observatoryId,
      detail: {
        status: verdict.status,
        rejectionReason: verdict.rejectionReason,
        detail: verdict.detail,
        decidedAt: verdict.decidedAt.toISOString(),
      },
    });
    return "RECORDED";
  }

  /** The command id, if this observatory really owns a command by that id. */
  private commandOf(observatoryId: string, commandId: string | null): string | null {
    if (!commandId) return null;
    const command = this.commands.get(commandId);
    return command?.observatoryId === observatoryId ? commandId : null;
  }

  setSafetyEnvelope(observatoryId: string, envelope: SafetyEnvelopeConfig | null) {
    if (envelope === null) this.envelopes.delete(observatoryId);
    else this.envelopes.set(observatoryId, envelope);
  }

  async loadSafetyEnvelope(observatoryId: string): Promise<SafetyEnvelopeConfig | null> {
    return this.envelopes.get(observatoryId) ?? null;
  }

  async liveMissionId(observatoryId: string): Promise<string | null> {
    for (const [missionId, mission] of this.missions) {
      if (mission.observatoryId === observatoryId && isLive(mission.state)) {
        return missionId;
      }
    }
    return null;
  }
}

function isLive(state: MissionState): boolean {
  return (LIVE_MISSION_STATES as readonly string[]).includes(state);
}

function isTerminal(state: MissionState): boolean {
  return (TERMINAL_MISSION_STATES as readonly string[]).includes(state);
}
