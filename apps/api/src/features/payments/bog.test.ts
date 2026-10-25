import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { bogOrderPayload, createBogOrder, fetchBogReceipt, forgetBogToken, outcomeFromBogReceipt } =
  await import("./bog");

const KEYS = { clientId: "99971", secretKey: "unit-test-secret" };
const PAYMENT_ID = "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e02";

const order = {
  paymentId: PAYMENT_ID,
  amountMinor: 4500,
  currency: "GEL" as const,
  description: "Stellar observing session",
  locale: "ka" as const,
  callbackUrl: "https://stellar.test/api/payments/bog/callback",
  successUrl: "https://stellar.test/ka/app/bookings/b1",
  failUrl: "https://stellar.test/ka/app/bookings/b1",
  ttlMinutes: 12,
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function bank(...answers: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (String(url).includes("oauth2.bog.ge")) return json(200, { access_token: "tok", expires_in: 600 });
    const next = answers.shift();
    if (!next) throw new Error("unexpected call");
    return next;
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

const created = {
  id: "bog-order-1",
  _links: { redirect: { href: "https://payment.bog.ge/?order_id=bog-order-1" } },
};

beforeEach(() => forgetBogToken());

describe("the order Stellar opens at the bank (ADR-073)", () => {
  it("is the astroman.ge gateway's body: one basket line equal to the total, and a window", () => {
    expect(bogOrderPayload(order)).toEqual({
      callback_url: order.callbackUrl,
      external_order_id: PAYMENT_ID,
      purchase_units: {
        currency: "GEL",
        total_amount: 45,
        basket: [{ product_id: PAYMENT_ID, description: order.description, quantity: 1, unit_price: 45 }],
      },
      redirect_urls: { success: order.successUrl, fail: order.failUrl },
      ttl: 12,
    });
    expect(bogOrderPayload(order, true)).not.toHaveProperty("ttl");
  });

  it("signs in with the merchant's keys and keys the order by the payment id", async () => {
    const { fetcher, calls } = bank(json(200, created));
    await expect(createBogOrder(KEYS, order, fetcher)).resolves.toEqual({
      orderId: "bog-order-1",
      redirectUrl: "https://payment.bog.ge/?order_id=bog-order-1",
    });
    expect(calls[0].init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("99971:unit-test-secret").toString("base64")}`,
    });
    expect(calls[1].url).toBe("https://api.bog.ge/payments/v1/ecommerce/orders");
    expect(calls[1].init.headers).toMatchObject({
      Authorization: "Bearer tok",
      "Idempotency-Key": PAYMENT_ID,
      "Accept-Language": "ka",
    });
  });

  it("asks once more without the window when the bank refuses the full body", async () => {
    const { fetcher, calls } = bank(json(400, { message: "bad ttl" }), json(200, created));
    await expect(createBogOrder(KEYS, order, fetcher)).resolves.toMatchObject({ orderId: "bog-order-1" });
    const bodies = calls.slice(1).map((call) => JSON.parse(String(call.init.body)));
    expect(bodies[0]).toHaveProperty("ttl", 12);
    expect(bodies[1]).not.toHaveProperty("ttl");
    expect(calls[2].init.headers).toMatchObject({ "Idempotency-Key": PAYMENT_ID });
  });

  it("throws when the bank refuses both, and never follows a page that is not the bank's", async () => {
    const elsewhere = { id: "x", _links: { redirect: { href: "https://evil.test/pay" } } };
    const { fetcher } = bank(json(200, elsewhere), json(200, elsewhere));
    await expect(createBogOrder(KEYS, order, fetcher)).rejects.toThrow(/refused/);
  });

  it("reuses the token until it is a minute from expiring", async () => {
    const { fetcher, calls } = bank(json(200, {}), json(200, {}));
    await fetchBogReceipt(KEYS, "a", fetcher);
    await fetchBogReceipt(KEYS, "b", fetcher);
    expect(calls.filter((call) => call.url.includes("oauth2")).length).toBe(1);
    expect(calls[2].url).toBe("https://api.bog.ge/payments/v1/receipt/b");
  });
});

describe("a receipt, read into Darkview's terms", () => {
  const receipt = (overrides: Record<string, unknown>) => ({
    external_order_id: PAYMENT_ID,
    order_status: { key: "completed" },
    purchase_units: { currency_code: "GEL", request_amount: "45.00", transfer_amount: "45.00" },
    ...overrides,
  });

  it("is a capture of what the bank took", () => {
    expect(outcomeFromBogReceipt(PAYMENT_ID, "o1", receipt({}))).toEqual({
      paymentId: PAYMENT_ID,
      providerRef: "o1",
      result: "CAPTURED",
      amountMinor: 4500,
      currency: "GEL",
      failureReason: null,
    });
    const short = receipt({ purchase_units: { currency_code: "GEL", request_amount: "45", transfer_amount: "40.5" } });
    expect(outcomeFromBogReceipt(PAYMENT_ID, "o1", short)).toMatchObject({ amountMinor: 4050 });
  });

  it("is a failure when rejected, and an expired window says so", () => {
    expect(
      outcomeFromBogReceipt(PAYMENT_ID, "o1", receipt({ order_status: { key: "rejected" }, reject_reason: "expiration" })),
    ).toMatchObject({ result: "FAILED", failureReason: "PAYMENT_EXPIRED", amountMinor: 4500 });
    expect(
      outcomeFromBogReceipt(PAYMENT_ID, "o1", receipt({ order_status: { key: "rejected" } })),
    ).toMatchObject({ result: "FAILED", failureReason: "PAYMENT_REJECTED" });
  });

  it("is nothing while the bank waits, for a refund, for another payment, or in another currency", () => {
    for (const key of ["created", "in_progress", "refunded", "refunded_partially"]) {
      expect(outcomeFromBogReceipt(PAYMENT_ID, "o1", receipt({ order_status: { key } }))).toBeNull();
    }
    expect(outcomeFromBogReceipt(PAYMENT_ID, "o1", receipt({ external_order_id: "other" }))).toBeNull();
    expect(
      outcomeFromBogReceipt(PAYMENT_ID, "o1", receipt({ purchase_units: { currency_code: "USD", transfer_amount: "45" } })),
    ).toBeNull();
  });
});
