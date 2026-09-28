import { zConfirmSandboxCheckoutBody, zConfirmSandboxCheckoutPath, zGetSandboxCheckoutPath } from "@darkview/contracts/zod";

import {
  confirmSandboxCheckout,
  readSandboxCheckout,
  type SandboxCheckoutView,
} from "@/features/payments/sandbox-checkout";
import { requireApiMutation, requireApiSession } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { BOOKING_POLICY, meterRequest } from "@/lib/security/rate-limit";

/**
 * GET and POST /payments/{paymentId}/sandbox-checkout (#149).
 *
 * The one route here that answers HTML, because it stands in for a provider's
 * hosted checkout and a browser is sent to it by `PaymentIntent.redirectUrl`. It
 * is a form and nothing more: no script, no style, no asset. The app-wide
 * headers in `next.config.ts` apply to it as to every other route.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ paymentId: string }> },
) {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  const path = zGetSandboxCheckoutPath.safeParse(await context.params);
  if (!path.success) return apiError(404, "NOT_FOUND", "No such payment.");

  const view = await readSandboxCheckout({
    userId: guard.session.user.id,
    paymentId: path.data.paymentId,
    now: new Date(),
  });
  if (!view.ok) return apiError(view.status, view.code, view.message);

  return new Response(renderPage(view), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ paymentId: string }> },
) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  const limited = await meterRequest({
    policy: BOOKING_POLICY,
    scope: "sandbox-checkout",
    identity: guard.session.user.id,
    category: "PAYMENT",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  const path = zConfirmSandboxCheckoutPath.safeParse(await context.params);
  if (!path.success) return apiError(404, "NOT_FOUND", "No such payment.");

  const body = zConfirmSandboxCheckoutBody.safeParse(
    Object.fromEntries(new URLSearchParams(await request.text())),
  );
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "SandboxCheckoutConfirmation is malformed.");
  }

  const result = await confirmSandboxCheckout({
    userId: guard.session.user.id,
    paymentId: path.data.paymentId,
    result: body.data.result,
    now: new Date(),
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return new Response(null, {
    status: 303,
    headers: { location: result.returnUrl, "cache-control": "no-store" },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Minor units as a decimal string, in integers: money is never a float (DV-054). */
function formatMinor(amountMinor: number, currency: string): string {
  const major = Math.floor(amountMinor / 100);
  const minor = String(amountMinor % 100).padStart(2, "0");
  return `${major}.${minor} ${currency}`;
}

function renderPage(view: SandboxCheckoutView): string {
  const amount = escapeHtml(formatMinor(view.amountMinor, view.currency));
  const back = escapeHtml(view.returnUrl);

  const body = view.payable
    ? `<p>Amount: ${amount}</p>
<p>Hold expires: ${escapeHtml(view.holdExpiresAt?.toISOString() ?? "")}</p>
<form method="post">
<button type="submit" name="result" value="CAPTURED">Pay (simulated)</button>
<button type="submit" name="result" value="FAILED">Decline (simulated)</button>
</form>`
    : `<p>This payment cannot be answered here any more (payment status: ${escapeHtml(view.paymentStatus)}).</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sandbox checkout</title>
</head>
<body>
<h1>Sandbox checkout</h1>
<p>This is the development payment sandbox. No card is asked for and no money moves.</p>
${body}
<p><a href="${back}">Back to the booking</a></p>
</body>
</html>
`;
}
