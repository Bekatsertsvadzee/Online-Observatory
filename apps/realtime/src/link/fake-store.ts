import type { ObservatoryCommandStatus } from "@darkview/db/enums";

import type {
  MissionEventSource,
  MissionFailureReason,
  MissionState,
  ObservatoryMode,
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
  source: MissionEventSource;
  message: string | null;
  occurredAt: Date;
  simulated: boolean;
  isDemo: boolean;
};

export type FakeCommandVerdict = {
  status: string;
  rejectionReason: string | null;
  detail: string | null;
  decidedAt: Date;
};

/**
 * In-memory LinkStore for tests. CI has no database, and the rules worth proving
 * here -- refusal, expiry, replay -- are about the link, not about SQL.
 */
export class FakeLinkStore implements LinkStore {
  readonly recorded: InboundMessageRecord[] = [];
  readonly linkUp: string[] = [];
  readonly linkLost: { observatoryId: string; at: Date }[] = [];

  readonly relayed = new Map<string, Date>();
  readonly missions = new Map<string, FakeMission>();
  readonly missionEvents: FakeMissionEvent[] = [];
  readonly revoked: { sessionId: string; reason: string }[] = [];
  readonly completedAt = new Map<string, Date>();

  private readonly commandStatuses = new Map<string, ObservatoryCommandStatus>();
  private readonly verdicts = new Map<string, FakeCommandVerdict>();

  private readonly observatories = new Map<string, ObservatoryRecord>();
  private readonly seen = new Set<string>();
  private readonly commands = new Map<string, RelayableCommand>();
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly observatoryOf = new Map<string, string>();

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
  }

  async markLinkLost(observatoryId: string, at: Date) {
    this.linkLost.push({ observatoryId, at });
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

  async applyMissionEvent(event: MissionEventRecord): Promise<MissionEventOutcome> {
    const mission = this.missions.get(event.missionId);
    if (!mission) return "NOT_FOUND";
    if (mission.observatoryId !== event.observatoryId) return "WRONG_OBSERVATORY";

    this.missionEvents.push({
      missionId: event.missionId,
      state: event.state,
      source: "AGENT",
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
      source: "CLOUD",
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
    return "RECORDED";
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
