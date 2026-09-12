import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { meterRequest, requestActor, recordAuditEvent, settlePayment, environment } = vi.hoisted(
  () => ({
    meterRequest: vi.fn(),
    requestActor: vi.fn(),
    recordAuditEvent: vi.fn(),
    settlePayment: vi.fn(),
    environment: {
      NODE_ENV: "test" as string,
      PAYMENT_SANDBOX_WEBHOOK_SECRET: "sandbox-secret-that-is-at-least-32-chars" as
        | string
        | undefined,
    },
  }),
);

vi.mock("@/lib/security/rate-limit", () => ({
  meterRequest,
  requestActor,
  PAYMENT_WEBHOOK_POLICY: {},
}));
vi.mock("@/lib/validation/env", () => ({ getServerEnvironment: () => environment }));
vi.mock("@/lib/db/client", () => ({ getDatabase: () => ({}) }));
vi.mock("@darkview/db/audit", () => ({ recordAuditEvent }));
vi.mock("@/features/payments/settle", () => ({ settlePayment }));

import { signSandboxBody } from "@/features/payments/provider";

import { POST } from "./route";

const SECRET = "sandbox-secret-that-is-at-least-32-chars";
const PAYMENT_ID = "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e02";
const MISSION_ID = "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e03";

const payload = {
  paymentId: PAYMENT_ID,
  providerRef: "sbx_0001",
  result: "CAPTURED",
  amountMinor: 4500,
  currency: "GEL",
};

const envelope = { provider: "SANDBOX", payload };

function request(options: { body?: unknown; raw?: string; signature?: string | null }) {
  const raw = options.raw ?? JSON.stringify(options.body ?? envelope);
  const headers = new Headers({ "content-type": "application/json" });

  const signature =
    options.signature === undefined ? signSandboxBody(raw, SECRET) : options.signature;
  if (signature !== null) headers.set("x-darkview-payment-signature", signature);

  return new Request("https://darkview.test/payments/webhook", {
    method: "POST",
    headers,
    body: raw,
  });
}

describe("POST /payments/webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    environment.NODE_ENV = "test";
    meterRequest.mockResolvedValue(null);
    requestActor.mockResolvedValue("unattributed");
    settlePayment.mockResolvedValue({ ok: true, applied: true, missionId: MISSION_ID });
  });

  it("settles a correctly signed sandbox callback and answers 202", async () => {
    const response = await POST(request({}));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(settlePayment).toHaveBeenCalledWith({
      provider: "SANDBOX",
      outcome: { ...payload, failureReason: null },
      now: expect.any(Date),
    });
  });

  it("is metered before the body is read", async () => {
    meterRequest.mockResolvedValueOnce(
      Response.json({ code: "RATE_LIMITED", message: "Too many requests." }, { status: 429 }),
    );

    const response = await POST(request({}));

    expect(response.status).toBe(429);
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON, or not an envelope", async () => {
    expect((await POST(request({ raw: "{not json" }))).status).toBe(400);
    expect((await POST(request({ body: { provider: "SANDBOX" } }))).status).toBe(400);
    expect((await POST(request({ body: { ...envelope, extra: 1 } }))).status).toBe(400);
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it("refuses a missing signature with 401 and leaves an audit row", async () => {
    const response = await POST(request({ signature: null }));

    expect(response.status).toBe(401);
    expect(settlePayment).not.toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "PAYMENT",
        action: "PAYMENT_WEBHOOK_REFUSED",
        detail: { provider: "SANDBOX", reason: "MISSING_SIGNATURE" },
      }),
      expect.anything(),
    );
  });

  it("refuses a signature that does not verify over the exact bytes", async () => {
    const raw = JSON.stringify(envelope);
    // Signed over a re-serialised body with different whitespace: same JSON
    // value, different bytes, so it must not verify.
    const response = await POST(
      request({ raw, signature: signSandboxBody(JSON.stringify(envelope, null, 2), SECRET) }),
    );

    expect(response.status).toBe(401);
    expect(settlePayment).not.toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { provider: "SANDBOX", reason: "BAD_SIGNATURE" } }),
      expect.anything(),
    );
  });

  it("refuses the sandbox in production even when the signature is right", async () => {
    environment.NODE_ENV = "production";

    const response = await POST(request({}));

    expect(response.status).toBe(401);
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it("refuses a BOG_IPAY callback because nothing can verify it yet", async () => {
    const response = await POST(request({ body: { provider: "BOG_IPAY", payload } }));

    expect(response.status).toBe(401);
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it("refuses a signed payload the provider adapter cannot read", async () => {
    const response = await POST(
      request({ body: { provider: "SANDBOX", payload: { result: "CAPTURED" } } }),
    );

    expect(response.status).toBe(400);
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it("passes a settlement refusal through as 400", async () => {
    settlePayment.mockResolvedValueOnce({
      ok: false,
      status: 400,
      code: "BAD_REQUEST",
      message: "No such payment.",
    });

    const response = await POST(request({}));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "BAD_REQUEST" });
  });
});
