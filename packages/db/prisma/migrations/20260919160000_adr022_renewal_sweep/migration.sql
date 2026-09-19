-- ADR-022 sections 8 and 9, amended 2026-09-19, issue #121: the renewal sweep.
--
-- A period's unspent minutes expire at its end, under their own ledger reason so
-- an expiry is never mistaken for an operator's correction.

ALTER TYPE "CreditLedgerReason" ADD VALUE 'EXPIRY';

-- One live charge per period, not one charge. The full unique made the sweep
-- idempotent but left no way to retry: settlement refuses to settle a FAILED
-- payment again, and the index refused a second row. A FAILED charge now leaves the
-- index, so the next attempt can open, and two sweeps still cannot both open one.
-- The grant stays keyed renewal:<subscriptionId>:<periodStart>, so a period is
-- granted once however many attempts it took.

DROP INDEX "Payment_subscriptionId_periodStart_key";

CREATE UNIQUE INDEX "Payment_subscription_period_live_key"
  ON "Payment" ("subscriptionId", "periodStart")
  WHERE "status" <> 'FAILED';

CREATE INDEX "Payment_subscriptionId_periodStart_idx" ON "Payment" ("subscriptionId", "periodStart");
