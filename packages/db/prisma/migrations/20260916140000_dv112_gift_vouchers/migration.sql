-- DV-112 -- gift vouchers.
--
-- Maintainer decisions, 2026-09-16: a voucher pays for one observation of a given
-- length, is valid for twelve months from payment, and a booking uses at most one
-- price reduction. Not exchangeable for cash: a refunded booking a voucher paid
-- for restores the voucher.
--
-- The code is never stored. It is derived from the voucher id with a secret held
-- outside the database; "codeHash" is what redemption looks up.

CREATE TYPE "GiftVoucherStatus" AS ENUM ('PENDING_PAYMENT', 'ACTIVE', 'REDEEMED', 'CANCELLED');

ALTER TYPE "PaymentPurpose" ADD VALUE 'GIFT_VOUCHER';

ALTER TYPE "EmailNotificationKind" ADD VALUE 'GIFT_VOUCHER_ISSUED';
ALTER TYPE "EmailNotificationKind" ADD VALUE 'GIFT_VOUCHER_RESTORED';

CREATE TABLE "GiftVoucher" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "buyerUserId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeLast4" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'GEL',
    "status" "GiftVoucherStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "recipientEmail" TEXT,
    "recipientName" TEXT,
    "message" TEXT,
    "expiresAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "redeemedByUserId" UUID,
    "redeemedBookingId" UUID,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftVoucher_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GiftVoucher_paymentId_key" ON "GiftVoucher"("paymentId");

-- What redemption looks up. Unique, so one code can only ever name one voucher.
CREATE UNIQUE INDEX "GiftVoucher_codeHash_key" ON "GiftVoucher"("codeHash");

-- A booking is paid for by at most one voucher.
CREATE UNIQUE INDEX "GiftVoucher_redeemedBookingId_key" ON "GiftVoucher"("redeemedBookingId");

CREATE INDEX "GiftVoucher_buyerUserId_createdAt_idx" ON "GiftVoucher"("buyerUserId", "createdAt");

-- A usable voucher always says when it stops being usable.
ALTER TABLE "GiftVoucher" ADD CONSTRAINT "gift_voucher_active_has_expiry"
  CHECK ("status" <> 'ACTIVE' OR "expiresAt" IS NOT NULL);

ALTER TABLE "GiftVoucher" ADD CONSTRAINT "gift_voucher_sane_amounts"
  CHECK ("priceMinor" >= 0 AND "durationMinutes" > 0);

ALTER TABLE "GiftVoucher" ADD CONSTRAINT "GiftVoucher_buyerUserId_fkey" FOREIGN KEY ("buyerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GiftVoucher" ADD CONSTRAINT "GiftVoucher_redeemedByUserId_fkey" FOREIGN KEY ("redeemedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GiftVoucher" ADD CONSTRAINT "GiftVoucher_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GiftVoucher" ADD CONSTRAINT "GiftVoucher_redeemedBookingId_fkey" FOREIGN KEY ("redeemedBookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
