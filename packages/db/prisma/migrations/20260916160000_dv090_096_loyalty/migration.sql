-- DV-090 to DV-096 -- Darkview's loyalty club (ADR-008).
--
-- Maintainer decisions, 2026-09-15 and 2026-09-16: the Astroman club's published
-- rules in Darkview's own separate club. 5 points per 1 GEL of settled payment,
-- 100 points = 1 GEL off a booking, 100 points on joining, 200 points to both
-- sides of a referral once the new customer's first paid booking settles. Member
-- from 0 points at 10% off, VIP from 20,000 at 20% off; 5,000 is a progress marker
-- that grants nothing. No Wednesday bonus. Points do not expire. Tier is derived
-- from purchase-earned points only. A booking uses one price reduction.
--
-- The rates are rows, not code: changing one is an UPDATE.

ALTER TYPE "AuditCategory" ADD VALUE 'LOYALTY';

CREATE TYPE "LoyaltyEntryKind" AS ENUM ('WELCOME_BONUS', 'REFERRAL_BONUS', 'PURCHASE_EARNED', 'PURCHASE_REVERSED', 'REDEEMED', 'REDEMPTION_RELEASED', 'ADMIN_ADJUSTMENT');

ALTER TABLE "Booking" ADD COLUMN "loyaltyPointsRedeemed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "tierDiscountMinor" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Booking" ADD CONSTRAINT "booking_loyalty_non_negative"
  CHECK ("loyaltyPointsRedeemed" >= 0 AND "tierDiscountMinor" >= 0);

CREATE TABLE "LoyaltyScheme" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "pointsPerGel" INTEGER NOT NULL,
    "pointsPerGelRedeemed" INTEGER NOT NULL,
    "welcomeBonusPoints" INTEGER NOT NULL,
    "referralBonusPoints" INTEGER NOT NULL,
    "minimumPayableMinor" INTEGER NOT NULL,
    "progressMarkers" INTEGER[],
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyScheme_pkey" PRIMARY KEY ("id"),
    -- One scheme. A second row would be a second answer to "how many points".
    CONSTRAINT "loyalty_scheme_single_row" CHECK ("id" = 1),
    CONSTRAINT "loyalty_scheme_sane_rates" CHECK (
      "pointsPerGel" >= 0 AND "pointsPerGelRedeemed" > 0 AND "welcomeBonusPoints" >= 0
      AND "referralBonusPoints" >= 0 AND "minimumPayableMinor" >= 0
    )
);

CREATE TABLE "LoyaltyTier" (
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameKa" TEXT NOT NULL,
    "thresholdPoints" INTEGER NOT NULL,
    "discountPercent" INTEGER NOT NULL,

    CONSTRAINT "LoyaltyTier_pkey" PRIMARY KEY ("code"),
    CONSTRAINT "loyalty_tier_sane" CHECK ("thresholdPoints" >= 0 AND "discountPercent" BETWEEN 0 AND 100)
);

CREATE UNIQUE INDEX "LoyaltyTier_thresholdPoints_key" ON "LoyaltyTier"("thresholdPoints");

CREATE TABLE "LoyaltyAccount" (
    "userId" UUID NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "tierPoints" INTEGER NOT NULL DEFAULT 0,
    "tierCode" TEXT NOT NULL,
    "referralCode" TEXT NOT NULL,
    "referredByUserId" UUID,
    "referralRewardedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyAccount_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "loyalty_account_no_self_referral" CHECK ("referredByUserId" IS NULL OR "referredByUserId" <> "userId")
);

CREATE UNIQUE INDEX "LoyaltyAccount_referralCode_key" ON "LoyaltyAccount"("referralCode");

CREATE TABLE "LoyaltyLedgerEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "kind" "LoyaltyEntryKind" NOT NULL,
    "points" INTEGER NOT NULL,
    "tierPoints" INTEGER NOT NULL DEFAULT 0,
    "sourceRef" TEXT NOT NULL,
    "bookingId" UUID,
    "reason" TEXT,
    "actorUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoyaltyLedgerEntry_userId_createdAt_idx" ON "LoyaltyLedgerEntry"("userId", "createdAt");

-- Idempotency by source event: the same payment, booking, referee or adjustment
-- recorded twice writes one entry.
CREATE UNIQUE INDEX "LoyaltyLedgerEntry_userId_kind_sourceRef_key" ON "LoyaltyLedgerEntry"("userId", "kind", "sourceRef");

-- Append-only. A correction is a new entry, never an edit. Deleting a user still
-- removes their entries, through the cascade below.
CREATE FUNCTION loyalty_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LoyaltyLedgerEntry is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loyalty_ledger_no_update
  BEFORE UPDATE ON "LoyaltyLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION loyalty_ledger_append_only();

ALTER TABLE "LoyaltyAccount" ADD CONSTRAINT "LoyaltyAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LoyaltyLedgerEntry" ADD CONSTRAINT "LoyaltyLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The Astroman club's published terms, as of club.astroman.ge/terms on 2026-09-16.
INSERT INTO "LoyaltyScheme" ("id", "pointsPerGel", "pointsPerGelRedeemed", "welcomeBonusPoints", "referralBonusPoints", "minimumPayableMinor", "progressMarkers")
VALUES (1, 5, 100, 100, 200, 100, ARRAY[5000]);

INSERT INTO "LoyaltyTier" ("code", "nameEn", "nameKa", "thresholdPoints", "discountPercent") VALUES
  ('MEMBER', 'Member', 'წევრი', 0, 10),
  ('VIP', 'VIP', 'VIP', 20000, 20);
