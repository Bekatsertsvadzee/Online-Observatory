import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { meterRequest, getCurrentSession, requestHeaders, readSandboxCheckout, confirmSandboxCheckout } =
  vi.hoisted(() => ({
    meterRequest: vi.fn(),
    getCurrentSession: vi.fn(),
    requestHeaders: { origin: "https://darkview.test" as string | null },
    readSandboxCheckout: vi.fn(),
    confirmSandboxCheckout: vi.fn(),
  }));

vi.mock("@/lib/auth/session", () => ({ getCurrentSession }));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(requestHeaders.origin ? { origin: requestHeaders.origin } : {}),
}));
vi.mock("@/lib/security/rate-limit", () => ({ meterRequest, BOOKING_POLICY: { name: "booking" } }));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({ APP_URL: "https://darkview.test" }),
}));
vi.mock("@/features/payments/sandbox-checkout", () => ({
  readSandboxCheckout,
  confirmSandboxCheckout,
}));

import { GET, POST } from "./route";

const USER_ID = "6f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const PAYMENT_ID = "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e02";
const BOOKING_ID = "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e01";
const RETURN_URL = `https://darkview.test/en/app/bookings/${BOOKING_ID}`;

const session = {
  id: "session-1",
  expiresAt: new Date("2026-12-20T00:00:00.000Z"),
  csrfToken: "csrf-token-value",
  user: {
    id: USER_ID,
    email: "observer@example.com",
    name: "Observer",
    role: "USER" as const,
    locale: "en" as const,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  },
};

const params = (paymentId = PAYMENT_ID) => ({ params: Promise.resolve({ paymentId }) });

function post(body: string, url = `https://darkview.test/payments/${PAYMENT_ID}/sandbox-checkout`) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("/payments/{paymentId}/sandbox-checkout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestHeaders.origin = "https://darkview.test";
    getCurrentSession.mockResolvedValue(session);
    meterRequest.mockResolvedValue(null);
    readSandboxCheckout.mockResolvedValue({
      ok: true,
      paymentId: PAYMENT_ID,
      amountMinor: 4505,
      currency: "GEL",
      paymentStatus: "PENDING",
      payable: true,
      holdExpiresAt: new Date("2026-12-15T12:15:00.000Z"),
      returnUrl: RETURN_URL,
    });
    confirmSandboxCheckout.mockResolvedValue({ ok: true, applied: true, returnUrl: RETURN_URL });
  });

  it("serves the owner a page with a form and nothing that runs", async () => {
    const response = await GET(new Request("https://darkview.test/"), params());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await response.text();
    expect(html).toContain('<form method="post">');
    expect(html).toContain('value="CAPTURED"');
    expect(html).toContain('value="FAILED"');
    expect(html).toContain("45.05 GEL");
    expect(html).not.toContain("<script");
    expect(readSandboxCheckout).toHaveBeenCalledWith({
      userId: USER_ID,
      paymentId: PAYMENT_ID,
      now: expect.any(Date),
    });
  });

  it("offers no buttons once the payment cannot be answered", async () => {
    readSandboxCheckout.mockResolvedValueOnce({
      ok: true,
      paymentId: PAYMENT_ID,
      amountMinor: 4500,
      currency: "GEL",
      paymentStatus: "CAPTURED",
      payable: false,
      holdExpiresAt: null,
      returnUrl: RETURN_URL,
    });

    const html = await (await GET(new Request("https://darkview.test/"), params())).text();
    expect(html).not.toContain("<form");
    expect(html).toContain(`href="${RETURN_URL}"`);
  });

  it("requires a session to see or answer the checkout", async () => {
    getCurrentSession.mockResolvedValue(null);

    expect((await GET(new Request("https://darkview.test/"), params())).status).toBe(401);
    expect((await POST(post("result=CAPTURED"), params())).status).toBe(401);
    expect(readSandboxCheckout).not.toHaveBeenCalled();
    expect(confirmSandboxCheckout).not.toHaveBeenCalled();
  });

  it("refuses an answer from another site, or with no Origin", async () => {
    requestHeaders.origin = "https://evil.example";
    expect((await POST(post("result=CAPTURED"), params())).status).toBe(403);

    requestHeaders.origin = null;
    expect((await POST(post("result=CAPTURED"), params())).status).toBe(403);

    expect(confirmSandboxCheckout).not.toHaveBeenCalled();
  });

  it("settles the owner's answer and redirects to the booking with 303", async () => {
    const response = await POST(post("result=CAPTURED"), params());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(RETURN_URL);
    expect(confirmSandboxCheckout).toHaveBeenCalledWith({
      userId: USER_ID,
      paymentId: PAYMENT_ID,
      result: "CAPTURED",
      now: expect.any(Date),
    });
    expect(meterRequest).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "sandbox-checkout", identity: USER_ID }),
    );
  });

  it("never takes its redirect from the request", async () => {
    const fromQuery = await POST(
      post(
        "result=CAPTURED",
        `https://darkview.test/payments/${PAYMENT_ID}/sandbox-checkout?return=https://evil.example/`,
      ),
      params(),
    );
    expect(fromQuery.status).toBe(303);
    expect(new URL(fromQuery.headers.get("location")!).origin).toBe("https://darkview.test");

    const fromBody = await POST(post("result=CAPTURED&return=https%3A%2F%2Fevil.example%2F"), params());
    expect(fromBody.status).toBe(422);
    expect(confirmSandboxCheckout).toHaveBeenCalledTimes(1);
  });

  it("refuses an answer that is not pay or decline", async () => {
    expect((await POST(post("result=REFUNDED"), params())).status).toBe(422);
    expect((await POST(post(""), params())).status).toBe(422);
    expect(confirmSandboxCheckout).not.toHaveBeenCalled();
  });

  it("answers 404 for a payment id that is not one", async () => {
    expect((await GET(new Request("https://darkview.test/"), params("nope"))).status).toBe(404);
    expect((await POST(post("result=CAPTURED"), params("nope"))).status).toBe(404);
  });

  it("passes a refusal through as the contract's error", async () => {
    confirmSandboxCheckout.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "The hold on this slot has lapsed.",
    });

    const response = await POST(post("result=CAPTURED"), params());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "CONFLICT",
      message: "The hold on this slot has lapsed.",
    });
    expect(response.headers.get("location")).toBeNull();
  });

  it("is metered before anything is settled", async () => {
    meterRequest.mockResolvedValueOnce(
      Response.json({ code: "RATE_LIMITED", message: "Too many requests." }, { status: 429 }),
    );

    expect((await POST(post("result=CAPTURED"), params())).status).toBe(429);
    expect(confirmSandboxCheckout).not.toHaveBeenCalled();
  });
});
