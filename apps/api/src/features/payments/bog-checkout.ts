import "server-only";

import type { PaymentProvider } from "@darkview/contracts";
import { recordAuditEvent } from "@darkview/db/audit";

import {
  createBogOrder,
  fetchBogReceipt,
  outcomeFromBogReceipt,
  type BogCredentials,
} from "@/features/payments/bog";
import { sandboxCheckoutUrl, holdIsOpen, loadOwnPayment } from "@/features/payments/sandbox-checkout";
import { settlePayment } from "@/features/payments/settle";
import { sandboxMoneyAllowed } from "@/lib/deployment";
import { getDatabase } from "@/lib/db/client";
import { getServerEnvironment } from "@/lib/validation/env";

/**
 * ADR-073. Bank of Georgia as the payment provider.
 *
 * A payment opened with BOG_IPAY carries a `redirectUrl` to this API's own
 * `/payments/{paymentId}/checkout`. Following it opens the bank's order -- late,
 * so that a reservation's transaction never waits on the bank -- and sends the
 * payer to the bank's page. The bank calls `/payments/bog/callback`; that body is
 * only ever a hint of which order to look at. What settles a payment is the
 * receipt this API reads back from the bank itself, as the astroman.ge gateway
 * does.
 */

function credentials(): BogCredentials | null {
  const { BOG_CLIENT_ID, BOG_SECRET_KEY } = getServerEnvironment();
  return BOG_CLIENT_ID && BOG_SECRET_KEY ? { clientId: BOG_CLIENT_ID, secretKey: BOG_SECRET_KEY } : null;
}

/**
 * The provider a payment opened now is opened with, or null when this deployment
 * can take none: SANDBOX where it is not allowed (never in production), or BOG
 * without the merchant's keys. A sale with no provider is refused before anything
 * is held -- selling against a payment that cannot be taken is worse than an outage.
 */
export function paymentProvider(): PaymentProvider | null {
  const environment = getServerEnvironment();
  const provider =
    environment.PAYMENT_PROVIDER ?? (sandboxMoneyAllowed(environment) ? "SANDBOX" : "BOG_IPAY");
  if (provider === "SANDBOX") return sandboxMoneyAllowed(environment) ? provider : null;
  return credentials() ? provider : null;
}

/** The provider and `redirectUrl` of a payment being opened. Call after `paymentProvider()`. */
export function paymentCheckout(paymentId: string): { provider: PaymentProvider; redirectUrl: string } {
  const provider = paymentProvider() ?? "SANDBOX";
  if (provider === "SANDBOX") return { provider, redirectUrl: sandboxCheckoutUrl(paymentId) };
  return {
    provider,
    redirectUrl: new URL(`/api/payments/${paymentId}/checkout`, getServerEnvironment().APP_URL).toString(),
  };
}

/** The bank's page stays open for a gift, which holds nothing scarce. */
const GIFT_WINDOW_MINUTES = 60;

const DESCRIPTION = {
  BOOKING: { en: "Stellar observing session", ka: "Stellar-ის დაკვირვების სეანსი" },
  OBSERVER_PACK: { en: "Stellar observer seat", ka: "Stellar-ის მაყურებლის ადგილი" },
  GIFT_VOUCHER: { en: "Stellar gift night", ka: "Stellar-ის სასაჩუქრე ღამე" },
} as const;

export type BogCheckoutResult =
  | { ok: true; location: string }
  | { ok: false; status: 404 | 409 | 503; code: "NOT_FOUND" | "CONFLICT" | "INTERNAL"; message: string };

/**
 * GET /payments/{paymentId}/checkout: where the payer goes next.
 *
 * The bank's page while the payment is open; the purchase's own page once it is
 * paid, failed, or its hold has lapsed, where the website says which. An order is
 * opened once: its bank id and page are written to the payment, and a second
 * visit is sent to the same page.
 */
export async function openBogCheckout(input: {
  userId: string;
  paymentId: string;
  now: Date;
}): Promise<BogCheckoutResult> {
  const loaded = await loadOwnPayment(input.userId, input.paymentId, "BOG_IPAY");
  if (!loaded.ok) {
    return loaded.status === 404
      ? { ok: false, status: 404, code: "NOT_FOUND", message: loaded.message }
      : { ok: false, status: 409, code: "CONFLICT", message: loaded.message };
  }

  const { payment, hold, returnUrl, purpose } = loaded;
  if (payment.status !== "PENDING" || !holdIsOpen(hold, input.now)) {
    return { ok: true, location: returnUrl };
  }

  const database = getDatabase();
  const opened = await database.payment.findUnique({
    where: { id: payment.id },
    select: { providerRef: true, redirectUrl: true },
  });
  // Written together below, so a payment with the bank's id has the bank's page.
  if (opened?.providerRef && opened.redirectUrl) {
    return { ok: true, location: opened.redirectUrl };
  }

  const keys = credentials();
  if (!keys) {
    return {
      ok: false,
      status: 503,
      code: "INTERNAL",
      message: "Card payments are not configured.",
    };
  }

  const locale = loaded.locale === "ka" ? "ka" : "en";
  const ttlMinutes = hold.holdExpiresAt
    ? Math.max(2, Math.ceil((hold.holdExpiresAt.getTime() - input.now.getTime()) / 60_000))
    : GIFT_WINDOW_MINUTES;
  const { APP_URL } = getServerEnvironment();

  let order: { orderId: string; redirectUrl: string };
  try {
    order = await createBogOrder(keys, {
      paymentId: payment.id,
      amountMinor: payment.amountMinor,
      currency: payment.currency as "GEL",
      description: DESCRIPTION[purpose][locale],
      locale,
      callbackUrl: new URL("/api/payments/bog/callback", APP_URL).toString(),
      successUrl: returnUrl,
      failUrl: returnUrl,
      ttlMinutes,
    });
  } catch (error) {
    console.error("[bog] order not opened", { paymentId: payment.id, error: String(error) });
    return {
      ok: false,
      status: 503,
      code: "INTERNAL",
      message: "The bank could not be reached. Try again in a moment.",
    };
  }

  // Only the first opening is kept; the bank keyed both by this payment's id.
  await database.payment.updateMany({
    where: { id: payment.id, providerRef: null },
    data: { providerRef: order.orderId, redirectUrl: order.redirectUrl },
  });
  return { ok: true, location: order.redirectUrl };
}

export type BogCallbackResult = { status: 200 | 400 | 502 | 503 };

/**
 * POST /payments/bog/callback.
 *
 * 200 for anything the bank should stop repeating -- settled, already settled,
 * not ours, still waiting (the bank calls again when it changes). 502 when the
 * receipt could not be read, so the bank tries again. A refused settlement is
 * already in the audit log by `settlePayment` and is a 200: repeating it would
 * change nothing.
 */
export async function receiveBogCallback(rawBody: string, now: Date): Promise<BogCallbackResult> {
  let data: unknown;
  try {
    data = JSON.parse(rawBody);
  } catch {
    return { status: 400 };
  }
  const envelope = (data ?? {}) as Record<string, unknown>;
  const body = (typeof envelope.body === "object" && envelope.body ? envelope.body : envelope) as Record<
    string,
    unknown
  >;
  const orderId = typeof body.order_id === "string" ? body.order_id : null;
  if (!orderId) return { status: 400 };

  const keys = credentials();
  if (!keys) return { status: 503 };

  const payment = await getDatabase().payment.findUnique({
    where: { provider_providerRef: { provider: "BOG_IPAY", providerRef: orderId } },
    select: { id: true },
  });
  if (!payment) {
    await recordAuditEvent(
      {
        category: "PAYMENT",
        action: "PAYMENT_WEBHOOK_REFUSED",
        detail: { provider: "BOG_IPAY", reason: "UNKNOWN_ORDER", orderId },
      },
      getDatabase(),
    );
    return { status: 200 };
  }

  let receipt: Record<string, unknown>;
  try {
    receipt = await fetchBogReceipt(keys, orderId);
  } catch (error) {
    console.error("[bog] receipt not read", { orderId, error: String(error) });
    return { status: 502 };
  }

  const outcome = outcomeFromBogReceipt(payment.id, orderId, receipt);
  if (!outcome) return { status: 200 };

  await settlePayment({ provider: "BOG_IPAY", outcome, now });
  return { status: 200 };
}
