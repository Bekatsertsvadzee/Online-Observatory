import "server-only";

import { createHmac } from "node:crypto";

import type { Locale } from "@/lib/locale";
import { getServerEnvironment } from "@/lib/validation/env";

/**
 * ADR-040. Sent through the verification webhook, signed the same way. `kind` tells the
 * mail service which template to use; a verification message carries none.
 */
export type PasswordResetMessage = {
  recipient: string;
  resetUrl: string;
  locale: Locale;
};

export async function sendPasswordReset(message: PasswordResetMessage) {
  const environment = getServerEnvironment();
  const endpoint = environment.EMAIL_VERIFICATION_WEBHOOK_URL;
  const secret = environment.EMAIL_VERIFICATION_WEBHOOK_SECRET;

  if (!endpoint || !secret) {
    throw new Error("Password reset delivery is not configured");
  }

  const body = JSON.stringify({ kind: "PASSWORD_RESET", ...message });
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

  if (!response.ok) throw new Error("Password reset delivery failed");
}
