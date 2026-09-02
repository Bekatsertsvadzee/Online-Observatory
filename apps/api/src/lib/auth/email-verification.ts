import "server-only";

import { createHmac } from "node:crypto";

import type { Locale } from "@/lib/locale";
import { getServerEnvironment } from "@/lib/validation/env";

export type EmailVerificationMessage = {
  recipient: string;
  verificationUrl: string;
  locale: Locale;
};

export async function sendEmailVerification(message: EmailVerificationMessage) {
  const environment = getServerEnvironment();
  const endpoint = environment.EMAIL_VERIFICATION_WEBHOOK_URL;
  const secret = environment.EMAIL_VERIFICATION_WEBHOOK_SECRET;

  if (!endpoint || !secret) {
    throw new Error("Email verification delivery is not configured");
  }

  const body = JSON.stringify(message);
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-darkview-signature": signature,
    },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) throw new Error("Email verification delivery failed");
}
