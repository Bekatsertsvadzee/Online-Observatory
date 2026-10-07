import "server-only";

import type { ErrorCode, SandboxCheckoutResult } from "@darkview/contracts";

import { TERMINAL_MISSION_STATES } from "@/features/missions/session";
import { resolvePaymentProvider, type PaymentProviderAdapter } from "@/features/payments/provider";
import { settlePayment } from "@/features/payments/settle";
import { getDatabase } from "@/lib/db/client";
import { defaultLocale, isLocale } from "@/lib/locale";
import { getServerEnvironment } from "@/lib/validation/env";

/**
 * #149. The sandbox's stand-in for a provider's hosted checkout.
 *
 * DV-056 settled a SANDBOX payment only on a callback signed with a secret no
 * client may hold, so a customer could reserve and then only watch the hold
 * lapse. Here the cloud plays the provider's part: `createBooking` and
 * `purchaseObserverPack` (#170) hand out a `redirectUrl` to a page it serves, the
 * payer answers "pay" or "decline" on it, and that answer is settled through
 * `settlePayment` -- the same function a verified webhook reaches, so a booking or
 * a seat confirmed here is confirmed exactly as one confirmed by a provider would be.
 *
 * What stands in for the provider's signature is the session plus the Origin
 * check every mutation already makes, and ownership: only the person who opened
 * the payment can answer it. It exists only where `resolvePaymentProvider`
 * accepts SANDBOX at all, which is never in production.
 */

export type SandboxCheckoutFailure = {
  ok: false;
  status: 404 | 409 | 500;
  code: ErrorCode;
  message: string;
};

export type SandboxCheckoutView = {
  ok: true;
  paymentId: string;
  amountMinor: number;
  currency: string;
  paymentStatus: string;
  /** What the payment buys, for the page's wording. */
  purpose: "BOOKING" | "OBSERVER_PACK";
  /** False once the hold has lapsed or the booking or seat has moved on without paying. */
  payable: boolean;
  holdExpiresAt: Date | null;
  returnUrl: string;
};

export type SandboxCheckoutConfirmed = {
  ok: true;
  /** False when the payment had already been answered this way. */
  applied: boolean;
  returnUrl: string;
};

/** The path, relative to the API's own root, the checkout is served at. */
export function sandboxCheckoutPath(paymentId: string): string {
  return `/payments/${paymentId}/sandbox-checkout`;
}

/**
 * The `redirectUrl` a booking's or an Observer Pack's SANDBOX payment carries.
 *
 * On the web client's origin under `/api`, because ADR-016 §4 serves the API
 * there: the browser that follows it sends the session cookie and, when the
 * customer confirms, an Origin the mutation guard accepts.
 */
export function sandboxCheckoutUrl(paymentId: string): string {
  return new URL(`/api${sandboxCheckoutPath(paymentId)}`, getServerEnvironment().APP_URL).toString();
}

/**
 * The booking's page on the web client -- the only place the checkout sends
 * anybody. Built from APP_URL and the booking id, never from the request, so the
 * checkout cannot be used to redirect anywhere else.
 */
export function bookingReturnUrl(locale: string, bookingId: string): string {
  const path = `/${isLocale(locale) ? locale : defaultLocale}/app/bookings/${bookingId}`;
  return new URL(path, getServerEnvironment().APP_URL).toString();
}

/**
 * #170. The watch page of the mission an Observer Pack is for, built the same way
 * as `bookingReturnUrl`: from APP_URL and the pack's mission, never the request.
 */
export function watchReturnUrl(locale: string, missionId: string): string {
  const path = `/${isLocale(locale) ? locale : defaultLocale}/app/missions/${missionId}/watch`;
  return new URL(path, getServerEnvironment().APP_URL).toString();
}

const notFound: SandboxCheckoutFailure = {
  ok: false,
  status: 404,
  code: "NOT_FOUND",
  message: "No such payment.",
};

function conflict(message: string): SandboxCheckoutFailure {
  return { ok: false, status: 409, code: "CONFLICT", message };
}

type Loaded =
  | SandboxCheckoutFailure
  | {
      ok: true;
      adapter: PaymentProviderAdapter;
      payment: {
        id: string;
        status: string;
        amountMinor: number;
        currency: string;
      };
      purpose: "BOOKING" | "OBSERVER_PACK";
      /**
       * What the payment holds: a booking's slot, or an Observer Pack's seat, whose
       * mission must not have ended. A seat on a finished session can never be used.
       */
      hold: { status: string; holdExpiresAt: Date | null; missionEnded: boolean };
      returnUrl: string;
    };

/**
 * The payment, if the checkout exists here and the payment is the caller's own
 * SANDBOX payment for a booking or an Observer Pack (#170).
 *
 * Unavailable and not-yours are the same 404, so the checkout says nothing about
 * payments belonging to anybody else, nor about whether this deployment could
 * have served one.
 */
async function loadCheckout(userId: string, paymentId: string): Promise<Loaded> {
  const sandbox = resolvePaymentProvider("SANDBOX");
  if (!sandbox.ok) return notFound;

  const payment = await getDatabase().payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      userId: true,
      provider: true,
      purpose: true,
      status: true,
      amountMinor: true,
      currency: true,
      user: { select: { locale: true } },
      booking: { select: { id: true, status: true, holdExpiresAt: true } },
      // The pack whose current payment this is. A pack bought again on a newer
      // payment no longer points here, so an old checkout finds nothing to pay for.
      observerPack: {
        select: {
          status: true,
          holdExpiresAt: true,
          missionId: true,
          mission: { select: { state: true } },
        },
      },
    },
  });

  if (!payment || payment.userId !== userId) return notFound;

  if (payment.provider !== "SANDBOX") {
    return conflict("This payment is not a sandbox payment.");
  }

  if (payment.purpose === "BOOKING" && payment.booking) {
    return {
      ok: true,
      adapter: sandbox.adapter,
      payment,
      purpose: "BOOKING",
      hold: { ...payment.booking, missionEnded: false },
      returnUrl: bookingReturnUrl(payment.user.locale, payment.booking.id),
    };
  }

  if (payment.purpose === "OBSERVER_PACK" && payment.observerPack) {
    const pack = payment.observerPack;
    return {
      ok: true,
      adapter: sandbox.adapter,
      payment,
      purpose: "OBSERVER_PACK",
      hold: {
        status: pack.status,
        holdExpiresAt: pack.holdExpiresAt,
        missionEnded: (TERMINAL_MISSION_STATES as readonly string[]).includes(pack.mission.state),
      },
      returnUrl: watchReturnUrl(payment.user.locale, pack.missionId),
    };
  }

  return conflict("This payment is not a sandbox booking or seat payment.");
}

/**
 * Still held for the payer: awaiting payment, before its deadline, and -- for a seat
 * -- on a mission that has not ended.
 */
function holdIsOpen(
  hold: { status: string; holdExpiresAt: Date | null; missionEnded: boolean },
  now: Date,
): boolean {
  return (
    hold.status === "PENDING_PAYMENT" &&
    hold.holdExpiresAt !== null &&
    hold.holdExpiresAt.getTime() > now.getTime() &&
    !hold.missionEnded
  );
}

export async function readSandboxCheckout(input: {
  userId: string;
  paymentId: string;
  now: Date;
}): Promise<SandboxCheckoutView | SandboxCheckoutFailure> {
  const loaded = await loadCheckout(input.userId, input.paymentId);
  if (!loaded.ok) return loaded;

  return {
    ok: true,
    paymentId: loaded.payment.id,
    amountMinor: loaded.payment.amountMinor,
    currency: loaded.payment.currency,
    paymentStatus: loaded.payment.status,
    purpose: loaded.purpose,
    payable: loaded.payment.status === "PENDING" && holdIsOpen(loaded.hold, input.now),
    holdExpiresAt: loaded.hold.holdExpiresAt,
    returnUrl: loaded.returnUrl,
  };
}

/**
 * Apply the customer's answer.
 *
 * Idempotent by payment: the ref is derived from the payment id, so a second
 * submit -- a double click, a reload of the POST -- either finds the payment
 * already answered this way and changes nothing, or reaches `settlePayment`,
 * which recognises the same (provider, providerRef, result) under its row lock.
 *
 * A lapsed hold is refused before anything is settled. `settlePayment` itself
 * would record a late provider capture as captured-without-slot, because a real
 * bank's money has already moved by then; nothing has moved here, so the honest
 * answer is to take no money for a slot the customer no longer holds. The same
 * goes for a seat whose hold lapsed or whose mission has ended (#170).
 */
export async function confirmSandboxCheckout(input: {
  userId: string;
  paymentId: string;
  result: SandboxCheckoutResult;
  now: Date;
}): Promise<SandboxCheckoutConfirmed | SandboxCheckoutFailure> {
  const loaded = await loadCheckout(input.userId, input.paymentId);
  if (!loaded.ok) return loaded;

  const { adapter, payment, hold, returnUrl } = loaded;

  if (payment.status === "CAPTURED" || payment.status === "FAILED") {
    if (payment.status === input.result) return { ok: true, applied: false, returnUrl };
    return conflict("This payment has already been answered differently.");
  }
  if (payment.status !== "PENDING") {
    return conflict("This payment can no longer be answered.");
  }

  if (!holdIsOpen(hold, input.now)) {
    return conflict(
      loaded.purpose === "BOOKING"
        ? "The hold on this slot has lapsed."
        : "The hold on this seat has lapsed, or its session has ended.",
    );
  }

  const outcome = adapter.readOutcome({
    paymentId: payment.id,
    providerRef: `sandbox-checkout:${payment.id}`,
    result: input.result,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
  });
  if (!outcome) {
    return { ok: false, status: 500, code: "INTERNAL", message: "The sandbox outcome could not be read." };
  }

  const settled = await settlePayment({ provider: adapter.provider, outcome, now: input.now });
  if (!settled.ok) return conflict(settled.message);

  return { ok: true, applied: settled.applied, returnUrl };
}
