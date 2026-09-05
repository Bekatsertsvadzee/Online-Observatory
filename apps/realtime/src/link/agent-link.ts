import type { AgentToCloudMessage, CloudToAgentMessage } from "@darkview/contracts";

import {
  HEARTBEAT_GRACE_SECONDS,
  PROTOCOL_VERSION,
  cloudError,
  cloudSessionUpdate,
  cloudWelcome,
  parseAgentMessage,
  type Close,
  type Send,
} from "@/link/protocol";
import type { LinkStore, ObservatoryRecord } from "@/link/store";

export type LinkState = "AWAITING_HELLO" | "ONLINE" | "CLOSED";

/**
 * One agent's conversation with the cloud, for the life of one socket.
 *
 * The socket is already authenticated when this is constructed: the device token
 * was verified during the HTTP upgrade, so `observatory` is known before the
 * agent says anything. The hello still has to agree with it -- a valid token used
 * to claim a different observatory is a refusal, not a correction.
 *
 * Deliberately transport-free. It is handed `send` and `close` callbacks and a
 * clock, so every rule below is exercised in tests without a socket or a timer.
 */
export class AgentLink {
  private state: LinkState = "AWAITING_HELLO";
  private lastActivityAt: number;

  constructor(
    readonly observatory: ObservatoryRecord,
    private readonly store: LinkStore,
    private readonly send: Send,
    private readonly close: Close,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.lastActivityAt = this.now();
  }

  get currentState(): LinkState {
    return this.state;
  }

  get lastSeenAt(): number {
    return this.lastActivityAt;
  }

  async receive(raw: string): Promise<void> {
    if (this.state === "CLOSED") return;

    const parsed = parseAgentMessage(raw);
    if (!parsed.ok) {
      if (this.state === "AWAITING_HELLO") {
        // A connection that cannot produce a valid hello is refused rather than
        // left to retry. This is also where an unsupported protocolVersion lands:
        // the contract pins the version to an enum, so an agent speaking a future
        // protocol fails validation here rather than at the version check below.
        // Telling it BAD_REQUEST forever would be a silent hang, not a refusal.
        this.send(
          cloudError("BAD_REQUEST", `Hello rejected: ${parsed.reason}.`, true),
        );
        this.terminate("unsupported protocol version");
        return;
      }

      // Once online, malformed input is answered and survived. It never reaches
      // storage and never affects another observatory's link.
      this.send(cloudError("BAD_REQUEST", `Message rejected: ${parsed.reason}.`));
      return;
    }

    const message = parsed.message;
    this.lastActivityAt = this.now();

    if (message.type === "AGENT_HELLO") {
      await this.handleHello(message);
      return;
    }

    if (this.state !== "ONLINE") {
      this.send(
        cloudError("BAD_REQUEST", "AGENT_HELLO must be the first message.", true),
      );
      this.terminate("message before hello");
      return;
    }

    // Record first, act only on the first sighting. The primary key on
    // AgentMessage is what makes every effect in `apply` idempotent, so a replayed
    // queue after an outage is acknowledged once and applied once, and nothing
    // downstream needs a replay guard of its own.
    if (await this.record(message)) await this.apply(message);
  }

  /**
   * What an inbound message means.
   *
   * One place, dispatching by type. Before this existed the cloud stored the
   * identity of every agent message -- messageId, type, sentAt -- and discarded
   * the body, so the agent ran the full mission state machine and reported every
   * transition into nothing.
   */
  private async apply(message: AgentToCloudMessage): Promise<void> {
    switch (message.type) {
      case "AGENT_MISSION_EVENT":
        await this.applyMissionEvent(message);
        return;

      case "AGENT_COMMAND_ACK":
        await this.applyCommandAck(message);
        return;

      // AGENT_HEARTBEAT is liveness, and `lastActivityAt` above is what consumes
      // it. AGENT_STATE_DELTA, AGENT_LIVE_FRAME and AGENT_CAPTURE_READY carry
      // state this service does not own yet -- DV-060, DV-032 and DV-061 own
      // them -- so they are recorded and go no further, deliberately rather than
      // by omission.
      default:
        return;
    }
  }

  /**
   * A transition the agent's state machine made.
   *
   * The mission moves, or -- if it has already finished -- the event is filed and
   * the mission is left alone. The link does not guarantee order: `OutboundQueue`
   * replays FIFO, but a reconnect mid-drain plus its oldest-first drop policy
   * means a COMPLETE can arrive behind a FAILED, and reviving a finished mission
   * would put the observatory back into the state this whole path exists to end.
   */
  private async applyMissionEvent(
    message: Extract<AgentToCloudMessage, { type: "AGENT_MISSION_EVENT" }>,
  ): Promise<void> {
    const outcome = await this.store.applyMissionEvent({
      observatoryId: this.observatory.id,
      missionId: message.missionId,
      state: message.state,
      failureReason: message.failureReason ?? null,
      occurredAt: new Date(message.occurredAt),
      detail: message.detail ?? null,
    });

    if (outcome === "WRONG_OBSERVATORY" || outcome === "NOT_FOUND") {
      this.refuse(`Mission ${message.missionId} is not this observatory's to move.`);
    }
  }

  /**
   * The agent's verdict on a command.
   *
   * A REJECTED ack carrying a SAFETY_ reason after the cloud approved the command
   * is the two-independent-validations design working, and it has to survive
   * somewhere other than the observatory's own disk.
   */
  private async applyCommandAck(
    message: Extract<AgentToCloudMessage, { type: "AGENT_COMMAND_ACK" }>,
  ): Promise<void> {
    const outcome = await this.store.recordCommandVerdict({
      observatoryId: this.observatory.id,
      commandId: message.commandId,
      status: message.status,
      rejectionReason: message.rejectionReason ?? null,
      detail: message.detail ?? null,
      // The ack's own sentAt: the agent's account of when it decided. Never
      // replaced with the moment the cloud happened to hear about it.
      decidedAt: new Date(message.sentAt),
    });

    if (outcome === "WRONG_OBSERVATORY" || outcome === "NOT_FOUND") {
      this.refuse(`Command ${message.commandId} is not this observatory's to answer.`);
    }
  }

  /**
   * Refuse one message without taking the link down.
   *
   * Answered on the wire rather than written to a log, because these classes are
   * deliberately transport-free -- logging lives in `server.ts` -- and because the
   * party that needs to know is the agent. It stays connected: everything else it
   * has to say is still about the observatory it authenticated as.
   *
   * The message never distinguishes "not yours" from "does not exist", for the
   * same reason `startMissionSession` returns 404 to a stranger probing ids.
   */
  private refuse(detail: string): void {
    this.send(cloudError("FORBIDDEN", detail));
  }

  private async handleHello(
    message: Extract<AgentToCloudMessage, { type: "AGENT_HELLO" }>,
  ): Promise<void> {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      this.send(
        cloudError(
          "BAD_REQUEST",
          `Unsupported protocol version ${message.protocolVersion}; this service speaks ${PROTOCOL_VERSION}.`,
          true,
        ),
      );
      this.terminate("unsupported protocol version");
      return;
    }

    if (message.observatoryId !== this.observatory.id) {
      // The token is valid but claims an observatory it does not own.
      this.send(
        cloudError("FORBIDDEN", "Device token does not match observatoryId.", true),
      );
      this.terminate("observatory mismatch");
      return;
    }

    await this.record(message);
    this.state = "ONLINE";
    await this.store.markLinkUp(this.observatory.id);

    // resumeMissionId is the agent telling us what it recovered from its local
    // state store (DV-027). It has already parked the mount, because it lost the
    // state machine's progress and will not guess where a telescope is pointing.
    // What is left is bookkeeping -- and until it is done, the mission sits in a
    // live state and Mission_active_per_observatory_unique holds the observatory
    // shut against every later booking.
    const resumeMissionId = message.resumeMissionId ?? null;
    const resumed =
      resumeMissionId === null
        ? null
        : await this.store.resolveResumedMission({
            observatoryId: this.observatory.id,
            missionId: resumeMissionId,
            now: new Date(this.now()),
          });

    // Read after the recovery above, not assumed. After one it is null -- stated,
    // which is not the same as defaulted.
    this.send(cloudWelcome(await this.store.liveMissionId(this.observatory.id)));

    if (resumed === "WRONG_OBSERVATORY" || resumed === "NOT_FOUND") {
      this.refuse(`Mission ${resumeMissionId} is not this observatory's to resume.`);
      return;
    }

    // Whether this call ended the mission or found it already ended, the agent is
    // holding a mission that is over. Told explicitly, because ownership is the
    // difference between a command being obeyed and refused, and an agent left
    // believing in a revoked session is exactly what this message prevents.
    if (resumed !== null && resumeMissionId !== null) {
      this.send(cloudSessionUpdate(resumeMissionId, null));
    }
  }

  /**
   * Persist the message identity, and say whether this is the first sighting.
   *
   * A repeat is the agent replaying its queue after an outage, which is the
   * recovery path working: acknowledged, not stored twice, not treated as an
   * error -- and, since `apply` is gated on the answer, not acted on twice.
   */
  private async record(message: AgentToCloudMessage): Promise<boolean> {
    return this.store.recordInboundMessage({
      messageId: message.messageId,
      observatoryId: this.observatory.id,
      type: message.type,
      sentAt: new Date(message.sentAt),
    });
  }

  /**
   * Send a cloud-originated message to this agent.
   *
   * Only while ONLINE. Before the hello the agent has not yet told us which
   * observatory it believes it is, and a command sent into that gap could reach an
   * agent that is about to be refused for claiming the wrong one.
   *
   * Returns whether it went. The caller is the relay, and the relay needs to know
   * so it can leave the command unrelayed for the sweep rather than mark it sent.
   */
  dispatch(message: CloudToAgentMessage): boolean {
    if (this.state !== "ONLINE") return false;
    this.send(message);
    return true;
  }

  /** True when the agent has been silent past the grace period. */
  isExpired(at: number = this.now()): boolean {
    return at - this.lastActivityAt > HEARTBEAT_GRACE_SECONDS * 1000;
  }

  async expire(): Promise<void> {
    this.send(cloudError("INTERNAL", "Heartbeat lost; closing the link.", true));
    this.terminate("heartbeat lost");
    await this.store.markLinkLost(this.observatory.id, new Date(this.now()));
  }

  terminate(reason: string): void {
    if (this.state === "CLOSED") return;
    this.state = "CLOSED";
    this.close(reason);
  }
}
