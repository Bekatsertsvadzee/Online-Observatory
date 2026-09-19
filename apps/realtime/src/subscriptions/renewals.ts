import { randomUUID } from "node:crypto";

import type { PaymentProvider } from "@darkview/contracts";
import type { PrismaClient } from "@darkview/db";
import { recordAuditEvent } from "@darkview/db/audit";
import { expireSubscriptionMinutes } from "@darkview/db/credits";

/**
 * The renewal sweep (ADR-022 sections 8 and 9, amended 2026-09-19, issue #121).
 *
 * Every pass, for each subscription whose period has ended: its unspent minutes
 * expire, then it is cancelled if the customer asked for that, left alone if
 * paused, and otherwise charged for the next period on the saved card. The charge's
 * outcome arrives by webhook and is settled by the API exactly as a first payment
 * is; nothing here grants a minute.
 *
 * **It holds no state.** Each decision is read from the rows: the period end, the
 * charges already opened for the next period, and how many of them failed. The
 * partial unique index `Payment_subscription_period_live_key` allows one live
 * charge per period, so two processes running this at once open one charge, and
 * the absence of leader election is survivable.
 *
 * **A failed renewal does not invent a status.** The subscription stays ACTIVE and
 * unfunded, and is charged again two and four days after its period ended. It
 * becomes EXPIRED at the third failure, or seven days after the period ended if a
 * charge is still unanswered then (maintainer decisions of 2026-09-19).
 */

/** Maintainer decision of 2026-09-19: three attempts before EXPIRED. */
export const RENEWAL_ATTEMPTS = 3;

/** Maintainer decision of 2026-09-19: attempts at period end, then +2 and +4 days. */
export const RENEWAL_RETRY_DAYS = 2;

/** Maintainer decision of 2026-09-19: seven days of grace after a period ends. */
export const RENEWAL_GRACE_DAYS = 7;

const DAY_MS = 86_400_000;

export type SavedInstrumentCharge = {
  paymentId: string;
  mandateRef: string;
  amountMinor: number;
  currency: string;
};

/**
 * Charges a saved card. ADR-022's `chargeSavedInstrument`: the first time this
 * platform initiates a payment rather than receiving one.
 *
 * Here rather than beside the webhook adapter in the API, because the only
 * long-lived process is the one that charges, and the API's adapter is
 * server-only. The two meet at the payment row: this opens the charge, and the
 * API settles what the provider reports about it.
 */
export type RenewalCharger = {
  readonly provider: PaymentProvider;
  /** Asks the provider to charge. Resolves once it accepted the request, not when it settled. */
  chargeSavedInstrument(charge: SavedInstrumentCharge): Promise<void>;
};

/**
 * The sandbox settles a payment on a signed callback and nothing else, so charging
 * it asks nobody anything: the charge is the PENDING row, and a developer, a test
 * or a dev script posts its outcome to the webhook as the provider would.
 *
 * BOG_IPAY has no charger. It is written from the provider's recurring-payment
 * documentation when that arrives, and not before (ADR-022 section 11).
 */
export function createSandboxCharger(): RenewalCharger {
  return {
    provider: "SANDBOX",
    async chargeSavedInstrument() {},
  };
}

export type RenewalSweepSummary = {
  charged: number;
  cancelled: number;
  expired: number;
  /** Charges the provider refused to take, recorded as failed attempts. */
  unsubmitted: number;
};

type Decision =
  | { kind: "NONE" }
  | { kind: "CANCELLED" }
  | { kind: "EXPIRED" }
  | { kind: "CHARGE"; charge: SavedInstrumentCharge };

/**
 * One pass. `charger` is null where nothing may be charged -- production, until a
 * real provider's charger exists -- and then minutes still expire and
 * subscriptions still cancel and lapse, but no charge is opened.
 */
export async function sweepSubscriptions(
  database: PrismaClient,
  input: { charger: RenewalCharger | null; now: Date },
): Promise<RenewalSweepSummary> {
  const { charger, now } = input;
  const summary: RenewalSweepSummary = { charged: 0, cancelled: 0, expired: 0, unsubmitted: 0 };

  const due = await database.subscription.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED"] }, currentPeriodEnd: { lte: now } },
    select: { id: true },
  });

  for (const { id } of due) {
    const decision = await database.$transaction((tx) => decide(tx, id, charger, now));

    if (decision.kind === "CANCELLED") summary.cancelled += 1;
    if (decision.kind === "EXPIRED") summary.expired += 1;
    if (decision.kind !== "CHARGE" || !charger) continue;

    try {
      await charger.chargeSavedInstrument(decision.charge);
      summary.charged += 1;
    } catch (error) {
      // The provider never took the request, so it will never report on it. Left
      // PENDING, the row would block every later attempt until the grace period
      // ran out; failed, it counts as the attempt it was.
      summary.unsubmitted += 1;
      await recordUnsubmitted(database, decision.charge, error, now);
    }
  }

  return summary;
}

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

async function decide(
  tx: Tx,
  subscriptionId: string,
  charger: RenewalCharger | null,
  now: Date,
): Promise<Decision> {
  // Locked, then read again: a customer cancelling, or a renewal settling, between
  // the list above and here is the state this decision has to be made on.
  await tx.$queryRaw`SELECT "id" FROM "Subscription" WHERE "id" = ${subscriptionId}::uuid FOR UPDATE`;
  const subscription = await tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  const periodEnd = subscription.currentPeriodEnd;
  if (
    (subscription.status !== "ACTIVE" && subscription.status !== "PAUSED") ||
    !periodEnd ||
    periodEnd > now
  ) {
    return { kind: "NONE" };
  }

  // First, so the next period's grant can never be what expires. Paused or not:
  // the period was paid for, and it ends when it ends.
  await expireSubscriptionMinutes(tx, subscription, periodEnd);

  if (subscription.cancelAtPeriodEnd) {
    await tx.subscription.update({
      where: { id: subscription.id },
      data: { status: "CANCELLED", endsAt: periodEnd },
    });
    await recordAuditEvent(
      {
        category: "SUBSCRIPTION",
        action: "SUBSCRIPTION_CANCELLED",
        actorUserId: null,
        entityType: "Subscription",
        entityId: subscription.id,
        detail: { immediate: false, endsAt: periodEnd.toISOString() },
        isDemo: subscription.isDemo,
      },
      tx,
    );
    return { kind: "CANCELLED" };
  }

  // A pause stops charging. It resumes into a period of its own.
  if (subscription.status === "PAUSED") return { kind: "NONE" };

  const attempts = await tx.payment.findMany({
    where: { subscriptionId: subscription.id, periodStart: periodEnd },
    select: { status: true },
  });
  // Settled a moment ago: settlement has moved the period on, or is about to.
  if (attempts.some((payment) => payment.status === "CAPTURED")) return { kind: "NONE" };

  const failed = attempts.filter((payment) => payment.status === "FAILED").length;
  const pending = attempts.some((payment) => payment.status === "PENDING");
  const graceEnded = now.getTime() >= periodEnd.getTime() + RENEWAL_GRACE_DAYS * DAY_MS;

  // Nothing saved a card, so no attempt can reach one: there is no grace to wait out.
  const noMandate = !subscription.providerMandateRef;

  if (failed >= RENEWAL_ATTEMPTS || graceEnded || noMandate) {
    await tx.subscription.update({
      where: { id: subscription.id },
      data: { status: "EXPIRED", endsAt: now },
    });
    await recordAuditEvent(
      {
        category: "SUBSCRIPTION",
        action: "SUBSCRIPTION_EXPIRED",
        actorUserId: null,
        entityType: "Subscription",
        entityId: subscription.id,
        detail: {
          periodEnd: periodEnd.toISOString(),
          failedAttempts: failed,
          reason: noMandate
            ? "NO_SAVED_INSTRUMENT"
            : failed >= RENEWAL_ATTEMPTS
              ? "ATTEMPTS_EXHAUSTED"
              : "GRACE_PERIOD_ENDED",
        },
        isDemo: subscription.isDemo,
      },
      tx,
    );
    return { kind: "EXPIRED" };
  }

  if (pending || !charger) return { kind: "NONE" };

  // Attempt n is due n * two days after the period ended.
  if (now.getTime() < periodEnd.getTime() + failed * RENEWAL_RETRY_DAYS * DAY_MS) {
    return { kind: "NONE" };
  }

  const paymentId = randomUUID();
  // ON CONFLICT DO NOTHING: a sweep on another process that opened this period's
  // live charge first wins, and this one opens nothing.
  const { count } = await tx.payment.createMany({
    data: [
      {
        id: paymentId,
        userId: subscription.userId,
        purpose: "SUBSCRIPTION",
        provider: charger.provider,
        status: "PENDING",
        amountMinor: subscription.priceMinor,
        currency: subscription.currency,
        subscriptionId: subscription.id,
        periodStart: periodEnd,
        isDemo: subscription.isDemo,
      },
    ],
    skipDuplicates: true,
  });
  if (count === 0) return { kind: "NONE" };

  await recordAuditEvent(
    {
      category: "SUBSCRIPTION",
      action: "SUBSCRIPTION_RENEWAL_CHARGED",
      actorUserId: null,
      entityType: "Subscription",
      entityId: subscription.id,
      detail: {
        paymentId,
        provider: charger.provider,
        amountMinor: subscription.priceMinor,
        currency: subscription.currency,
        periodStart: periodEnd.toISOString(),
        attempt: failed + 1,
      },
      isDemo: subscription.isDemo,
    },
    tx,
  );

  return {
    kind: "CHARGE",
    charge: {
      paymentId,
      mandateRef: subscription.providerMandateRef!,
      amountMinor: subscription.priceMinor,
      currency: subscription.currency,
    },
  };
}

async function recordUnsubmitted(
  database: PrismaClient,
  charge: SavedInstrumentCharge,
  error: unknown,
  now: Date,
): Promise<void> {
  const failureReason = "CHARGE_NOT_SUBMITTED";
  await database.$transaction(async (tx) => {
    // Conditional: a webhook that somehow reported on it first is the answer.
    const { count } = await tx.payment.updateMany({
      where: { id: charge.paymentId, status: "PENDING" },
      data: { status: "FAILED", failureReason, updatedAt: now },
    });
    if (count === 0) return;
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: charge.paymentId },
      select: { subscriptionId: true, userId: true, provider: true, isDemo: true },
    });
    await recordAuditEvent(
      {
        category: "SUBSCRIPTION",
        action: "SUBSCRIPTION_PAYMENT_FAILED",
        actorUserId: null,
        entityType: "Subscription",
        entityId: payment.subscriptionId!,
        detail: {
          provider: payment.provider,
          paymentId: charge.paymentId,
          failureReason,
          error: error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256),
          subscriptionExpired: false,
        },
        isDemo: payment.isDemo,
      },
      tx,
    );
  });
}
