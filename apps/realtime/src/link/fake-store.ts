import type {
  ActiveSession,
  InboundMessageRecord,
  LinkStore,
  ObservatoryRecord,
  RelayableCommand,
} from "@/link/store";

/**
 * In-memory LinkStore for tests. CI has no database, and the rules worth proving
 * here -- refusal, expiry, replay -- are about the link, not about SQL.
 */
export class FakeLinkStore implements LinkStore {
  readonly recorded: InboundMessageRecord[] = [];
  readonly linkUp: string[] = [];
  readonly linkLost: { observatoryId: string; at: Date }[] = [];

  readonly relayed = new Map<string, Date>();

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
}
