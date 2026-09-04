import { Client } from "pg";

import type { AgentRelay } from "@/link/agent-relay";

/**
 * The dedicated PostgreSQL connection that carries ADR-009's notifications.
 *
 * `LISTEN` occupies a connection: a pooled client would hand the socket to
 * somebody else's query and the subscription would go with it. So this is one
 * long-lived `Client`, separate from the query pool, and its only job is to be
 * woken up.
 *
 * It reconnects on loss. That gap is exactly when notifications are missed, which
 * is why `AgentRelay.sweep` runs after every reconnect rather than only on a timer.
 */
export const AGENT_CHANNEL = "darkview_agent";

/** How long to wait before reconnecting a dropped listener. */
const RECONNECT_DELAY_MS = 2_000;

export type CommandListenerOptions = {
  connectionString: string;
  relay: AgentRelay;
  /** Called after every successful (re)connect, so pending work can be swept. */
  onConnected?: () => void | Promise<void>;
  onError?: (error: unknown) => void;
};

export class CommandListener {
  private client: Client | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: CommandListenerOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    const client = new Client({ connectionString: this.options.connectionString });
    client.on("notification", (message) => {
      if (message.channel !== AGENT_CHANNEL || !message.payload) return;
      void this.options.relay.handle(message.payload).catch(this.options.onError);
    });

    // A listener that dies quietly is worse than no listener: commands would sit
    // unrelayed with nothing to notice. Any connection error schedules a retry.
    client.on("error", (error) => {
      this.options.onError?.(error);
      this.scheduleReconnect();
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${AGENT_CHANNEL}`);
      this.client = client;
      await this.options.onConnected?.();
    } catch (error) {
      this.options.onError?.(error);
      await client.end().catch(() => undefined);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.client = null;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_DELAY_MS);
  }
}
