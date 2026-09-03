import type { InboundMessageRecord, LinkStore, ObservatoryRecord } from "@/link/store";

/**
 * In-memory LinkStore for tests. CI has no database, and the rules worth proving
 * here -- refusal, expiry, replay -- are about the link, not about SQL.
 */
export class FakeLinkStore implements LinkStore {
  readonly recorded: InboundMessageRecord[] = [];
  readonly linkUp: string[] = [];
  readonly linkLost: { observatoryId: string; at: Date }[] = [];

  private readonly observatories = new Map<string, ObservatoryRecord>();
  private readonly seen = new Set<string>();

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
}
