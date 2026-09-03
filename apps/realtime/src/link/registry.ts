import type { AgentLink } from "@/link/agent-link";

export type AdmitResult =
  | { admitted: true }
  | { admitted: false; reason: "already-connected" };

/**
 * Which observatory is connected, and the guarantee that it is only connected once.
 *
 * `CLAUDE.md`: one active mission at a time, one active session owner at a time.
 * That is only meaningful if one observatory means one link. Two agents claiming
 * the same observatory would each believe they held it, and commands would be
 * split between them.
 *
 * The *incumbent* wins. A second connection is refused and the existing one is
 * left untouched. The alternative -- letting the newcomer evict the incumbent --
 * would mean anyone replaying a captured token could silently take the telescope
 * away from the agent currently running a mission on it.
 */
export class AgentLinkRegistry {
  private readonly links = new Map<string, AgentLink>();

  admit(observatoryId: string, link: AgentLink): AdmitResult {
    if (this.links.has(observatoryId)) {
      return { admitted: false, reason: "already-connected" };
    }
    this.links.set(observatoryId, link);
    return { admitted: true };
  }

  /** Only removes the link if it is still the one registered. */
  release(observatoryId: string, link: AgentLink): void {
    if (this.links.get(observatoryId) === link) {
      this.links.delete(observatoryId);
    }
  }

  get(observatoryId: string): AgentLink | undefined {
    return this.links.get(observatoryId);
  }

  get size(): number {
    return this.links.size;
  }

  /**
   * Close every link that has gone silent past the grace period and mark its
   * observatory as having lost the link. Driven by a timer in the server; called
   * directly with an explicit instant in tests.
   */
  async expireSilent(at: number): Promise<string[]> {
    const expired: string[] = [];

    for (const [observatoryId, link] of [...this.links]) {
      if (!link.isExpired(at)) continue;
      await link.expire();
      this.links.delete(observatoryId);
      expired.push(observatoryId);
    }

    return expired;
  }
}
