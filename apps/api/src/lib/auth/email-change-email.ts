import "server-only";

import { createHmac } from "node:crypto";

import { escapeHtml, RESEND_ENDPOINT } from "@/lib/auth/email-verification";
import type { Locale } from "@/lib/locale";
import { getServerEnvironment } from "@/lib/validation/env";

/**
 * ADR-042. Delivered the way the verification email is (ADR-035): straight to Resend
 * when it is configured, else through the signed webhook, whose `kind` tells the mail
 * service which template to use.
 *
 * - `EMAIL_CHANGE`, to the new address: the link that moves the account.
 * - `EMAIL_CHANGE_REQUESTED`, to the current address: a change was asked for. It never
 *   names the new address.
 * - `EMAIL_IN_USE`, to the new address when it already holds an account. No link.
 */
export type EmailChangeMessage =
  | { kind: "EMAIL_CHANGE"; recipient: string; locale: Locale; verificationUrl: string }
  | { kind: "EMAIL_CHANGE_REQUESTED"; recipient: string; locale: Locale }
  | { kind: "EMAIL_IN_USE"; recipient: string; locale: Locale };

const paragraphs = (lines: string[]) => ({
  text: lines.join("\n\n"),
  html: lines.map((line) => `<p>${line}</p>`).join(""),
});

/** The customer-facing copy. The product is Stellar to a customer (ADR-025). */
export function emailChangeContent(message: EmailChangeMessage) {
  const ka = message.locale === "ka";

  if (message.kind === "EMAIL_CHANGE") {
    const url = message.verificationUrl;
    const href = escapeHtml(url);
    const intro = ka
      ? "სტელარის ანგარიშის ამ მისამართზე გადასატანად გახსენი ეს ბმული:"
      : "Open this link to move your Stellar account to this address:";
    const outro = ka
      ? "ბმული 30 წუთი მოქმედებს და მხოლოდ ერთხელ იმუშავებს. მანამდე ანგარიში ძველ მისამართზე რჩება. თუ ეს შენ არ მოგითხოვია, ეს წერილი უგულებელყავი."
      : "The link works for 30 minutes, once. Until then the account keeps its current address. If you did not ask for this, ignore this email.";
    const hello = ka ? "გამარჯობა," : "Hello,";
    const sign = ka ? "სტელარი" : "Stellar";
    return {
      subject: ka
        ? "დაადასტურე ახალი ელფოსტა — სტელარი"
        : "Confirm your new email — Stellar",
      text: [hello, intro, url, outro, sign].join("\n\n"),
      html:
        `<p>${hello}</p><p>${intro}</p>` +
        `<p><a href="${href}">${ka ? "ახალი მისამართის დადასტურება" : "Confirm the new address"}</a></p>` +
        `<p>${outro}</p><p>${sign}</p>`,
    };
  }

  if (message.kind === "EMAIL_CHANGE_REQUESTED") {
    return {
      subject: ka
        ? "ელფოსტის შეცვლის მოთხოვნა — სტელარი"
        : "A change of email was asked for — Stellar",
      ...paragraphs(
        ka
          ? [
              "გამარჯობა,",
              "შენს სტელარის ანგარიშზე ელფოსტის მისამართის შეცვლა მოითხოვეს. ანგარიში ამ მისამართზე რჩება, სანამ ახალი მისამართიდან ბმულს არ გახსნიან.",
              "თუ ეს შენ არ ყოფილხარ, აღადგინე პაროლი — ეს მოთხოვნას გააუქმებს.",
              "სტელარი",
            ]
          : [
              "Hello,",
              "Somebody asked to change the email address of your Stellar account. The account stays at this address until the link sent to the new one is opened.",
              "If this was not you, reset your password. That cancels the request.",
              "Stellar",
            ],
      ),
    };
  }

  return {
    subject: ka
      ? "ამ მისამართზე ანგარიში უკვე არსებობს — სტელარი"
      : "This address already has an account — Stellar",
    ...paragraphs(
      ka
        ? [
            "გამარჯობა,",
            "სტელარის ანგარიშის ამ მისამართზე გადატანა მოითხოვეს, მაგრამ ამ მისამართზე ანგარიში უკვე არსებობს, ამიტომ არაფერი შეცვლილა.",
            "თუ ეს შენ არ ყოფილხარ, ეს წერილი უგულებელყავი.",
            "სტელარი",
          ]
        : [
            "Hello,",
            "Somebody asked to move a Stellar account to this address, but this address already has an account, so nothing changed.",
            "If this was not you, ignore this email.",
            "Stellar",
          ],
    ),
  };
}

export async function sendEmailChangeMessage(message: EmailChangeMessage) {
  const environment = getServerEnvironment();

  if (environment.RESEND_API_KEY && environment.EMAIL_FROM) {
    const content = emailChangeContent(message);
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

    if (!response.ok) throw new Error("Email change delivery failed");
    return;
  }

  const endpoint = environment.EMAIL_VERIFICATION_WEBHOOK_URL;
  const secret = environment.EMAIL_VERIFICATION_WEBHOOK_SECRET;

  if (!endpoint || !secret) {
    throw new Error("Email change delivery is not configured");
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

  if (!response.ok) throw new Error("Email change delivery failed");
}
