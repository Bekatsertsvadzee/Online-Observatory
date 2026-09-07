import type { MissionChannelMessage, MissionClientMessage } from "@darkview/contracts";

import type { LinkStore } from "@/link/store";
import {
  CLIENT_IDLE_GRACE_SECONDS,
  missionChannelError,
  missionStateUpdate,
  parseClientMessage,
  type CloseClient,
  type SendToClient,
} from "@/mission/protocol";
import type { ChannelUser, MissionChannelStore } from "@/mission/store";

export type ChannelState = "AWAITING_SUBSCRIBE" | "SUBSCRIBED" | "CLOSED";

/**
 * One customer's view of one mission, for the life of one socket.
 *
 * Subscription only. There is no path from this class to a mount, a camera or a
 * CommandEnvelope, and that is the point: the contract says a client "may not send
 * a CommandEnvelope on this channel", so commands go through
 * `POST /missions/{missionId}/command` where the cloud mints and signs them. The
 * two client messages this accepts are subscribe and keep-alive.
 *
 * Transport-free like `AgentLink`, and for the same reason -- every rule below is
 * exercised without a socket or a timer.
 */
export class MissionChannel {
  private state: ChannelState = "AWAITING_SUBSCRIBE";
  private lastActivityAt: number;

  constructor(
    /** The mission named in the URL. A subscribe naming a different one is refused. */
    readonly missionId: string,
    /** Authenticated during the upgrade, before this channel existed. */
    readonly user: ChannelUser,
    private readonly store: LinkStore & MissionChannelStore,
    private readonly send: SendToClient,
    private readonly close: CloseClient,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.lastActivityAt = this.now();
  }

  get currentState(): ChannelState {
    return this.state;
  }

  async receive(raw: string): Promise<void> {
    if (this.state === "CLOSED") return;

    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.send(missionChannelError("BAD_REQUEST", `Message rejected: ${parsed.reason}.`));
      if (this.state === "AWAITING_SUBSCRIBE") this.terminate("malformed subscribe");
      return;
    }

    this.lastActivityAt = this.now();
    await this.handle(parsed.message);
  }

  private async handle(message: MissionClientMessage): Promise<void> {
    if (message.type === "CLIENT_SUBSCRIBE") {
      await this.subscribe(message);
      return;
    }

    // CLIENT_PING. `lastActivityAt` above already consumed it, and there is no
    // reply: MissionChannelMessage has no pong, so answering one would mean
    // inventing a message type outside the contract.
    if (this.state !== "SUBSCRIBED") {
      this.send(
        missionChannelError("BAD_REQUEST", "CLIENT_SUBSCRIBE must be the first message."),
      );
      this.terminate("message before subscribe");
    }
  }

  /**
   * Admit a client, or refuse it.
   *
   * Three things have to agree before anything is sent: the URL's mission, the
   * subscribe message's mission, and the mission the presented session was issued
   * for. They are checked separately because they fail for different reasons -- a
   * mismatched URL is a confused client, a session for another mission is someone
   * holding a valid credential and pointing it somewhere else.
   *
   * Every refusal says the same thing. A customer probing mission ids must not be
   * able to tell "that mission does not exist" from "that mission is not yours",
   * which is the rule `startMissionSession` follows when it answers a stranger 404.
   */
  private async subscribe(
    message: Extract<MissionClientMessage, { type: "CLIENT_SUBSCRIBE" }>,
  ): Promise<void> {
    if (this.state === "SUBSCRIBED") {
      this.send(missionChannelError("BAD_REQUEST", "Already subscribed."));
      return;
    }

    if (message.missionId !== this.missionId) {
      this.refuse();
      return;
    }

    const session = await this.store.loadSession(message.sessionId);
    const expired = session !== null && session.expiresAt <= new Date(this.now());

    if (
      session === null ||
      expired ||
      session.missionId !== this.missionId ||
      // The session must belong to the person on this socket. Without this a
      // customer who learns any live sessionId could watch a stranger's mission,
      // and the cookie check during the upgrade would not have stopped them.
      session.userId !== this.user.id
    ) {
      this.refuse();
      return;
    }

    this.state = "SUBSCRIBED";

    // The current state, immediately. A client that subscribes during OBSERVING
    // would otherwise show an empty panel until the agent's next transition, which
    // can be minutes away.
    const snapshot = await this.store.loadMissionSnapshot(this.missionId);
    if (snapshot) this.send(missionStateUpdate(snapshot));
  }

  /**
   * One refusal, worded identically for every cause, and fatal.
   *
   * Fatal because there is nothing a refused client can usefully say next: it
   * holds no session this channel will accept, and leaving the socket open would
   * invite it to guess at sessionIds one message at a time.
   */
  private refuse(): void {
    this.send(
      missionChannelError("FORBIDDEN", "No live session for this mission is yours."),
    );
    this.terminate("subscribe refused");
  }

  /**
   * Push one message to this client.
   *
   * Only while SUBSCRIBED. Before the subscribe the socket is authenticated as a
   * person but has proved nothing about which mission they may watch, and a
   * broadcast into that gap would be the leak the subscribe check exists to stop.
   */
  dispatch(message: MissionChannelMessage): boolean {
    if (this.state !== "SUBSCRIBED") return false;
    this.send(message);
    return true;
  }

  isExpired(at: number = this.now()): boolean {
    return at - this.lastActivityAt > CLIENT_IDLE_GRACE_SECONDS * 1000;
  }

  terminate(reason: string): void {
    if (this.state === "CLOSED") return;
    this.state = "CLOSED";
    this.close(reason);
  }
}
