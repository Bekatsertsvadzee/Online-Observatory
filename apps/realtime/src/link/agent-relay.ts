import type { AgentLinkRegistry } from "@/link/registry";
import { cloudCommand, cloudSessionUpdate } from "@/link/protocol";
import type { LinkStore } from "@/link/store";

/**
 * The cloud half of ADR-009: turning a notification into a message on the wire.
 *
 * The orchestrator writes an `ObservatoryCommand` row and issues `NOTIFY` in one
 * transaction. This receives the notification, reads the row, and sends it to the
 * agent that holds the observatory. It decides nothing -- the architecture is
 * explicit that realtime transports and the orchestrator decides -- so there is no
 * validation here beyond "is this observatory connected".
 *
 * Deliberately transport-free, like `AgentLink`: it is handed a store and a
 * registry, so every rule below is exercised without a database or a socket. The
 * `LISTEN` connection lives in `command-listener.ts`.
 */
export type NotificationPayload =
  | { kind: "COMMAND"; commandId: string; observatoryId: string }
  | {
      kind: "SESSION";
      observatoryId: string;
      missionId: string;
      sessionId: string | null;
    };

export type RelayOutcome = "SENT" | "NO_LINK" | "NOT_FOUND" | "MALFORMED";

export class AgentRelay {
  constructor(
    private readonly store: LinkStore,
    private readonly registry: AgentLinkRegistry,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Handle one notification.
   *
   * A notification is only ever a wake-up. Everything it acts on is read from the
   * database, so a forged or stale payload can at worst cause a lookup that finds
   * nothing.
   */
  async handle(raw: string): Promise<RelayOutcome> {
    let notification: NotificationPayload;
    try {
      notification = JSON.parse(raw) as NotificationPayload;
    } catch {
      return "MALFORMED";
    }

    if (notification?.kind === "COMMAND") {
      return this.relayCommand(notification.commandId);
    }
    if (notification?.kind === "SESSION") {
      return this.relaySession(
        notification.observatoryId,
        notification.missionId,
        notification.sessionId,
      );
    }
    return "MALFORMED";
  }

  async relayCommand(commandId: string): Promise<RelayOutcome> {
    const command = await this.store.loadCommand(commandId);
    if (!command) return "NOT_FOUND";

    const link = this.registry.get(command.observatoryId);
    if (!link) return "NO_LINK";

    // Marked relayed only if it actually went. An agent that is connected but has
    // not finished its hello is not yet somewhere a command can be sent, and
    // marking it sent would hide it from the sweep that exists to catch exactly
    // that case.
    if (!link.dispatch(cloudCommand(command.envelope))) return "NO_LINK";

    await this.store.markCommandRelayed(commandId, this.now());
    return "SENT";
  }

  async relaySession(
    observatoryId: string,
    missionId: string,
    sessionId: string | null,
  ): Promise<RelayOutcome> {
    const link = this.registry.get(observatoryId);
    if (!link) return "NO_LINK";

    return link.dispatch(cloudSessionUpdate(missionId, sessionId)) ? "SENT" : "NO_LINK";
  }

  /**
   * Send anything written but never put on the wire.
   *
   * Run on every reconnect and on a slow timer. `NOTIFY` is not delivered to a
   * listener that was disconnected at that instant, and the row is the source of
   * truth, so this is what makes a lost notification cost latency rather than a
   * command.
   *
   * Returns how many were sent, so a caller can log when the fallback is doing
   * work. If it routinely is, the notification path is broken and this is masking
   * it.
   */
  async sweep(observatoryId: string): Promise<number> {
    const pending = await this.store.pendingCommands(observatoryId, this.now());

    let sent = 0;
    for (const command of pending) {
      if ((await this.relayCommand(command.envelope.commandId)) === "SENT") sent += 1;
    }
    return sent;
  }
}
