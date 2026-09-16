-- DV-111 -- refund or reschedule when a slot is lost to weather or to us.
--
-- Maintainer rules, 2026-09-15 (issue #93): a slot lost to bad weather or to our
-- fault, where the customer lost half the slot or more, entitles them to choose a
-- full refund or a free reschedule. A reschedule must be used within 30 days,
-- after which the entitlement becomes a refund. A no-show is entitled to nothing.

ALTER TYPE "EmailNotificationKind" ADD VALUE 'ENTITLEMENT_AVAILABLE';
ALTER TYPE "EmailNotificationKind" ADD VALUE 'BOOKING_REFUNDED';

-- Contract: BookingLossCause.
CREATE TYPE "BookingLossCause" AS ENUM ('WEATHER', 'OBSERVATORY_FAULT');

-- NONE is recorded too, so an ended slot is evaluated exactly once.
CREATE TYPE "BookingEntitlementOutcome" AS ENUM ('NONE', 'OPEN', 'REFUNDED', 'RESCHEDULED');

CREATE TABLE "BookingEntitlement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bookingId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "outcome" "BookingEntitlementOutcome" NOT NULL,
    "cause" "BookingLossCause",
    "minutesLost" INTEGER NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "rescheduledBookingId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingEntitlement_pkey" PRIMARY KEY ("id")
);

-- One evaluation per booking. Two sweeps racing on the same ended slot write one row.
CREATE UNIQUE INDEX "BookingEntitlement_bookingId_key" ON "BookingEntitlement"("bookingId");

-- An entitlement is spent on at most one reschedule.
CREATE UNIQUE INDEX "BookingEntitlement_rescheduledBookingId_key" ON "BookingEntitlement"("rescheduledBookingId");

-- The expiry sweep's query: open entitlements past their date.
CREATE INDEX "BookingEntitlement_outcome_expiresAt_idx" ON "BookingEntitlement"("outcome", "expiresAt");

-- An open entitlement always says when it lapses; a closed one never claims to be open.
ALTER TABLE "BookingEntitlement" ADD CONSTRAINT "booking_entitlement_open_has_expiry"
  CHECK ("outcome" <> 'OPEN' OR ("expiresAt" IS NOT NULL AND "cause" IS NOT NULL));

ALTER TABLE "BookingEntitlement" ADD CONSTRAINT "BookingEntitlement_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookingEntitlement" ADD CONSTRAINT "BookingEntitlement_rescheduledBookingId_fkey" FOREIGN KEY ("rescheduledBookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BookingEntitlement" ADD CONSTRAINT "BookingEntitlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
