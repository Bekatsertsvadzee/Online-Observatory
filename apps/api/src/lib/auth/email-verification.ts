import "server-only";

import { createHmac } from "node:crypto";

import type { Locale } from "@/lib/locale";
import { getServerEnvironment } from "@/lib/validation/env";

export type EmailVerificationMessage = {
  recipient: string;
  verificationUrl: string;
  locale: Locale;
};

const RESEND_ENDPOINT = "https://api.resend.com/emails";

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The customer-facing copy. The product is Stellar to a customer (ADR-025). */
export function verificationEmailContent(locale: Locale, verificationUrl: string) {
  const href = escapeHtml(verificationUrl);
  if (locale === "ka") {
    return {
      subject: "დაადასტურეთ ელფოსტა — სტელარი",
      text:
        "გამარჯობა,\n\n" +
        "სტელარის ანგარიშის გასააქტიურებლად დაადასტურეთ ელფოსტის მისამართი:\n\n" +
        `${verificationUrl}\n\n` +
        "ბმული 30 წუთი მოქმედებს. თუ ანგარიში თქვენ არ შეგიქმნიათ, ეს წერილი უგულებელყავით.\n\n" +
        "სტელარი",
      html:
        "<p>გამარჯობა,</p>" +
        "<p>სტელარის ანგარიშის გასააქტიურებლად დაადასტურეთ ელფოსტის მისამართი:</p>" +
        `<p><a href="${href}">ელფოსტის დადასტურება</a></p>` +
        "<p>ბმული 30 წუთი მოქმედებს. თუ ანგარიში თქვენ არ შეგიქმნიათ, ეს წერილი უგულებელყავით.</p>" +
        "<p>სტელარი</p>",
    };
  }

  return {
    subject: "Confirm your email — Stellar",
    text:
      "Hello,\n\n" +
      "Confirm your email address to activate your Stellar account:\n\n" +
      `${verificationUrl}\n\n` +
      "The link works for 30 minutes. If you did not create an account, ignore this email.\n\n" +
      "Stellar",
    html:
      "<p>Hello,</p>" +
      "<p>Confirm your email address to activate your Stellar account:</p>" +
      `<p><a href="${href}">Confirm email</a></p>` +
      "<p>The link works for 30 minutes. If you did not create an account, ignore this email.</p>" +
      "<p>Stellar</p>",
  };
}

export async function sendEmailVerification(message: EmailVerificationMessage) {
  const environment = getServerEnvironment();

  if (environment.RESEND_API_KEY && environment.EMAIL_FROM) {
    const content = verificationEmailContent(message.locale, message.verificationUrl);
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

    if (!response.ok) throw new Error("Email verification delivery failed");
    return;
  }

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
