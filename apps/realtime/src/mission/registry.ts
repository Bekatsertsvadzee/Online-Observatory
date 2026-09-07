import type { MissionChannelMessage } from "@darkview/contracts";

import type { MissionChannel } from "@/mission/channel";

/**
 * Who is watching which mission.
 *
 * A **set** per mission from the first commit, not one channel per mission that a
 * later task widens. Architecture section 7: the Observer Pack fans out in the
 * cloud and the agent never learns an observer exists, so the fan-out is where
 * observers arrive (DV-103) -- and the backlog is explicit that retrofitting that
 * shape later is a rewrite rather than an edit. A single-subscriber map would have
 * to be one.
 *
 * This is the opposite rule from `AgentLinkRegistry`, which admits exactly one
 * link per observatory. One telescope may only be driven by one agent; one mission
 * may be watched by many people. The asymmetry is deliberate: it is the difference
 * between a command path and a view.
 */
export class MissionChannelRegistry {
  private readonly channels = new Map<string, Set<MissionChannel>>();

  add(missionId: string, channel: MissionChannel): void {
    const existing = this.channels.get(missionId);
    if (existing) {
      existing.add(channel);
      return;
    }
    this.channels.set(missionId, new Set([channel]));
  }

  remove(missionId: string, channel: MissionChannel): void {
    const existing = this.channels.get(missionId);
    if (!existing) return;

    existing.delete(channel);
    // The empty set is dropped rather than kept. Missions are created constantly
    // and never reused, so a map that only ever grows is a leak in a process
    // designed to run for months.
    if (existing.size === 0) this.channels.delete(missionId);
  }

  subscribers(missionId: string): MissionChannel[] {
    return [...(this.channels.get(missionId) ?? [])];
  }

  /**
   * Send one message to everyone watching a mission. Returns how many received it.
   *
   * Iterates a copy, because `dispatch` on a dead socket can close it and a close
   * handler removes the channel from this set. Mutating a set mid-iteration would
   * silently skip whichever subscriber happened to follow it.
   */
  broadcast(missionId: string, message: MissionChannelMessage): number {
    let delivered = 0;
    for (const channel of this.subscribers(missionId)) {
      if (channel.dispatch(message)) delivered += 1;
    }
    return delivered;
  }

  /** Close every channel that has gone silent past the grace period. */
  expireSilent(at: number): number {
    let expired = 0;

    for (const [missionId, channels] of [...this.channels]) {
      for (const channel of [...channels]) {
        if (!channel.isExpired(at)) continue;
        channel.terminate("idle");
        this.remove(missionId, channel);
        expired += 1;
      }
    }

    return expired;
  }

  get size(): number {
    let total = 0;
    for (const channels of this.channels.values()) total += channels.size;
    return total;
  }
}
