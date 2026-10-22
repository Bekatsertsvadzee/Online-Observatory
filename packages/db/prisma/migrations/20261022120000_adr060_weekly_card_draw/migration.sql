-- ADR-060: the weekly card draw (the clients' ADR-058). Three cards a week per account per
-- observatory, decided when dealt; prizes are account-bound vouchers, never cash.


-- CreateEnum
CREATE TYPE "CardRarity" AS ENUM ('LEGENDARY', 'EPIC', 'RARE', 'COMMON');

-- CreateEnum
CREATE TYPE "CardPrizeKind" AS ENUM ('FREE_SLOT', 'OBSERVER_SEAT', 'DISCOUNT');

-- CreateEnum
CREATE TYPE "CardPrizeStatus" AS ENUM ('ACTIVE', 'REDEEMED');

-- AlterEnum
ALTER TYPE "AuditCategory" ADD VALUE 'CARD_DRAW';

-- CreateTable
CREATE TABLE "CardDrawScheme" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "freeSlotChanceBp" INTEGER NOT NULL,
    "observerSeatChanceBp" INTEGER NOT NULL,
    "discountChanceBp" INTEGER NOT NULL,
    "freeSlotsPerWeek" INTEGER NOT NULL,
    "discountPercentOff" INTEGER NOT NULL,
    "prizeValidDays" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardDrawScheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardDraw" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "observatoryId" UUID NOT NULL,
    "week" DATE NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "pickedPosition" INTEGER,
    "pickedAt" TIMESTAMP(3),
    "pickIdempotencyKey" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardDraw_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardDrawCard" (
    "drawId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "rarity" "CardRarity" NOT NULL,
    "targetId" UUID,

    CONSTRAINT "CardDrawCard_pkey" PRIMARY KEY ("drawId","position")
);

-- CreateTable
CREATE TABLE "CardDrawWeek" (
    "observatoryId" UUID NOT NULL,
    "week" DATE NOT NULL,
    "freeSlotsHeld" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CardDrawWeek_pkey" PRIMARY KEY ("observatoryId","week")
);

-- CreateTable
CREATE TABLE "CardPrize" (
    "id" UUID NOT NULL,
    "drawId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "observatoryId" UUID NOT NULL,
    "kind" "CardPrizeKind" NOT NULL,
    "status" "CardPrizeStatus" NOT NULL DEFAULT 'ACTIVE',
    "codeHash" TEXT NOT NULL,
    "codeLast4" TEXT NOT NULL,
    "durationMinutes" INTEGER,
    "percentOff" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "redeemedBookingId" UUID,
    "redeemedObserverPackId" UUID,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardPrize_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CardDraw_userId_observatoryId_week_key" ON "CardDraw"("userId", "observatoryId", "week");

-- CreateIndex
CREATE UNIQUE INDEX "CardPrize_drawId_key" ON "CardPrize"("drawId");

-- CreateIndex
CREATE UNIQUE INDEX "CardPrize_codeHash_key" ON "CardPrize"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "CardPrize_redeemedBookingId_key" ON "CardPrize"("redeemedBookingId");

-- CreateIndex
CREATE UNIQUE INDEX "CardPrize_redeemedObserverPackId_key" ON "CardPrize"("redeemedObserverPackId");

-- CreateIndex
CREATE INDEX "CardPrize_userId_createdAt_idx" ON "CardPrize"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "CardDraw" ADD CONSTRAINT "CardDraw_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardDraw" ADD CONSTRAINT "CardDraw_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardDrawCard" ADD CONSTRAINT "CardDrawCard_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "CardDraw"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardDrawCard" ADD CONSTRAINT "CardDrawCard_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardDrawWeek" ADD CONSTRAINT "CardDrawWeek_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardPrize" ADD CONSTRAINT "CardPrize_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "CardDraw"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardPrize" ADD CONSTRAINT "CardPrize_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardPrize" ADD CONSTRAINT "CardPrize_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardPrize" ADD CONSTRAINT "CardPrize_redeemedBookingId_fkey" FOREIGN KEY ("redeemedBookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardPrize" ADD CONSTRAINT "CardPrize_redeemedObserverPackId_fkey" FOREIGN KEY ("redeemedObserverPackId") REFERENCES "ObserverPack"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The odds and caps are data, not code (ADR-058 §4): one row, changed by an UPDATE.
-- Chances are basis points per card, and together leave room for COMMON.
ALTER TABLE "CardDrawScheme" ADD CONSTRAINT "card_draw_scheme_single_row" CHECK ("id" = 1);
ALTER TABLE "CardDrawScheme" ADD CONSTRAINT "card_draw_scheme_sane" CHECK (
  "freeSlotChanceBp" >= 0 AND "observerSeatChanceBp" >= 0 AND "discountChanceBp" >= 0
  AND "freeSlotChanceBp" + "observerSeatChanceBp" + "discountChanceBp" <= 10000
  AND "freeSlotsPerWeek" >= 0
  AND "discountPercentOff" BETWEEN 1 AND 100
  AND "prizeValidDays" > 0
);

-- The starting values the maintainer approved on 2026-10-22: a free slot 1% with at
-- most two a week, an observer seat 10%, 20% off at 25%, nothing for the rest, and
-- thirty days to spend a prize.
INSERT INTO "CardDrawScheme" ("id", "freeSlotChanceBp", "observerSeatChanceBp", "discountChanceBp", "freeSlotsPerWeek", "discountPercentOff", "prizeValidDays", "updatedAt")
VALUES (1, 100, 1000, 2500, 2, 20, 30, CURRENT_TIMESTAMP);

ALTER TABLE "CardDrawCard" ADD CONSTRAINT "card_draw_card_position" CHECK ("position" BETWEEN 0 AND 2);

-- A pick is a position and an instant, together or not at all.
ALTER TABLE "CardDraw" ADD CONSTRAINT "card_draw_pick_whole" CHECK (
  ("pickedPosition" IS NULL AND "pickedAt" IS NULL)
  OR ("pickedPosition" BETWEEN 0 AND 2 AND "pickedAt" IS NOT NULL)
);

ALTER TABLE "CardDrawWeek" ADD CONSTRAINT "card_draw_week_not_negative" CHECK ("freeSlotsHeld" >= 0);

-- A free slot names its length and nothing else; a discount its percentage; a seat
-- neither. A prize is spent on a booking or on a pack, never both.
ALTER TABLE "CardPrize" ADD CONSTRAINT "card_prize_kind_shape" CHECK (
  ("kind" = 'FREE_SLOT' AND "durationMinutes" > 0 AND "percentOff" IS NULL)
  OR ("kind" = 'DISCOUNT' AND "durationMinutes" IS NULL AND "percentOff" BETWEEN 1 AND 100)
  OR ("kind" = 'OBSERVER_SEAT' AND "durationMinutes" IS NULL AND "percentOff" IS NULL)
);
ALTER TABLE "CardPrize" ADD CONSTRAINT "card_prize_one_redemption" CHECK (
  "redeemedBookingId" IS NULL OR "redeemedObserverPackId" IS NULL
);

-- An observer-seat prize pays for a pack with no payment, at no price (ADR-060). A
-- paid pack still knows when it was paid; one with no payment is one nothing was
-- charged for.
ALTER TABLE "ObserverPack" DROP CONSTRAINT "ObserverPack_paid_has_payment";
ALTER TABLE "ObserverPack" ADD CONSTRAINT "ObserverPack_paid_has_payment"
  CHECK ("status" <> 'PAID' OR ("paidAt" IS NOT NULL AND ("paymentId" IS NOT NULL OR "priceMinor" = 0)));
