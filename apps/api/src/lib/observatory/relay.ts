import "server-only";

import type { Prisma } from "@darkview/db";

/**
 * How a command leaves the orchestrator and reaches the agent.
 *
 * ADR-009. `apps/api` mints the envelope; `apps/realtime` holds the only socket to
 * the observatory. They are separate processes, so something has to carry the
 * envelope across, and the thing they already share is the database.
 *
 * The row is written and the notification is issued in the same transaction. That
 * ordering is the whole design: the command is durable before anyone is told about
 * it, so a notification lost while the realtime service was reconnecting costs
 * latency and never a command. The realtime service also sweeps for unrelayed rows,
 * which makes the notification an optimisation on top of a poll rather than the
 * only path.
 *
 * Nothing here sends anything. It writes a row and rings a bell.
 */
export const AGENT_CHANNEL = "darkview_agent";

/**
 * What the bell says. Deliberately tiny -- an identifier and a kind, never a
 * payload. `NOTIFY` caps at 8000 bytes and the reader has the database anyway, so
 * there is no version of this that should grow.
 */
export type AgentNotification =
  | { kind: "COMMAND"; commandId: string; observatoryId: string }
  | {
      kind: "SESSION";
      observatoryId: string;
      missionId: string;
      /** Null revokes the session: the agent then accepts no client command for it. */
      sessionId: string | null;
    };

/**
 * `$executeRaw`, not `$queryRaw`: `pg_notify` returns void, and Prisma refuses to
 * deserialize a void column. This is a statement, not a question.
 */
type Notifier = Pick<Prisma.TransactionClient, "$executeRaw">;

/**
 * Ring the bell, inside the caller's transaction.
 *
 * Must be called with the transaction client, not the base client. `pg_notify` on
 * a different connection would fire whether or not the caller's write commits, and
 * a notification about a row that never existed sends the realtime service looking
 * for nothing.
 */
export async function notifyAgent(
  tx: Notifier,
  notification: AgentNotification,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_notify(${AGENT_CHANNEL}, ${JSON.stringify(notification)})`;
}
