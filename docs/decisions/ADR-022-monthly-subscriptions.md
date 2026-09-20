# ADR-022 — Monthly subscriptions: unfreezing credits, and how one is spent

- **Date:** 2026-09-17
- **Status:** APPROVED — the open questions at the end are still unanswered, and
  each must be answered before the part of the work that depends on it
- **Decided by:** project maintainer
- **Approved:** 2026-09-17
- **Arises from:** issue #95, and the maintainer's decision of 2026-09-15 to
  unfreeze the subscription surface for Phase 1
- **Amends:** ADR-003 §Subscriptions and credits
- **Amended:** 2026-09-19, below — the open questions answered, and the renewal
  sweep's one live charge per period
- **Relates to:** ADR-008 (loyalty is a separate balance), ADR-015 (two slot
  lengths), DV-056 (payment settlement), DV-112 (gift vouchers)

## Context

ADR-003 froze `Subscription`, `SubscriptionPlan`, `SubscriptionStatus`,
`CreditLedger` and `CreditLedgerReason`, and says unfreezing "is an maintainer
decision recorded in a new ADR, with its own decomposition and its own funding."
This is that record.

**What exists today.** The Prisma models and their tables are in every deployed
database and hold no rows. `Subscription` has `userId`, `plan`, `status`,
`startsAt`, `endsAt` — **no price, no currency, no billing period, no payment,
no provider reference.** `CreditLedger` has `amount`, `balanceAfter`, `reason`
and a globally unique `idempotencyKey`. Neither is mentioned in
`contracts/openapi.yaml`, in any generated type, or in any route, service, seed
or test. `SubscriptionPlan` is `OBSERVER, EXPLORER, ADVANCED`;
`SubscriptionStatus` is `TRIALING, ACTIVE, PAUSED, CANCELLED, EXPIRED`;
`CreditLedgerReason` is `SUBSCRIPTION_GRANT, MISSION_DEBIT,
PRIVATE_SESSION_DEBIT, REFUND, ADJUSTMENT`.

**What the platform already does well, and this must not duplicate.** Three
patterns are load-bearing and each has a working implementation:

- **Settlement is by webhook, idempotent on `(provider, providerRef)`**, with a
  documented lock order (Payment → Booking) and an audit row per outcome. A
  purpose is dispatched on `Payment.purpose`, today `BOOKING | OBSERVER_PACK |
  GIFT_VOUCHER`.
- **A voucher is claimed atomically without a row lock**: inside the reservation
  transaction, `updateMany` conditional on `status: "ACTIVE"`, and `count === 0`
  throws, which rolls back the booking with it. A slot conflict rolls back the
  claim, so a failed reservation spends nothing.
- **The loyalty ledger is append-only in the database** — a trigger refuses
  `UPDATE` — idempotent on `(userId, kind, sourceRef)`, and a spend is a
  conditional `updateMany` on the account balance rather than a lock.

**What does not exist at all.** No Bank of Georgia iPay adapter (merchant
onboarding has not delivered the webhook and signature documentation, and
`resolvePaymentProvider` refuses `BOG_IPAY` by design). No card-on-file, mandate
or "charge a saved instrument" concept anywhere — every payment today is started
by the customer and finished by a webhook. No cron, job queue or scheduler: all
recurring work is `setInterval` in the long-lived realtime process, with no
leader election, so every sweep is written to be idempotent and safe to run twice.

## Decision

### 1. What is unfrozen, and what stays frozen

Unfrozen: `Subscription`, `SubscriptionPlan`, `SubscriptionStatus`,
`CreditLedger`, `CreditLedgerReason`, and the `User`/`Mission` back-relations.

**Still frozen, unchanged:** `PrivateSession` and `PrivateSessionStatus`, the
network surface and the shared-observation surface named by ADR-003. In
particular `CreditLedgerReason.PRIVATE_SESSION_DEBIT` is unfrozen as a *name* and
**must never be written** while private sessions are frozen.

### 2. A credit is a minute of sky, not an observation

The obvious unit is "one observation", and it cannot be used: **nobody knows how
long an observation is yet.** `generate.ts` sells one 30-minute slot, its own
comment says to change that constant when pricing is settled, and ADR-015 §2 names
twenty and sixty as the two lengths while calling both PROVISIONAL and leaving the
real figure to DV-035's measurement at first light. A plan denominated in
observations would have to be re-priced the day that number moves, and every
unspent credit would change value underneath the customer who bought it.

So **a plan grants minutes**, and a booking costs its own `durationMinutes` —
30 today, 20 or 60 when ADR-015's lengths ship, whatever DV-035 measures after
that. The arithmetic is exact, needs no cost table, and survives the slot length
changing. Integer minutes; nothing is prorated and nothing is rounded.

An interface should still speak to customers in observations ("120 minutes —
about four sessions"), and that is a presentation decision for `darkview-clients`,
not a storage one.

### 3. Money and credits stay separate, and so does loyalty

Three balances, three ledgers, no crossing:

| Balance | Ledger | Earned by |
| --- | --- | --- |
| Loyalty points | `LoyaltyLedgerEntry` (ADR-008) | Settled payments |
| Observation minutes | `CreditLedger` | A settled subscription payment |
| Money | `Payment` | The customer |

A subscription payment is money and **earns loyalty points like any other
payment**, through the existing `earnOnSettledPayment`. **Spending a credit earns
nothing** — no money moved. A tier discount applies to money, never to credits.

### 4. The credit ledger becomes as strict as the loyalty one

`CreditLedger` predates the loyalty work and is weaker than it. It gains, by
migration:

- **An append-only trigger**, refusing `UPDATE` and `DELETE`, exactly as
  `loyalty_ledger_append_only` does.
- **A `CreditAccount` row per user** holding the balance, so a spend is a
  conditional `updateMany` (`balance: { gte: n }`) rather than a lock — the
  loyalty pattern, for the same reason: it does not serialise checkout.
- `balanceAfter` is written from that update's result inside the same
  transaction, and stays as the audit trail it was meant to be.
- `idempotencyKey` keeps its global uniqueness and gets stated conventions:
  `renewal:<subscriptionId>:<periodStart>`, `booking:<bookingId>`,
  `booking:<bookingId>:release`, `expiry:<subscriptionId>:<periodEnd>`,
  `admin:<auditEventId>`.

### 5. A subscription is a plan row, a payment, and a period

`Subscription` gains: `priceMinor`, `currency`, `currentPeriodStart`,
`currentPeriodEnd`, `cancelAtPeriodEnd`, `pausedAt`, `providerMandateRef`
(the provider's handle for the saved card — **never the card**), and
`lastPaymentId`.

**Plans are rows, not code**, following `LoyaltyScheme`: a
`SubscriptionPlanConfig` table keyed by the `SubscriptionPlan` enum, holding
`priceMinor`, `minutesPerPeriod`, `nameEn`, `nameKa`, `isAvailable`. Changing a
price is an `UPDATE`, and a plan can be withdrawn without a deployment.

`PaymentPurpose` gains `SUBSCRIPTION`, and settlement dispatches it like the
other three.

### 6. Credits are granted only by a captured payment

The grant is written **inside the settlement transaction**, on capture, with
`reason: SUBSCRIPTION_GRANT` and `idempotencyKey:
renewal:<subscriptionId>:<periodStart>`. A failed renewal writes nothing: there
is no path that grants credits before money arrives. Because the key names the
period, a webhook delivered twice, a sweep that ran on two processes, and a
retried charge all converge on one grant.

### 7. Spending a credit is the voucher mechanism

Inside the reservation transaction, in this order: `expireLapsedHolds`, create
the `Booking` at `priceMinor: 0` (the exclusion constraint adjudicates the slot
here), then claim the credits by conditional update on `CreditAccount`, and
throw `CreditsUnavailable` if it claims nothing — which rolls the booking back
and answers 422. A slot conflict rolls the claim back with it, so a lost race
spends nothing.

**One price reduction per booking.** A booking uses a voucher, or points, or
credits — never two. This extends the rule DV-112 already enforces.

Every path that releases a held slot — hold lapsed, payment failed, cancelled,
refunded — releases the credits with `reason: REFUND` and
`idempotencyKey: booking:<id>:release`, beside `releaseRedeemedPoints`. A
refunded credit booking **returns the credit**, never money, exactly as a
refunded voucher booking restores the voucher.

### 8. Renewal is a sweep, and it is idempotent

A `subscriptionSweep` joins the existing `setInterval` sweeps in the realtime
process. Every pass, for each `ACTIVE` subscription whose `currentPeriodEnd` has
passed, it opens a payment for the next period and asks the adapter to charge the
saved instrument. It holds no state: the period's `idempotencyKey` and a unique
`(subscriptionId, periodStart)` on the renewal `Payment` make a second run a
no-op. That is the same discipline the other sweeps keep, and it is what makes
the absence of leader election survivable.

**The adapter grows one operation**, `chargeSavedInstrument`, which is the first
time this platform initiates a payment rather than receiving one. The sandbox
adapter implements it; the outcome still arrives by webhook, so settlement is
unchanged.

### 9. A failed renewal does not invent a status

`SubscriptionStatus` gains no members. A failed charge leaves the subscription
`ACTIVE` and unfunded for a grace period, during which the sweep retries; credits
from the previous period are already spent or expired, so an unfunded customer
can book nothing on credit. When the grace period lapses the subscription becomes
`EXPIRED`. `PAUSED` is the customer's own act and stops both charging and
granting. `CANCELLED` is immediate at the customer's request, or at period end if
`cancelAtPeriodEnd`. `TRIALING` stays unused in Phase 1.

### 10. Contract first

`contracts/openapi.yaml` grows the subscription surface — plan catalogue, the
customer's subscription, its credit balance, and the credit field on a booking —
and TypeScript, Zod and Pydantic are generated from it as usual. ADR-003 said the
contract deliberately does not model this; that sentence is what this record
amends.

### 11. Nothing ships to production until the provider does

`SANDBOX` refuses to run in production, and `BOG_IPAY` has no adapter. So the
whole of this is buildable, testable and mergeable now, and **sells nothing**
until Bank of Georgia delivers the recurring-payment documentation and enables it
on the merchant account. No code may assume what that documentation says: the
BOG adapter is written against the documentation when it arrives, not before.

## Alternatives considered

**A new credit ledger, leaving `CreditLedger` frozen.** Rejected. ADR-008 built a
separate ledger for loyalty precisely so it would not silently unfreeze this one;
with the maintainer's decision to unfreeze, a second unused table would be the
thing to explain.

**Credits as money (a prepaid balance in tetri).** Rejected: it makes a
subscription a deposit, which is a different product with different consumer-law
consequences, and it would collide with refunds.

**Charging on the customer's next visit instead of a sweep.** Rejected. A
subscription nobody visits would never renew, and the customer would discover the
charge at the moment they wanted to book.

**A cron service or job queue.** Rejected for now under `docs/ENGINEERING.md`'s rule
against new services without a measured need. One more idempotent sweep beside
five existing ones is the smaller change. **If a second realtime instance is ever
run, every sweep needs leader election or an advisory lock** — that is true today
and is not made worse here, but it should be its own issue.

## Consequences

- `docs/architecture.md` and ADR-003's frozen list need the amendment noted.
- The `DATABASE_ONLY` classification of the three enums in `enum-parity.test.ts`
  changes: they become shared with the contract.
- A subscriber's booking is free at the point of sale, so revenue reporting can no
  longer read `Booking.priceMinor` as what was earned. Nothing reports on that
  today; whatever does must read `Payment`.
- DV-111's refund rules gain a case: a credit-paid booking returns credits.
- The provisional slot price (45.00 GEL) is the only price in code. Plan prices go
  in the table from the start rather than following it.
- **Pre-existing, and not this record's to fix:** `generate.ts` sells one
  30-minute slot while ADR-015 §2 describes twenty and sixty. Denominating credits
  in minutes means subscriptions do not depend on that gap closing, but the gap is
  real and belongs in its own issue.

## Open questions — the maintainer's to answer before implementation

1. **Plan prices and grants.** `OBSERVER`, `EXPLORER`, `ADVANCED`: what does each
   cost per month, and how many minutes does it grant? The provisional price is
   45.00 GEL for a 30-minute slot, so a plan granting 120 minutes at 180.00 GEL
   would be no discount at all and the product would have no reason to exist. Both
   numbers are commercial decisions nobody has made.
2. **Rollover.** Do unspent minutes expire at period end? This record assumes
   **they expire**, with an `expiry:` ledger entry, and recommends it: rollover
   turns a subscription into a prepaid balance with an open-ended liability.
3. **Grace period** after a failed renewal, before `EXPIRED`. Suggested: seven
   days, three retry attempts.
4. **Public plan names** in English and Georgian, which are brand decisions, not
   enum names.
5. **Whether a subscriber may also pay for extra observations** in the same month
   (assumed yes — a credit booking and a paid booking are independent).
6. **Cancellation refunds.** Does cancelling mid-period refund anything? This
   record assumes not: the period is already funded and its credits already
   granted.

## Amendment, 2026-09-19 — the answers, and one live charge per period

- **Decided by:** project maintainer, in session
- **Changes:** section 8's unique `(subscriptionId, periodStart)`; answers open
  questions 2, 3 and 6; and settles three things this record left unsaid
- **Arises from:** issues #120 and #121

**The open questions answered** (each as this record recommended): unspent minutes
**expire at period end**; a failed renewal has **seven days and three attempts**
before `EXPIRED`; **cancelling refunds nothing**. Questions 1, 4 and 5 remain open.

**Section 8 and section 9 could not both hold.** Section 8 made the sweep idempotent
with a unique `(subscriptionId, periodStart)` on the renewal payment, which allows one
payment per period. Section 9 has the sweep retry a failed renewal. Settlement
refuses to settle a FAILED payment again, so a retry cannot reuse the failed row, and
the unique refused a second one. The unique is now **partial, over payments that have
not FAILED**: one live charge per period, which is what the idempotence needed, and a
failed charge leaves room for the next attempt. The grant stays keyed
`renewal:<subscriptionId>:<periodStart>`, so a period is granted once however many
attempts it took.

**The attempts** are at period end, two days after it and four days after it. The
subscription becomes `EXPIRED` at the third failure, or seven days after the period
ended if a charge is still unanswered then, whichever comes first. A funded
subscription with no saved card to charge becomes `EXPIRED` at period end: no attempt
could reach an instrument.

**Expired minutes have their own reason,** `CreditLedgerReason.EXPIRY`, so an expiry is
never read as an operator's `ADJUSTMENT`. The sweep writes it before it charges, so
the next period's grant is never what expires.

**Paused minutes are spendable** until their period ends: a pause stops charging and
granting, not spending (decided while building #120). **A pause that outlasts its
period resumes into a new one that starts at resumption,** so the customer is never
charged for a month already gone.

**`chargeSavedInstrument` lives in the realtime service,** beside the sweep that calls
it, rather than on the API's webhook adapter, which is server-only and runs in no
long-lived process. The two meet at the payment row. Nothing is charged in
production until a real provider's charger exists; there the sweep still expires
minutes and ends subscriptions.

