import "server-only";

import type { Currency } from "@darkview/contracts";

import type { PaymentOutcome } from "@/features/payments/provider";

/**
 * ADR-073. Bank of Georgia's e-commerce API (api.bog.ge/payments/v1), the one
 * astroman.ge's WooCommerce gateway has taken real payments through since
 * 2026-09 on the same merchant profile. Every field below is one that gateway
 * sends or reads; nothing here is new to the bank.
 *
 * The contract's provider value is still `BOG_IPAY`: it names the bank, and
 * renaming an enum would cost a migration for no change in behaviour.
 */

const OAUTH_URL = "https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token";
const API_BASE = "https://api.bog.ge/payments/v1";

export type BogCredentials = { clientId: string; secretKey: string };

type Fetch = typeof fetch;

let cachedToken: { key: string; token: string; expiresAt: number } | null = null;

async function accessToken(credentials: BogCredentials, fetcher: Fetch): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.key === credentials.clientId && cachedToken.expiresAt > now) {
    return cachedToken.token;
  }

  const basic = Buffer.from(`${credentials.clientId}:${credentials.secretKey}`).toString("base64");
  const response = await fetcher(OAUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!response.ok || !body.access_token) {
    throw new Error(`BOG sign-in failed (HTTP ${response.status}).`);
  }

  // A minute early, so a token is never presented in its last seconds.
  const lifetime = Math.max(60, (body.expires_in ?? 600) - 60);
  cachedToken = { key: credentials.clientId, token: body.access_token, expiresAt: now + lifetime * 1000 };
  return body.access_token;
}

/** For tests: forget the cached token. */
export function forgetBogToken() {
  cachedToken = null;
}

export type BogOrderInput = {
  paymentId: string;
  amountMinor: number;
  currency: Currency;
  description: string;
  locale: "en" | "ka";
  callbackUrl: string;
  successUrl: string;
  failUrl: string;
  /** Minutes the bank keeps its page open; the bank's own default is 15. */
  ttlMinutes: number;
};

/** The create-order body, the shape the astroman.ge gateway sends. */
export function bogOrderPayload(input: BogOrderInput, minimal = false) {
  const amount = input.amountMinor / 100;
  const payload: Record<string, unknown> = {
    callback_url: input.callbackUrl,
    external_order_id: input.paymentId,
    purchase_units: {
      currency: input.currency,
      total_amount: amount,
      // One line equal to the total, so the basket can never disagree with the charge.
      basket: [
        {
          product_id: input.paymentId,
          description: input.description,
          quantity: 1,
          unit_price: amount,
        },
      ],
    },
    redirect_urls: { success: input.successUrl, fail: input.failUrl },
  };
  if (!minimal) payload.ttl = input.ttlMinutes;
  return payload;
}

/** The bank's own page must be the bank's: anything else is not followed. */
function bankRedirect(body: Record<string, unknown>): string | null {
  const links = (body._links ?? body.links) as { redirect?: { href?: unknown } } | undefined;
  const href = links?.redirect?.href;
  if (typeof href !== "string") return null;
  try {
    const url = new URL(href);
    const bank = url.hostname === "bog.ge" || url.hostname.endsWith(".bog.ge");
    return url.protocol === "https:" && bank ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Open the bank's order and return where to send the payer.
 *
 * Keyed by the payment id, so two presses of the same button open one order. If
 * the bank refuses the full body, it is sent once more without the payment
 * window -- the gateway's lesson: an option the bank will not take must never
 * take checkout down.
 */
export async function createBogOrder(
  credentials: BogCredentials,
  input: BogOrderInput,
  fetcher: Fetch = fetch,
): Promise<{ orderId: string; redirectUrl: string }> {
  const token = await accessToken(credentials, fetcher);

  const attempt = async (minimal: boolean) => {
    const response = await fetcher(`${API_BASE}/ecommerce/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Language": input.locale,
        "Idempotency-Key": input.paymentId,
      },
      body: JSON.stringify(bogOrderPayload(input, minimal)),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const redirectUrl = bankRedirect(body);
    if (!response.ok || typeof body.id !== "string" || !redirectUrl) {
      return { ok: false as const, status: response.status };
    }
    return { ok: true as const, orderId: body.id, redirectUrl };
  };

  const first = await attempt(false);
  if (first.ok) return { orderId: first.orderId, redirectUrl: first.redirectUrl };
  const second = await attempt(true);
  if (second.ok) return { orderId: second.orderId, redirectUrl: second.redirectUrl };
  throw new Error(`BOG refused the order (HTTP ${first.status}, then ${second.status}).`);
}

/** The bank's own record of an order, read over an authenticated call. */
export async function fetchBogReceipt(
  credentials: BogCredentials,
  orderId: string,
  fetcher: Fetch = fetch,
): Promise<Record<string, unknown>> {
  const token = await accessToken(credentials, fetcher);
  const response = await fetcher(`${API_BASE}/receipt/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`BOG receipt read failed (HTTP ${response.status}).`);
  return (await response.json()) as Record<string, unknown>;
}

function minor(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0
    ? Math.round(number * 100)
    : null;
}

/**
 * A receipt, read into Darkview's terms.
 *
 * `null` while the bank is still waiting (created, in progress) and for the
 * refund states, which this side starts itself and does not settle from. A
 * receipt for another payment than the one asked about is not read at all.
 */
export function outcomeFromBogReceipt(
  paymentId: string,
  orderId: string,
  receipt: Record<string, unknown>,
): PaymentOutcome | null {
  if (receipt.external_order_id !== paymentId) return null;

  const status = (receipt.order_status as { key?: unknown } | undefined)?.key;
  const units = (receipt.purchase_units ?? {}) as Record<string, unknown>;
  const currency = units.currency_code;
  // The contract sells in lari only.
  if (currency !== "GEL") return null;

  if (status === "completed") {
    // What the bank took; the requested sum only when it does not say.
    const amountMinor = minor(units.transfer_amount) || minor(units.request_amount);
    if (amountMinor === null) return null;
    return {
      paymentId,
      providerRef: orderId,
      result: "CAPTURED",
      amountMinor,
      currency,
      failureReason: null,
    };
  }

  if (status === "rejected") {
    const reason = typeof receipt.reject_reason === "string" ? receipt.reject_reason : "";
    return {
      paymentId,
      providerRef: orderId,
      result: "FAILED",
      amountMinor: minor(units.request_amount) ?? 0,
      currency,
      // An expired order: the payer never entered a card.
      failureReason: reason === "expiration" ? "PAYMENT_EXPIRED" : (reason || "PAYMENT_REJECTED").slice(0, 256),
    };
  }

  return null;
}
