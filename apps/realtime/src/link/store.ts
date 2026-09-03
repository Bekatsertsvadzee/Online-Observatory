import type { ObservatoryMode } from "@darkview/contracts";

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
}

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
