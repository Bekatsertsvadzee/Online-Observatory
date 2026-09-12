import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { environment } = vi.hoisted(() => ({
  environment: {
    NODE_ENV: "test" as string,
    PAYMENT_SANDBOX_WEBHOOK_SECRET: "sandbox-secret-that-is-at-least-32-chars" as
      | string
      | undefined,
  },
}));

vi.mock("@/lib/validation/env", () => ({ getServerEnvironment: () => environment }));

import { createSandboxProvider, resolvePaymentProvider, signSandboxBody } from "./provider";

const SECRET = "sandbox-secret-that-is-at-least-32-chars";
const PAYMENT_ID = "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e02";

const payload = {
  paymentId: PAYMENT_ID,
  providerRef: "sbx_0001",
  result: "CAPTURED",
  amountMinor: 4500,
  currency: "GEL",
};

describe("the sandbox provider", () => {
  const sandbox = createSandboxProvider(SECRET);

  it("verifies a body it signed, over the exact bytes", () => {
    const body = JSON.stringify({ provider: "SANDBOX", payload });
    expect(sandbox.verifySignature(body, signSandboxBody(body, SECRET))).toBe(true);
    // Same JSON, different bytes: the signature is over the text, not the value.
    expect(sandbox.verifySignature(`${body} `, signSandboxBody(body, SECRET))).toBe(false);
  });

  it("refuses a signature under another secret, or of another length", () => {
    const body = JSON.stringify({ provider: "SANDBOX", payload });
    expect(sandbox.verifySignature(body, signSandboxBody(body, `${SECRET}x`))).toBe(false);
    expect(sandbox.verifySignature(body, "abc")).toBe(false);
    expect(sandbox.verifySignature(body, "")).toBe(false);
  });

  it("reads its own payload into a PaymentOutcome", () => {
    expect(sandbox.readOutcome(payload)).toEqual({
      paymentId: PAYMENT_ID,
      providerRef: "sbx_0001",
      result: "CAPTURED",
      amountMinor: 4500,
      currency: "GEL",
      failureReason: null,
    });
    expect(
      sandbox.readOutcome({ ...payload, result: "FAILED", failureReason: "CARD_DECLINED" }),
    ).toMatchObject({ result: "FAILED", failureReason: "CARD_DECLINED" });
  });

  it("returns null for a payload that is not its own", () => {
    expect(sandbox.readOutcome({})).toBeNull();
    expect(sandbox.readOutcome({ ...payload, result: "AUTHORIZED" })).toBeNull();
    expect(sandbox.readOutcome({ ...payload, amountMinor: 1 / 2 })).toBeNull();
    expect(sandbox.readOutcome({ ...payload, amountMinor: -1 })).toBeNull();
    expect(sandbox.readOutcome({ ...payload, currency: "USD" })).toBeNull();
    expect(sandbox.readOutcome({ ...payload, paymentId: "not-a-uuid" })).toBeNull();
  });
});

describe("resolving a provider", () => {
  it("hands out the sandbox outside production", () => {
    environment.NODE_ENV = "test";
    const resolved = resolvePaymentProvider("SANDBOX");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.adapter.provider).toBe("SANDBOX");
  });

  it("refuses the sandbox in production before looking for a secret", () => {
    // Contract: "never selectable in a production environment and a production
    // payment success is never simulated." A configured secret changes nothing.
    environment.NODE_ENV = "production";
    expect(resolvePaymentProvider("SANDBOX")).toEqual({
      ok: false,
      status: 401,
      message: expect.stringContaining("production"),
    });
    environment.NODE_ENV = "test";
  });

  it("refuses the sandbox without a secret rather than accepting unsigned callbacks", () => {
    const secret = environment.PAYMENT_SANDBOX_WEBHOOK_SECRET;
    environment.PAYMENT_SANDBOX_WEBHOOK_SECRET = undefined;
    expect(resolvePaymentProvider("SANDBOX")).toMatchObject({ ok: false, status: 500 });
    environment.PAYMENT_SANDBOX_WEBHOOK_SECRET = secret;
  });

  it("has no adapter for BOG_IPAY until its documentation exists", () => {
    expect(resolvePaymentProvider("BOG_IPAY")).toMatchObject({ ok: false, status: 401 });
  });
});
