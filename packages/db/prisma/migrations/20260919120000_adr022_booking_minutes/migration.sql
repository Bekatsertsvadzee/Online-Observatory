-- ADR-022 section 7, issue #120: a booking can be paid for with subscription
-- minutes. The minutes are taken in the reservation's transaction and recorded here,
-- so a refund knows how many to return without reading the ledger back.

ALTER TABLE "Booking" ADD COLUMN "subscriptionMinutesSpent" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Booking" ADD CONSTRAINT "booking_subscription_minutes_non_negative"
  CHECK ("subscriptionMinutesSpent" >= 0);
