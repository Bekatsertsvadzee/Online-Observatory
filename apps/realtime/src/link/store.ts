import type { CommandEnvelope, ObservatoryMode } from "@darkview/contracts";

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
}

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
