import type {
  MissionFailureReason,
  MissionState,
  UserRole,
} from "@darkview/contracts";

/**
 * Everything the mission client channel needs from storage, and nothing else.
 *
 * Separate from `LinkStore` because the two channels answer to different
 * credentials and different rules: the agent link authenticates a device token
 * and may move a mission, while this side authenticates a person and may only
 * watch one. Keeping the surfaces apart means no method that writes mission state
 * is even reachable from the code holding a customer's socket.
 *
 * The process supplies one object satisfying both -- see `RealtimeStore`.
 */
export interface MissionChannelStore {
  /**
   * Resolve a presented browser session cookie to its user.
   *
   * Takes the SHA-256 of the cookie value, never the value: the same rule as
   * `findObservatoryByTokenHash`. Returns null for an expired session, an
   * unknown token, or a user who has not verified their email -- the three
   * conditions `getCurrentSession` in the API refuses on.
   */
  findUserBySessionTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<ChannelUser | null>;

  /**
   * The mission's state right now.
   *
   * Sent to a client the moment it subscribes. Without it a customer who opens
   * the page mid-mission sees an empty panel until the agent's next transition,
   * which during OBSERVING can be minutes.
   */
  loadMissionSnapshot(missionId: string): Promise<MissionSnapshot | null>;

  /**
   * Does this person hold an observer seat on this mission, and is the mission
   * still open to observers?
   *
   * Both halves, in one answer, because either alone is not entitlement. A seat on
   * a session whose controller has since closed it is consent withdrawn (ADR-007
   * rule 5), and the contract's own words on `setMissionObservation` are that
   * closing "detaches any attached observers" -- so a stale seat must not readmit
   * anybody after the fact.
   *
   * Never grants command capability, and cannot: the cloud mints an envelope only
   * for the session owner, and the agent refuses any envelope whose sessionId is
   * not the owner it last received.
   */
  hasObserverSeat(missionId: string, userId: string): Promise<boolean>;

  /**
   * May this person watch this mission's live view right now?
   *
   * True for the holder of a live, unrevoked session on the mission -- the
   * controller -- and for anybody holding an observer seat on it. The same two
   * ways in that `MissionChannel.subscribe` admits, asked as one question because
   * the HTTP stream request does not know which kind of viewer it is serving.
   *
   * Asked on **every** stream request, not once when the URL was minted. A signed
   * URL proves who it was made for; only this proves they are still entitled. A
   * controller who ends the session, or an observer a controller closed the
   * mission against, must stop being served on their next request rather than
   * whenever their token happens to lapse.
   */
  mayWatchMission(missionId: string, userId: string, now: Date): Promise<boolean>;
}

export type ChannelUser = {
  id: string;
  role: UserRole;
};

export type MissionSnapshot = {
  missionId: string;
  state: MissionState;
  failureReason: MissionFailureReason | null;
};
