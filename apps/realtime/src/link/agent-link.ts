import type { AgentToCloudMessage, CloudToAgentMessage } from "@darkview/contracts";

import {
  HEARTBEAT_GRACE_SECONDS,
  PROTOCOL_VERSION,
  cloudError,
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

    await this.record(message);
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
    // state store. Deciding which mission it should hold is the orchestrator's
    // job (DV-058); until that exists the cloud expects nothing.
    this.send(cloudWelcome(null));
  }

  /**
   * Persist the message identity. A repeat is the agent replaying its queue after
   * an outage, which is the recovery path working: acknowledged, not stored twice,
   * not treated as an error.
   */
  private async record(message: AgentToCloudMessage): Promise<void> {
    await this.store.recordInboundMessage({
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
