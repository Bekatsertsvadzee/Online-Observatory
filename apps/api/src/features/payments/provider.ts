import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import type { Currency, PaymentProvider } from "@darkview/contracts";
import { zCurrency } from "@darkview/contracts/zod";
import { z } from "zod";

import { getServerEnvironment } from "@/lib/validation/env";

/**
 * What a provider's callback says, once the provider's own vocabulary has been
 * read out of it.
 *
 * This is the whole of what the settlement path knows about any provider. The
 * contract models the webhook payload as opaque on purpose -- "the cloud verifies
 * the signature over the raw body, then maps the payload to Darkview's own Payment
 * record" -- and this type is that record's side of the mapping. A second provider
 * adds an adapter that produces one of these; it changes nothing downstream.
 *
 * `amountMinor` and `currency` are carried so the settlement can refuse a callback
 * that reports a different sum from the one the intent was opened for. A provider
 * that cannot state the amount cannot be settled against a booking price.
 */
export type PaymentOutcome = {
  paymentId: string;
  providerRef: string;
  result: "CAPTURED" | "FAILED";
  amountMinor: number;
  currency: Currency;
  failureReason: string | null;
};

/**
 * One payment provider, as the webhook route sees it.
 *
 * The same shape as `MountDriver` and `CameraDriver` in the agent: an interface
 * with a simulator behind it by default, so the path can be exercised end to end
 * before the real thing exists, and so the real thing slots in without the path
 * changing.
 */
export type PaymentProviderAdapter = {
  readonly provider: PaymentProvider;
  /** Constant-time verification of the provider's signature over the raw body. */
  verifySignature(rawBody: string, signature: string): boolean;
  /** The provider's payload, read into Darkview's terms, or null if it is not one. */
  readOutcome(payload: Record<string, unknown>): PaymentOutcome | null;
};

export type ProviderResolutionFailure = {
  ok: false;
  status: 401 | 500;
  message: string;
};

export type ProviderResolution =
  | { ok: true; adapter: PaymentProviderAdapter }
  | ProviderResolutionFailure;

/**
 * The sandbox's own callback body.
 *
 * The sandbox is a provider Darkview runs, so these are its fields and not an
 * invention about anybody else's. Nothing in this schema is a claim about BOG
 * iPay; that adapter is written from the provider's documentation when merchant
 * onboarding delivers it, and not before.
 */
const sandboxPayloadSchema = z.object({
  paymentId: z.uuid(),
  providerRef: z.string().min(1).max(128),
  result: z.enum(["CAPTURED", "FAILED"]),
  amountMinor: z.int().min(0),
  currency: zCurrency,
  failureReason: z.string().max(256).optional(),
});

export type SandboxPayload = z.infer<typeof sandboxPayloadSchema>;

/** Hex HMAC-SHA256 over the exact bytes of the body. */
export function signSandboxBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * The development and CI provider (contract: `PaymentProvider.SANDBOX`).
 *
 * It settles a payment on a signed callback and nothing else: there is no card
 * form and no redirect, because the sandbox is not pretending to be a bank. A
 * developer, a test or a dev script signs a body with the shared secret and posts
 * it, exactly as a real provider would with its own key.
 */
export function createSandboxProvider(secret: string): PaymentProviderAdapter {
  return {
    provider: "SANDBOX",

    verifySignature(rawBody, signature) {
      const expected = Buffer.from(signSandboxBody(rawBody, secret), "utf8");
      const presented = Buffer.from(signature, "utf8");
      return expected.length === presented.length && timingSafeEqual(expected, presented);
    },

    readOutcome(payload) {
      const parsed = sandboxPayloadSchema.safeParse(payload);
      if (!parsed.success) return null;

      return {
        paymentId: parsed.data.paymentId,
        providerRef: parsed.data.providerRef,
        result: parsed.data.result,
        amountMinor: parsed.data.amountMinor,
        currency: parsed.data.currency,
        failureReason: parsed.data.failureReason ?? null,
      };
    },
  };
}

/**
 * The adapter for a provider named in a webhook envelope, if this deployment can
 * verify it.
 *
 * SANDBOX is refused outright in production. The contract's words: "never
 * selectable in a production environment and a production payment success is
 * never simulated." Refusing at the door means no later check can be talked
 * around by a well-formed body.
 *
 * BOG_IPAY has no adapter. Its webhook shape, header and signing algorithm are
 * provider configuration that "must be confirmed against the provider's own
 * documentation before implementation" (contract, `paymentWebhookSignature`),
 * and merchant onboarding has not delivered that documentation. A callback
 * claiming to be from it is unverifiable, so it is a 401 and not a guess.
 */
export function resolvePaymentProvider(provider: PaymentProvider): ProviderResolution {
  const environment = getServerEnvironment();

  switch (provider) {
    case "SANDBOX": {
      if (environment.NODE_ENV === "production") {
        return {
          ok: false,
          status: 401,
          message: "The sandbox provider is not accepted in production.",
        };
      }

      if (!environment.PAYMENT_SANDBOX_WEBHOOK_SECRET) {
        return {
          ok: false,
          status: 500,
          message: "PAYMENT_SANDBOX_WEBHOOK_SECRET is not configured.",
        };
      }

      return { ok: true, adapter: createSandboxProvider(environment.PAYMENT_SANDBOX_WEBHOOK_SECRET) };
    }

    case "BOG_IPAY":
      return {
        ok: false,
        status: 401,
        message: "No adapter is configured for BOG_IPAY.",
      };
  }
}
