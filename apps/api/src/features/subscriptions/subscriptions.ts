import "server-only";

import type {
  ErrorCode,
  Subscription as ContractSubscription,
  SubscribeRequest,
  SubscriptionPlanOption,
  SubscriptionWithPaymentIntent,
} from "@darkview/contracts";
import type { Prisma } from "@darkview/db";
import { type AuditAction, recordAuditEvent } from "@darkview/db/audit";
import { grantSubscriptionMinutes, readCreditBalance } from "@darkview/db/credits";
import { earnOnSettledPayment } from "@darkview/db/loyalty";
import { nextPeriodEnd } from "@darkview/db/subscriptions";

import type { PaymentOutcome } from "@/features/payments/provider";
import { getDatabase } from "@/lib/db/client";
import { getServerEnvironment } from "@/lib/validation/env";

/**
 * Monthly subscriptions (ADR-022, issue #95), and the maintainer's decisions of
 * 2026-09-19: unspent minutes expire at period end, a failed renewal has seven
 * days and three attempts before EXPIRED, and cancelling refunds nothing.
 *
 * A subscription buys **observation minutes**, not observations: the slot length
 * is not settled until DV-035 measures the optical train, and a plan denominated
 * in observations would change value underneath a customer who already bought one.
 *
 * Nothing here grants a minute. The grant is written by `settleSubscriptionPayment`
 * inside the settlement transaction, on capture, so there is no path that funds an
 * account before money arrives (ADR-022 section 6).
 *
 * What is missing, deliberately, and on its own branches: spending minutes at
 * reservation, and the renewal sweep with `chargeSavedInstrument`.
 */

/** As on bookings, packs and vouchers: the sandbox is never sold against in production. */
const PHASE_1_PROVIDER = "SANDBOX" as const;

/** A subscription that has ended grants nothing and blocks nothing. */
const FINISHED: readonly string[] = ["CANCELLED", "EXPIRED"];

type Refusal = {
  ok: false;
  status: 404 | 409 | 422 | 500 | 503;
  code: ErrorCode;
  message: string;
};

type SubscriptionRow = {
  id: string;
  plan: string;
  status: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  isDemo: boolean;
};

function toContractSubscription(
  row: SubscriptionRow,
  minuteBalance: number,
): ContractSubscription {
  return {
    subscriptionId: row.id,
    plan: row.plan as ContractSubscription["plan"],
    status: row.status as ContractSubscription["status"],
    currentPeriodStart: row.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    minuteBalance,
    isDemo: row.isDemo,
  };
}

/** The plans on sale, cheapest first. Empty until prices are configured. */
export async function readSubscriptionPlans(): Promise<SubscriptionPlanOption[]> {
  const rows = await getDatabase().subscriptionPlanConfig.findMany({
    where: { isAvailable: true },
    orderBy: { priceMinor: "asc" },
  });
  return rows.map((row) => ({
    plan: row.plan,
    nameEn: row.nameEn,
    nameKa: row.nameKa,
    priceMinor: row.priceMinor,
    currency: row.currency,
    minutesPerPeriod: row.minutesPerPeriod,
  }));
}

/**
 * The user's subscription, or null when they have never had one.
 *
 * `minuteBalance` is reported whatever the status says, because minutes already
 * granted outlive a cancellation: they belong to the period that was paid for and
 * expire with it, not with the subscription.
 */
export async function readMySubscription(
  userId: string,
): Promise<ContractSubscription | null> {
  const database = getDatabase();
  const row = await database.subscription.findUnique({ where: { userId } });
  if (!row) return null;
  return toContractSubscription(row, await readCreditBalance(database, userId));
}

/**
 * Subscribe to a plan, and open the payment that funds its first period.
 *
 * The subscription row exists before the money does, at ACTIVE with **no period**:
 * `currentPeriodStart` is null until a capture sets it, and every grant is keyed to
 * a period, so an unfunded subscription is one nothing can spend. A failed first
 * payment ends it rather than leaving it retryable -- nothing saved a card, so
 * there is no instrument for a retry to charge.
 */
export async function subscribe(input: {
  userId: string;
  request: SubscribeRequest;
  now: Date;
}): Promise<{ ok: true; body: SubscriptionWithPaymentIntent } | Refusal> {
  const { userId, request, now } = input;
  const database = getDatabase();

  if (getServerEnvironment().NODE_ENV === "production") {
    // ADR-022 section 11: BOG_IPAY has no adapter and the sandbox is refused in
    // production, so nothing sells there until the provider documentation arrives.
    return {
      ok: false,
      status: 500,
      code: "INTERNAL",
      message: "Subscriptions are unavailable: no payment provider is configured.",
    };
  }

  const available = await database.subscriptionPlanConfig.findMany({
    where: { isAvailable: true },
    select: { plan: true },
  });
  if (available.length === 0) {
    return {
      ok: false,
      status: 503,
      code: "INTERNAL",
      message: "No subscription plans are configured on this deployment.",
    };
  }

  const plan = await database.subscriptionPlanConfig.findUnique({
    where: { plan: request.plan },
  });
  if (!plan || !plan.isAvailable) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      message: "That plan is not on sale.",
    };
  }

  const opened = await database.$transaction(async (tx) => {
    // Locked before it is read, so two clicks cannot both see a finished
    // subscription and both open a payment against it. There is no row to lock
    // for a customer subscribing for the first time; `Subscription.userId` is
    // unique, so the loser of that race fails on the index instead.
    await tx.$queryRaw`SELECT "id" FROM "Subscription" WHERE "userId" = ${userId}::uuid FOR UPDATE`;
    const existing = await tx.subscription.findUnique({ where: { userId } });
    if (existing && !FINISHED.includes(existing.status)) {
      // A plan change is a cancellation and a new subscription, not an edit: the
      // period in flight is already paid for and its minutes already granted.
      return null;
    }

    // One row per user, so a customer who comes back reuses it. The period fields
    // are cleared with it: whatever the last subscription was funded for is over,
    // and leaving a stale period would make the sweep read an unfunded row as due
    // for renewal.
    const subscription = await tx.subscription.upsert({
      where: { userId },
      create: {
        userId,
        plan: plan.plan,
        status: "ACTIVE",
        startsAt: now,
        priceMinor: plan.priceMinor,
        currency: plan.currency,
      },
      update: {
        plan: plan.plan,
        status: "ACTIVE",
        startsAt: now,
        endsAt: null,
        priceMinor: plan.priceMinor,
        currency: plan.currency,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        pausedAt: null,
        providerMandateRef: null,
        lastPaymentId: null,
      },
    });

    const payment = await tx.payment.create({
      data: {
        userId,
        purpose: "SUBSCRIPTION",
        provider: PHASE_1_PROVIDER,
        status: "PENDING",
        amountMinor: plan.priceMinor,
        currency: plan.currency,
        subscriptionId: subscription.id,
        // Null on purpose. The unique on (subscriptionId, periodStart) is what
        // makes the renewal sweep idempotent, and this payment is not a renewal:
        // the period it funds begins when it captures, which has not happened.
        periodStart: null,
        isDemo: subscription.isDemo,
      },
    });

    await recordAuditEvent(
      {
        category: "SUBSCRIPTION",
        action: "SUBSCRIPTION_ORDERED",
        actorUserId: userId,
        entityType: "Subscription",
        entityId: subscription.id,
        detail: {
          plan: plan.plan,
          priceMinor: plan.priceMinor,
          currency: plan.currency,
          minutesPerPeriod: plan.minutesPerPeriod,
          paymentId: payment.id,
        },
        isDemo: subscription.isDemo,
      },
      tx,
    );

    return { subscription, payment };
  });

  if (!opened) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "That account already has a subscription.",
    };
  }
  const { subscription, payment } = opened;

  return {
    ok: true,
    body: {
      subscription: toContractSubscription(
        subscription,
        await readCreditBalance(database, userId),
      ),
      paymentIntent: {
        paymentId: payment.id,
        provider: payment.provider,
        status: payment.status,
        redirectUrl: payment.redirectUrl,
        expiresAt: null,
      },
    },
  };
}

/**
 * Stop charging and granting, at the customer's own request (ADR-022 section 9).
 *
 * Minutes already granted stay spendable until the period they belong to expires.
 * Pausing is not a way to bank them, and the expiry sweep does not consult the
 * pause: the period was paid for, and it ends when it ends.
 */
export async function pauseMySubscription(input: {
  userId: string;
  now: Date;
}): Promise<{ ok: true; body: ContractSubscription } | Refusal> {
  return transition(input.userId, (row) => {
    if (row.status === "PAUSED") return { data: {} };
    if (row.status !== "ACTIVE") {
      return {
        refusal: {
          ok: false,
          status: 409,
          code: "CONFLICT",
          message: "Only an active subscription can be paused.",
        },
      };
    }
    return {
      data: { status: "PAUSED", pausedAt: input.now },
      audit: { action: "SUBSCRIPTION_PAUSED", detail: {} },
    };
  });
}

/**
 * Resume a paused subscription. The sweep charges it at the end of its period.
 *
 * It undoes a pause and nothing else. A subscription that is already ending --
 * cancelled, or running out its last funded period -- is refused rather than
 * answered 200, because a 200 here would read as "the cancellation is off" while
 * `cancelAtPeriodEnd` still stood. Un-cancelling is not something ADR-022
 * describes, and inventing it quietly is worse than not having it.
 */
export async function resumeMySubscription(input: {
  userId: string;
}): Promise<{ ok: true; body: ContractSubscription } | Refusal> {
  return transition(input.userId, (row) => {
    if (row.cancelAtPeriodEnd) {
      return {
        refusal: {
          ok: false,
          status: 409,
          code: "CONFLICT",
          message: "That subscription is ending and cannot be resumed.",
        },
      };
    }
    if (row.status === "ACTIVE") return { data: {} };
    if (row.status !== "PAUSED") {
      return {
        refusal: {
          ok: false,
          status: 409,
          code: "CONFLICT",
          message: "Only a paused subscription can be resumed.",
        },
      };
    }
    return {
      data: { status: "ACTIVE", pausedAt: null },
      audit: { action: "SUBSCRIPTION_RESUMED", detail: {} },
    };
  });
}

/**
 * Cancel, without a refund (ADR-022 section 9, and the maintainer's decision of
 * 2026-09-19).
 *
 * A period that has been paid for runs to its end: the subscription keeps its
 * status, `cancelAtPeriodEnd` stops the renewal, and the minutes stay spendable
 * until they expire with the period. Only a subscription with no funded period --
 * never paid, or already lapsed -- ends here and now, because there is nothing
 * left to run out.
 */
export async function cancelMySubscription(input: {
  userId: string;
  now: Date;
}): Promise<{ ok: true; body: ContractSubscription } | Refusal> {
  const { now } = input;
  return transition(input.userId, (row) => {
    if (FINISHED.includes(row.status)) {
      return {
        refusal: {
          ok: false,
          status: 409,
          code: "CONFLICT",
          message: "That subscription has already ended.",
        },
      };
    }

    const funded = row.currentPeriodEnd !== null && row.currentPeriodEnd > now;
    if (funded) {
      if (row.cancelAtPeriodEnd) return { data: {} };
      return {
        data: { cancelAtPeriodEnd: true },
        audit: {
          action: "SUBSCRIPTION_CANCEL_SCHEDULED",
          detail: { currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null },
        },
      };
    }

    return {
      data: { status: "CANCELLED", endsAt: now, cancelAtPeriodEnd: false },
      audit: { action: "SUBSCRIPTION_CANCELLED", detail: { immediate: true } },
    };
  });
}

type Decision =
  | { data: Prisma.SubscriptionUpdateInput; audit?: { action: AuditAction; detail: Prisma.InputJsonValue }; refusal?: never }
  | { refusal: Refusal; data?: never; audit?: never };

/**
 * The three customer-driven changes share this: find the row, decide, write, audit.
 *
 * The row is locked before the decision, so two clicks on pause and cancel cannot
 * both read ACTIVE and both act on it. A decision that changes nothing -- pausing
 * a paused subscription -- writes no row and no audit event, which is what makes
 * these endpoints idempotent rather than merely tolerant.
 */
async function transition(
  userId: string,
  decide: (row: SubscriptionRow) => Decision,
): Promise<{ ok: true; body: ContractSubscription } | Refusal> {
  const database = getDatabase();

  return database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Subscription" WHERE "userId" = ${userId}::uuid FOR UPDATE`;
    const row = await tx.subscription.findUnique({ where: { userId } });
    if (!row) {
      return {
        ok: false as const,
        status: 404 as const,
        code: "NOT_FOUND" as const,
        message: "That account has no subscription.",
      };
    }

    const decision = decide(row);
    if (decision.refusal) return decision.refusal;

    const changed =
      Object.keys(decision.data).length > 0
        ? await tx.subscription.update({ where: { userId }, data: decision.data })
        : row;

    if (decision.audit) {
      await recordAuditEvent(
        {
          category: "SUBSCRIPTION",
          action: decision.audit.action,
          actorUserId: userId,
          entityType: "Subscription",
          entityId: row.id,
          detail: { plan: row.plan, ...(decision.audit.detail as object) },
          isDemo: row.isDemo,
        },
        tx,
      );
    }

    return {
      ok: true as const,
      body: toContractSubscription(changed, await readCreditBalance(tx, userId)),
    };
  });
}

/**
 * Apply a verified outcome to the subscription a payment funds (ADR-022 section 6).
 *
 * Called by `settlePayment` after the checks every payment gets, inside its
 * transaction and under its payment lock, so a repeated callback has already been
 * answered there and this runs exactly once per outcome.
 *
 * **The grant is the point.** It is written here, keyed to the period, and nowhere
 * else -- so a webhook delivered twice, a sweep that ran on two processes and a
 * retried charge all converge on one grant of one period's minutes.
 */
export async function settleSubscriptionPayment(
  tx: Prisma.TransactionClient,
  payment: {
    id: string;
    userId: string;
    isDemo: boolean;
    provider: string;
    amountMinor: number;
    subscriptionId: string | null;
    periodStart: Date | null;
  },
  outcome: PaymentOutcome,
  now: Date,
): Promise<{ ok: true; applied: true; missionId: null }> {
  // Only this module writes a SUBSCRIPTION payment, and it writes the subscription
  // in the same transaction. A null here is our own bug, and it should be loud.
  if (!payment.subscriptionId) {
    throw new Error(`Payment ${payment.id} is for a subscription and names none.`);
  }
  const subscription = await tx.subscription.findUniqueOrThrow({
    where: { id: payment.subscriptionId },
  });

  if (outcome.result === "FAILED") {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "FAILED",
        providerRef: outcome.providerRef,
        failureReason: outcome.failureReason,
      },
    });

    // A subscription that was never funded ends here: nothing saved a card, so no
    // retry can reach an instrument and a grace period would be a wait for
    // something that cannot arrive. A funded one keeps its period and stays
    // ACTIVE while the sweep retries -- ADR-022 section 9, and the renewal branch
    // is what implements the seven days.
    const neverFunded = subscription.currentPeriodStart === null;
    if (neverFunded) {
      await tx.subscription.update({
        where: { id: subscription.id },
        data: { status: "EXPIRED", endsAt: now },
      });
    }

    await recordAuditEvent(
      {
        category: "SUBSCRIPTION",
        action: "SUBSCRIPTION_PAYMENT_FAILED",
        actorUserId: payment.userId,
        entityType: "Subscription",
        entityId: subscription.id,
        detail: {
          provider: payment.provider,
          providerRef: outcome.providerRef,
          paymentId: payment.id,
          failureReason: outcome.failureReason,
          plan: subscription.plan,
          subscriptionExpired: neverFunded,
        },
        isDemo: payment.isDemo,
      },
      tx,
    );

    return { ok: true, applied: true, missionId: null };
  }

  await tx.payment.update({
    where: { id: payment.id },
    data: { status: "CAPTURED", providerRef: outcome.providerRef, capturedAt: now },
  });

  // A renewal names the period it was opened for; a first payment funds the period
  // that starts when the money arrives.
  const periodStart = payment.periodStart ?? now;
  const periodEnd = nextPeriodEnd(periodStart);

  // Read now rather than trusting the price the order was opened at: the grant is
  // what this plan gives today. The row is never deleted -- there is one per enum
  // member -- so a missing one is a broken deployment and not a customer's problem
  // to absorb silently.
  const plan = await tx.subscriptionPlanConfig.findUniqueOrThrow({
    where: { plan: subscription.plan },
  });

  // A customer who cancelled while the bank was still thinking has paid for a
  // period, and ADR-022 gives them the minutes it bought. What they do not get is
  // their subscription restarted, so a finished status stands. A paused one stays
  // paused for the same reason: this capture is not an act of theirs.
  const status =
    FINISHED.includes(subscription.status) || subscription.status === "PAUSED"
      ? subscription.status
      : "ACTIVE";

  await tx.subscription.update({
    where: { id: subscription.id },
    data: {
      status,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      lastPaymentId: payment.id,
      // Kept when the provider does not restate it: the mandate outlives the
      // charge that created it, and clearing it would strand the sweep.
      providerMandateRef: outcome.mandateRef ?? subscription.providerMandateRef,
    },
  });

  const granted = await grantSubscriptionMinutes(
    tx,
    subscription,
    periodStart,
    plan.minutesPerPeriod,
  );

  await recordAuditEvent(
    {
      category: "SUBSCRIPTION",
      action:
        payment.periodStart === null ? "SUBSCRIPTION_ACTIVATED" : "SUBSCRIPTION_RENEWED",
      actorUserId: payment.userId,
      entityType: "Subscription",
      entityId: subscription.id,
      detail: {
        provider: payment.provider,
        providerRef: outcome.providerRef,
        paymentId: payment.id,
        amountMinor: outcome.amountMinor,
        currency: outcome.currency,
        plan: subscription.plan,
        minutesGranted: granted.posted ? plan.minutesPerPeriod : 0,
        currentPeriodStart: periodStart.toISOString(),
        currentPeriodEnd: periodEnd.toISOString(),
        status,
      },
      isDemo: payment.isDemo,
    },
    tx,
  );

  // ADR-022 section 3: a subscription payment is money, and money earns points
  // like any other payment. Spending the minutes it buys earns nothing.
  await earnOnSettledPayment(tx, payment, null);

  return { ok: true, applied: true, missionId: null };
}
