import "server-only";

import { createHmac } from "node:crypto";

import { escapeHtml, RESEND_ENDPOINT } from "@/lib/auth/email-verification";
import type { Locale } from "@/lib/locale";
import { getServerEnvironment } from "@/lib/validation/env";

/**
 * ADR-040. Delivered the way the verification email is (ADR-035): straight to Resend
 * when it is configured, else through the signed webhook with `kind: "PASSWORD_RESET"`,
 * which tells the mail service which template to use.
 */
export type PasswordResetMessage = {
  recipient: string;
  resetUrl: string;
  locale: Locale;
};

/** The customer-facing copy. The product is Stellar to a customer (ADR-025). */
export function passwordResetEmailContent(locale: Locale, resetUrl: string) {
  const href = escapeHtml(resetUrl);
  if (locale === "ka") {
    return {
      subject: "პაროლის აღდგენა — სტელარი",
      text:
        "გამარჯობა,\n\n" +
        "სტელარის ანგარიშისთვის ახალი პაროლის დასაყენებლად გახსენი ეს ბმული:\n\n" +
        `${resetUrl}\n\n` +
        "ბმული 30 წუთი მოქმედებს და მხოლოდ ერთხელ იმუშავებს. თუ პაროლის აღდგენა შენ არ მოგითხოვია, ეს წერილი უგულებელყავი.\n\n" +
        "სტელარი",
      html:
        "<p>გამარჯობა,</p>" +
        "<p>სტელარის ანგარიშისთვის ახალი პაროლის დასაყენებლად გახსენი ეს ბმული:</p>" +
        `<p><a href="${href}">ახალი პაროლის დაყენება</a></p>` +
        "<p>ბმული 30 წუთი მოქმედებს და მხოლოდ ერთხელ იმუშავებს. თუ პაროლის აღდგენა შენ არ მოგითხოვია, ეს წერილი უგულებელყავი.</p>" +
        "<p>სტელარი</p>",
    };
  }

  return {
    subject: "Reset your password — Stellar",
    text:
      "Hello,\n\n" +
      "Open this link to choose a new password for your Stellar account:\n\n" +
      `${resetUrl}\n\n` +
      "The link works for 30 minutes, once. If you did not ask to reset your password, ignore this email.\n\n" +
      "Stellar",
    html:
      "<p>Hello,</p>" +
      "<p>Open this link to choose a new password for your Stellar account:</p>" +
      `<p><a href="${href}">Choose a new password</a></p>` +
      "<p>The link works for 30 minutes, once. If you did not ask to reset your password, ignore this email.</p>" +
      "<p>Stellar</p>",
  };
}

export async function sendPasswordReset(message: PasswordResetMessage) {
  const environment = getServerEnvironment();

  if (environment.RESEND_API_KEY && environment.EMAIL_FROM) {
    const content = passwordResetEmailContent(message.locale, message.resetUrl);
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${environment.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: environment.EMAIL_FROM,
        to: [message.recipient],
        subject: content.subject,
        text: content.text,
        html: content.html,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) throw new Error("Password reset delivery failed");
    return;
  }

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
