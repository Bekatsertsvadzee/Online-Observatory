import type { AgentRelay } from "@/link/agent-relay";
import type { LinkStore } from "@/link/store";
import type { MissionBroadcast } from "@/mission/broadcast";

/**
 * ADR-079's two end-of-session sweeps, run beside ADR-018 §4's no-show sweep.
 *
 * 1. A live booked mission past its slot's end is told so: CloudSessionUpdate with a
 *    null session and `endReason: SLOT_ENDED`, once. The agent finishes, flushes any
 *    capture and parks on its own; it does the same on its own clock if this never
 *    reaches it. No PARK is minted.
 * 2. A mission that ended more than END_TELEMETRY_SECONDS ago without the mount
 *    reporting parked has its session ended anyway, with `parked: false`, so the
 *    customer still gets MISSION_SESSION_ENDED and the summary email.
 */
export async function sweepSessionEnds(input: {
  store: LinkStore;
  relay: Pick<AgentRelay, "relaySessionEnded">;
  broadcast: Pick<MissionBroadcast, "sessionEnded">;
  now: Date;
}): Promise<{ slotsEnded: number; sessionsEnded: number }> {
  const { store, relay, broadcast, now } = input;

  const slots = await store.claimEndedSlots(now);
  for (const slot of slots) {
    relay.relaySessionEnded(slot.observatoryId, slot.missionId, "SLOT_ENDED");
  }

  let sessionsEnded = 0;
  for (const missionId of await store.overdueSessionEnds(now)) {
    const ended = await store.endMissionSession({ missionId, parked: false, now });
    if (!ended) continue;
    broadcast.sessionEnded(ended);
    sessionsEnded += 1;
  }

  return { slotsEnded: slots.length, sessionsEnded };
}
