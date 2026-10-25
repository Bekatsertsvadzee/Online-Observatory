# ADR-073 — Bank of Georgia Takes the Payments

- **Date:** 2026-10-24
- **Status:** APPROVED (maintainer's request of 2026-10-24: "go with it, copy the plugin and
  everything from astroman; the recipient is the same")
- **Decided by:** project maintainer
- **Relates to:** roadmap Track F1 (a real payment provider); DV-056 (settlement);
  #149 (the sandbox checkout); ADR-035 (the hosted demo); clients ADR-067 (gifts)

## Context

Every sale -- a slot, an Observer Pack seat, a gift -- has been taken on the sandbox
provider, which moves no money. `provider.ts` left BOG_IPAY without an adapter until the
bank's documentation was in hand.

It is in hand. astroman.ge has taken real card payments through Bank of Georgia's
e-commerce API (`api.bog.ge/payments/v1`) since September 2026, with a WooCommerce gateway
written against that API (v1.2.0, 2026-09-09). The money goes to the same merchant, so
Stellar uses the same merchant profile and keys from manager.bog.ge.

## Decision

### 1. The gateway's flow, on this API

| Step | astroman.ge gateway | Stellar |
| --- | --- | --- |
| Open the order | `POST /ecommerce/orders` at checkout | the same, on the payer's first visit to `GET /payments/{paymentId}/checkout` |
| Body | one basket line equal to the total, `external_order_id`, `callback_url`, `redirect_urls`, `ttl` | the same; `external_order_id` is the payment id |
| Double submit | `Idempotency-Key` | the payment id is the key |
| Bank refuses the body | retry once without the options | retry once without `ttl` |
| Payment window | `ttl` 60 minutes | what is left of the hold (15 minutes for a slot, 5 for a seat); 60 for a gift, which holds nothing scarce |
| Callback | body never trusted; receipt re-read from `GET /receipt/{order_id}` | the same, at `POST /payments/bog/callback` |
| Wrong amount | order held for review | `settlePayment` refuses it and writes the audit row |
| Expired window | cancelled, not failed | FAILED with reason `PAYMENT_EXPIRED`, the slot released |
| Payment methods | none restricted: the bank shows every method activated for the merchant | the same: no `payment_method` is sent |

Opening the order on the checkout visit, not in the reservation, keeps the reservation's
transaction from ever waiting on the bank. The bank's order id and page are written to the
payment together, once; a second visit goes to the same page.

### 2. Which provider

`PAYMENT_PROVIDER` names it. Unset, it is SANDBOX wherever the sandbox is allowed and
BOG_IPAY everywhere else, so a production deployment never opens a payment it cannot take.
A sale is refused before anything is held when the chosen provider cannot be used here:
SANDBOX outside a demo in production, or BOG_IPAY without `BOG_CLIENT_ID` and
`BOG_SECRET_KEY`.

The hosted demo keeps the sandbox until the maintainer sets `PAYMENT_PROVIDER=BOG_IPAY`
and the keys on the API's deployment. That is the switch to real money.

Subscriptions stay on the sandbox: they need a saved card (ADR-022), which is a separate
agreement with the bank, and they come after launch.

### 3. The contract value stays BOG_IPAY

It names the bank. Renaming it to the API's current name would cost a migration and a
contract change for no change in behaviour.

### 4. Refunds are made at the bank, for now

The gateway refunds from the WooCommerce order screen. Stellar has no such screen yet.
DV-111 cancellations and ADR-036 close refunds already record what is owed on a non-sandbox
payment (`refundOwedMinor`) and never claim it paid; the operator refunds it in
manager.bog.ge. An automatic refund through `POST /payment/refund/{order_id}` comes with
the operator's refunds screen.

## Consequences

- Two routes. `GET /payments/{paymentId}/checkout` needs the payer's session. `POST
  /payments/bog/callback` has none and no signature check: what authenticates the result
  is the receipt this API asks the bank for over an authenticated call. The route-guard
  test holds the callback to that.
- No client change: the website already follows any https `redirectUrl`, and after the
  first visit the payment's `redirectUrl` is the bank's own page.
- A capture that arrives after the hold was swept is recorded as captured without a slot
  (DV-056) and is owed back, refunded at the bank.
