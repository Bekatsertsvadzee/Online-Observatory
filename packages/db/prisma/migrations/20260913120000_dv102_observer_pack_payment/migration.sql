-- DV-102 -- Observer Pack payment.
--
-- DV-100 built the seat and left the only thing that makes one legitimate
-- unbuilt: nothing could settle a payment for it, so POST /observers refused
-- rather than hand out free seats. This is that payment.
--
-- An observer seat is a different sale from a booking. It has no slot, no target
-- and no Booking row, and Payment was one-to-one with Booking, so the sale needs
-- its own record rather than a nullable column bolted onto somebody else's.

-- What a payment buys. The settlement path branches on this rather than on which
-- relation is null: a payment with neither attached would otherwise read as a
-- booking whose row had vanished. BOOKING is the default so every payment written
-- before this migration keeps its meaning.
CREATE TYPE "PaymentPurpose" AS ENUM ('BOOKING', 'OBSERVER_PACK');

ALTER TABLE "Payment"
  ADD COLUMN "purpose" "PaymentPurpose" NOT NULL DEFAULT 'BOOKING';

-- Contract: ObserverPackStatus.
CREATE TYPE "ObserverPackStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED');

CREATE TABLE "ObserverPack" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "missionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "paymentId" UUID,
    "status" "ObserverPackStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "holdExpiresAt" TIMESTAMP(3),
    "priceMinor" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'GEL',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ObserverPack_pkey" PRIMARY KEY ("id")
);

-- One pack per person per mission. A second purchase attempt while a hold is
-- outstanding returns the first pack; it does not open a second payment for a
-- seat the caller already holds.
CREATE UNIQUE INDEX "ObserverPack_missionId_userId_key" ON "ObserverPack"("missionId", "userId");

-- One pack per payment, in the same spirit as Booking.paymentId.
CREATE UNIQUE INDEX "ObserverPack_paymentId_key" ON "ObserverPack"("paymentId");

-- The capacity count: every pack on one mission that is holding or holds a seat.
CREATE INDEX "ObserverPack_missionId_status_idx" ON "ObserverPack"("missionId", "status");

-- The lapsed-hold sweep.
CREATE INDEX "ObserverPack_status_holdExpiresAt_idx" ON "ObserverPack"("status", "holdExpiresAt");

-- The same rule DV-055 gave a held slot: a hold that cannot lapse is a seat held
-- forever by somebody who never paid. The database carries it rather than the
-- application, so no future write path can forget it.
ALTER TABLE "ObserverPack" ADD CONSTRAINT "ObserverPack_pending_payment_has_hold_expiry"
  CHECK ("status" <> 'PENDING_PAYMENT' OR "holdExpiresAt" IS NOT NULL);

-- A paid pack knows when it was paid, and an unpaid one has no such instant to
-- report. ADR-007's seat is what the customer bought; this is the row that says
-- they bought it.
ALTER TABLE "ObserverPack" ADD CONSTRAINT "ObserverPack_paid_has_payment"
  CHECK ("status" <> 'PAID' OR ("paymentId" IS NOT NULL AND "paidAt" IS NOT NULL));

-- Money is integer minor units. Never a float, and never negative.
ALTER TABLE "ObserverPack" ADD CONSTRAINT "ObserverPack_price_not_negative"
  CHECK ("priceMinor" >= 0);

ALTER TABLE "ObserverPack" ADD CONSTRAINT "ObserverPack_missionId_fkey"
  FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ObserverPack" ADD CONSTRAINT "ObserverPack_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ObserverPack" ADD CONSTRAINT "ObserverPack_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
