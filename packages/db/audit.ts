import type { Prisma } from "./generated/prisma/client.ts";
import type { AuditCategory } from "./generated/prisma/enums.ts";

/**
 * The one way anything in this repository writes an audit row.
 *
 * `contracts/openapi.yaml`, AuditEvent: "Append-only. Never edited, never
 * backdated, never fabricated." There is no update path and no delete path here,
 * and `createdAt` is the database's clock -- a caller cannot supply one, which is
 * what makes backdating impossible rather than merely discouraged.
 *
 * Every audited fact has one recorder so that the guarantees below are properties
 * of the system rather than of whoever wrote the call site.
 *
 * It lives in `packages/db` rather than in either service because both write audit
 * rows -- the API mints and refuses commands, the realtime service holds the link
 * -- and the alternative is two copies of the action vocabulary that drift apart.
 * This package is already the thing the two services share, and nothing here is
 * Next-specific.
 */

/**
 * What was done. Typed rather than free text: an audit trail an operator searches
 * by action string is only useful if the strings are stable, and a typo in a
 * literal is invisible until the night somebody needs the row.
 *
 * A new action is added here first. Categories with no member yet are the ones
 * whose code does not exist: PAYMENT is DV-056, OBSERVATORY_MODE and
 * OPERATOR_OVERRIDE are DV-063.
 */
export type AuditAction =
  // AUTH -- written by recordAuthEvent, whose actions are AuthEventType.
  | "REGISTERED"
  | "EMAIL_VERIFIED"
  | "LOGIN_SUCCEEDED"
  | "LOGIN_FAILED"
  | "LOGGED_OUT"
  | "RATE_LIMITED"
  // BOOKING
  | "BOOKING_RESERVED"
  | "BOOKING_SLOT_RELEASED"
  // MISSION
  | "MISSION_SESSION_OPENED"
  | "MISSION_SESSION_REVOKED"
  | "MISSION_RESOLVED_AFTER_AGENT_RESTART"
  | "OBSERVER_SEAT_TAKEN"
  | "OBSERVER_SEAT_RELEASED"
  | "MISSION_OPENED_TO_OBSERVERS"
  | "MISSION_CLOSED_TO_OBSERVERS"
  // COMMAND
  | "COMMAND_MINTED"
  | "COMMAND_VERDICT_RECORDED"
  // SAFETY
  | "COMMAND_REFUSED_BY_CLOUD"
  | "SAFETY_ENVELOPE_RECORDED"
  // AGENT_LINK
  | "AGENT_LINK_UP"
  | "AGENT_LINK_LOST"
  | "AGENT_HELLO_REFUSED";

export type AuditEntry = {
  category: AuditCategory;
  action: AuditAction;
  /** The signed-in account that caused it, when there is one. */
  actorUserId?: string | null;
  /**
   * A non-account actor, already hashed. An email address at a failed login is
   * the case that exists: it identifies the attempt without storing the address.
   */
  actorHash?: string | null;
  missionId?: string | null;
  commandId?: string | null;
  /** Anything else the row is about -- an observatory, a booking, a payment. */
  entityType?: string | null;
  entityId?: string | null;
  /** Contract: AuditEvent.detail. Structured, and never a secret. */
  detail?: Record<string, unknown>;
  isDemo?: boolean;
};

/**
 * Anything with an `auditLog` model: the base client or a transaction client.
 *
 * Typed as the narrow thing rather than accepting `PrismaClient`, so a call site
 * inside a transaction cannot accidentally be handed the base client. That
 * distinction matters here for the same reason it matters in `notifyAgent`: an
 * audit row written on a separate connection commits whether or not the thing it
 * describes did, and a trail that records writes that never happened is worse
 * than no trail.
 */
export type AuditWriter = Pick<Prisma.TransactionClient, "auditLog">;

/**
 * Key names a detail object may never carry.
 *
 * Contract: "Never contains a secret, token or device address." A comment saying
 * so is not a guarantee; this is. It throws rather than redacting, because a
 * redacted row would hide the fact that a call site tried -- and every detail key
 * in this repository is a literal in source, so the failure surfaces in tests
 * long before it could reach an operator.
 */
const FORBIDDEN_DETAIL_KEYS =
  /token|secret|password|passphrase|credential|cookie|authorization|apiKey|privateKey/i;

export function assertDetailCarriesNoSecret(detail: Record<string, unknown>): void {
  const offending = Object.keys(detail).filter((key) => FORBIDDEN_DETAIL_KEYS.test(key));
  if (offending.length > 0) {
    throw new Error(
      `Audit detail may not carry a secret, token or device address: ${offending.join(", ")}.`,
    );
  }
}

/**
 * Write one audit row.
 *
 * The writer is explicit and has no default. Inside a transaction, pass the
 * transaction client, so the row and the fact it describes share a fate. Outside
 * one -- a refusal writes nothing else, so there is nothing for it to be atomic
 * with -- pass the base client, and say at the call site why there is no
 * transaction.
 */
export async function recordAuditEvent(
  entry: AuditEntry,
  writer: AuditWriter,
): Promise<void> {
  if (entry.detail) assertDetailCarriesNoSecret(entry.detail);

  await writer.auditLog.create({
    data: {
      category: entry.category,
      action: entry.action,
      actorUserId: entry.actorUserId ?? null,
      actorHash: entry.actorHash ?? null,
      missionId: entry.missionId ?? null,
      commandId: entry.commandId ?? null,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      // Cast at the boundary rather than typing `detail` as Prisma's JSON input.
      // Every value written here is a string, number, boolean or null decided in
      // source; making call sites satisfy InputJsonValue would push Prisma's types
      // out into the domain for nothing.
      metadata: (entry.detail ?? undefined) as Prisma.InputJsonObject | undefined,
      isDemo: entry.isDemo ?? false,
    },
  });
}
