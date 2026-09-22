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
 * A new action is added here first. Every category now has a writer.
 */
export type AuditAction =
  // Any category. A rate limiter refused something, and the category says which
  // surface: AUTH is a password-guessing budget, BOOKING is somebody holding
  // inventory, COMMAND is somebody flooding a live mission. One action rather
  // than one per surface, because the pair (category, action) already says it
  // and `detail.scope` names the exact bucket.
  | "RATE_LIMITED"
  // AUTH -- written by recordAuthEvent, whose actions are AuthEventType.
  | "REGISTERED"
  | "EMAIL_VERIFIED"
  | "LOGIN_SUCCEEDED"
  | "LOGIN_FAILED"
  | "LOGGED_OUT"
  // LOYALTY (DV-090 to DV-096): one action per ledger entry kind, and a tier change.
  | "LOYALTY_WELCOME_BONUS"
  | "LOYALTY_REFERRAL_BONUS"
  | "LOYALTY_PURCHASE_EARNED"
  | "LOYALTY_PURCHASE_REVERSED"
  | "LOYALTY_REDEEMED"
  | "LOYALTY_REDEMPTION_RELEASED"
  | "LOYALTY_ADMIN_ADJUSTMENT"
  | "LOYALTY_TIER_CHANGED"
  // SUBSCRIPTION (ADR-022): one action per credit ledger entry. The reason names
  // what moved the minutes; the idempotency key in the detail names the event.
  | "CREDIT_SUBSCRIPTION_GRANT"
  | "CREDIT_MISSION_DEBIT"
  | "CREDIT_REFUND"
  | "CREDIT_ADJUSTMENT"
  | "CREDIT_EXPIRY"
  // SUBSCRIPTION (ADR-022): the subscription itself. ORDERED is the customer
  // asking; ACTIVATED and RENEWED are the money arriving, and only those two sit
  // beside a grant. The three customer acts each write one row, and a change that
  // changes nothing writes none -- so the log is what happened, not what was
  // clicked.
  | "SUBSCRIPTION_ORDERED"
  | "SUBSCRIPTION_ACTIVATED"
  | "SUBSCRIPTION_RENEWED"
  | "SUBSCRIPTION_PAYMENT_FAILED"
  | "SUBSCRIPTION_PAUSED"
  | "SUBSCRIPTION_RESUMED"
  | "SUBSCRIPTION_CANCEL_SCHEDULED"
  | "SUBSCRIPTION_CANCELLED"
  // SUBSCRIPTION (ADR-022 sections 8 and 9): the renewal sweep opened a charge on the
  // saved card, or ended a subscription whose grace period ran out.
  | "SUBSCRIPTION_RENEWAL_CHARGED"
  | "SUBSCRIPTION_EXPIRED"
  // BOOKING
  | "BOOKING_RESERVED"
  | "BOOKING_SLOT_RELEASED"
  // DV-111: an ended slot entitled its customer to a refund or reschedule, and
  // the customer used it to book another slot.
  | "BOOKING_ENTITLEMENT_GRANTED"
  | "BOOKING_RESCHEDULED"
  // ADR-022 section 7: a booking subscription minutes paid for, and the minutes
  // given back when it was refunded. The ledger's own CREDIT_* rows sit beside them.
  | "BOOKING_PAID_WITH_MINUTES"
  | "BOOKING_MINUTES_RETURNED"
  // DV-112: a gift voucher ordered, paid for, spent on a booking, or given back
  // when that booking was refunded. Never the code.
  | "GIFT_VOUCHER_ORDERED"
  | "GIFT_VOUCHER_ISSUED"
  | "GIFT_VOUCHER_PAYMENT_FAILED"
  | "GIFT_VOUCHER_REDEEMED"
  | "GIFT_VOUCHER_RESTORED"
  // PAYMENT -- written by the webhook path (DV-056). A refusal is recorded
  // because a callback that failed its signature and left nothing behind is
  // indistinguishable from one that never arrived.
  | "PAYMENT_CAPTURED"
  | "PAYMENT_CAPTURED_WITHOUT_SLOT"
  | "PAYMENT_FAILED"
  | "PAYMENT_WEBHOOK_REFUSED"
  // DV-111: money returned against an entitlement.
  | "PAYMENT_REFUNDED"
  // PAYMENT -- the Observer Pack sale (DV-102). A seat is a different sale from a
  // booking: it has no slot to release, so a capture that arrives after the hold
  // lapsed has its own row, and it is the one DV-111 refunds from.
  | "OBSERVER_PACK_RESERVED"
  | "OBSERVER_PACK_CAPTURED"
  | "OBSERVER_PACK_PAYMENT_FAILED"
  | "OBSERVER_PACK_CAPTURED_WITHOUT_SEAT"
  // MISSION
  | "MISSION_SCHEDULED"
  // ADR-018: the customer started it inside the slot; nobody did before the slot
  // ended; the agent refused the GOTO that would have started it.
  | "MISSION_STARTED"
  | "MISSION_NOT_STARTED"
  | "MISSION_START_REFUSED_BY_AGENT"
  | "MISSION_SESSION_OPENED"
  | "MISSION_SESSION_REVOKED"
  | "MISSION_RESOLVED_AFTER_AGENT_RESTART"
  | "OBSERVER_SEAT_TAKEN"
  | "OBSERVER_SEAT_RELEASED"
  | "MISSION_OPENED_TO_OBSERVERS"
  | "MISSION_CLOSED_TO_OBSERVERS"
  | "CAPTURE_RECORDED"
  // COMMAND
  | "COMMAND_MINTED"
  | "COMMAND_VERDICT_RECORDED"
  // SAFETY
  | "COMMAND_REFUSED_BY_CLOUD"
  | "SAFETY_ENVELOPE_RECORDED"
  | "WEATHER_HOLD_SET"
  | "WEATHER_HOLD_CLEARED"
  // OBSERVATORY_MODE
  | "OBSERVATORY_MODE_CHANGED"
  // OBSERVATORY_MODE -- partner observatories (ADR-013). They share the category
  // because they are all statements about what an observatory is permitted to do.
  | "NETWORK_NODE_REGISTERED"
  | "NETWORK_NODE_SUBMITTED"
  | "NETWORK_NODE_APPROVED"
  | "NETWORK_NODE_SUSPENDED"
  // ADR-020: the one credential a node's agent connects with. The token itself is
  // never in the row; FORBIDDEN_DETAIL_KEYS below refuses any detail that tries.
  | "NETWORK_NODE_DEVICE_TOKEN_ISSUED"
  | "NETWORK_NODE_DEVICE_TOKEN_ROTATED"
  | "NETWORK_NODE_DEVICE_TOKEN_REVOKED"
  // OPERATOR_OVERRIDE
  | "OPERATOR_OVERRIDE_ISSUED"
  | "OPERATOR_MISSION_CANCELLED"
  | "OPERATOR_TARGET_UPDATED"
  // AGENT_LINK
  | "AGENT_LINK_UP"
  | "AGENT_LINK_LOST"
  | "AGENT_HELLO_REFUSED"
  // ADR-024: the agent reported a different posture -- armed, disarmed, or back to
  // attended after a restart. Written on change only, never per heartbeat.
  | "AGENT_POSTURE_CHANGED"
  // MISSION (#141): the operator's orphan sweep deleted a capture object no row
  // named. The detail carries the key, which names the mission.
  | "CAPTURE_OBJECT_DELETED";

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
