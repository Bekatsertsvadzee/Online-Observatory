-- DV-055 -- exclusivity of a slot becomes the database's rule, not the application's.
--
-- DV-050 wrote a partial unique index over CONFIRMED bookings only. That is too late:
-- a booking is CONFIRMED after payment, so two people could each reserve the same half
-- hour, each be sent to a payment provider, and only one of them could be given the
-- telescope. The hold has to start at reservation.
--
-- So the index widens to the two statuses that hold a slot, and PENDING_PAYMENT gains
-- an expiry so an abandoned checkout cannot hold one forever. CANCELLED, EXPIRED and
-- REFUNDED stay outside the index: releasing a slot is a status change and nothing more.

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "holdExpiresAt" TIMESTAMP(3),
ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE INDEX "Booking_status_holdExpiresAt_idx" ON "Booking"("status", "holdExpiresAt");

-- CreateIndex
-- Idempotency keys are scoped to the user: two customers retrying at the same moment
-- with the same client-generated key must not collide. Postgres treats NULLs as
-- distinct, so bookings created without a key are unaffected.
CREATE UNIQUE INDEX "Booking_userId_idempotencyKey_key" ON "Booking"("userId", "idempotencyKey");


-- ---------------------------------------------------------------------------
-- THE INDEX IS THE EXCLUSIVITY RULE.
--
-- Nothing above the database is allowed to be what stops a double booking. Two
-- concurrent transactions both see an empty slot, both insert, and exactly one of
-- them survives -- because of this index, and for no other reason. DV-055's test
-- drops it and asserts the double booking then happens.
--
-- Prisma cannot express a partial index, so it is written here by hand.
-- ---------------------------------------------------------------------------
DROP INDEX "Booking_confirmed_slot_unique";

CREATE UNIQUE INDEX "Booking_held_slot_unique"
  ON "Booking" ("observatoryId", "slotStartAt")
  WHERE "status" IN ('PENDING_PAYMENT', 'CONFIRMED');


-- AddConstraint
-- An unpaid hold must say when it lapses. Without this a PENDING_PAYMENT row with a
-- null expiry would occupy the index above forever and quietly remove that slot from
-- sale. Prisma cannot express a CHECK constraint, so it is written here by hand.
ALTER TABLE "Booking" ADD CONSTRAINT "booking_pending_payment_has_hold_expiry" CHECK (
  "status" <> 'PENDING_PAYMENT' OR "holdExpiresAt" IS NOT NULL
);
