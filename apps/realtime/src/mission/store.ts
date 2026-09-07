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
