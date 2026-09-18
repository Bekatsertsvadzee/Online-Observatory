-- ADR-022 -- monthly subscriptions, unfreezing the credit surface (issue #95).
--
-- ADR-003 froze Subscription, SubscriptionPlan, SubscriptionStatus, CreditLedger and
-- CreditLedgerReason: the tables exist and hold no rows. The maintainer's decision of
-- 2026-09-15 unfreezes them. This migration is the schema half of that.
--
-- A credit is a minute of sky, not an observation (ADR-022 section 2): the slot length
-- is not settled until DV-035 measures the real optical train, and a plan denominated
-- in observations would change value underneath a customer who already bought one.
--
-- Nothing here sells anything. The plan catalogue starts empty, prices are undecided,
-- and BOG_IPAY has no adapter (ADR-022 section 11).

ALTER TYPE "PaymentPurpose" ADD VALUE 'SUBSCRIPTION';

-- Every credit ledger entry is audited, and the audit row needs a category the
-- database will accept. The enum member is used by a later transaction, never this
-- one, which is what ALTER TYPE ... ADD VALUE requires.
ALTER TYPE "AuditCategory" ADD VALUE 'SUBSCRIPTION';

-- Subscription gains the period, the price it was charged and the provider's handle
-- for the saved card. NOT NULL without a default is deliberate: the table holds no
-- rows, so this fails loudly rather than inventing a price for one that existed.
ALTER TABLE "Subscription" ADD COLUMN "priceMinor" INTEGER NOT NULL,
ADD COLUMN "currency" "Currency" NOT NULL DEFAULT 'GEL',
ADD COLUMN "currentPeriodStart" TIMESTAMP(3),
ADD COLUMN "currentPeriodEnd" TIMESTAMP(3),
ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "pausedAt" TIMESTAMP(3),
ADD COLUMN "providerMandateRef" TEXT,
ADD COLUMN "lastPaymentId" UUID;

ALTER TABLE "Subscription" ADD CONSTRAINT "subscription_price_non_negative"
  CHECK ("priceMinor" >= 0);

-- A period that ends before it starts is not a period.
ALTER TABLE "Subscription" ADD CONSTRAINT "subscription_period_ordered"
  CHECK ("currentPeriodStart" IS NULL OR "currentPeriodEnd" IS NULL
         OR "currentPeriodEnd" > "currentPeriodStart");

-- The renewal sweep reads exactly this.
CREATE INDEX "Subscription_status_currentPeriodEnd_idx" ON "Subscription"("status", "currentPeriodEnd");

-- Plans are rows, not code, following LoyaltyScheme: a price change or a withdrawal
-- is an UPDATE. No rows are inserted -- plan names, prices and minutes are still
-- undecided (issue #95), and an empty catalogue is the honest state until they are.
CREATE TABLE "SubscriptionPlanConfig" (
    "plan" "SubscriptionPlan" NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameKa" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'GEL',
    "minutesPerPeriod" INTEGER NOT NULL,
    "isAvailable" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionPlanConfig_pkey" PRIMARY KEY ("plan"),
    -- A plan on sale for nothing, or granting nothing, is a misconfiguration that
    -- would reach a customer as a free subscription or an empty one.
    CONSTRAINT "subscription_plan_sane" CHECK (
      "priceMinor" > 0 AND "minutesPerPeriod" > 0
    )
);

-- The renewal payment for one period. Unique on (subscription, period): two sweep
-- passes over the same period open one payment, which is what lets the sweep run
-- without leader election (ADR-022 section 8).
ALTER TABLE "Payment" ADD COLUMN "subscriptionId" UUID,
ADD COLUMN "periodStart" TIMESTAMP(3);

CREATE UNIQUE INDEX "Payment_subscriptionId_periodStart_key" ON "Payment"("subscriptionId", "periodStart");

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The denormalised minute balance behind CreditLedger, so a spend is a conditional
-- update rather than a row lock -- the loyalty pattern, for the same reason: it does
-- not serialise checkout.
CREATE TABLE "CreditAccount" (
    "userId" UUID NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditAccount_pkey" PRIMARY KEY ("userId"),
    -- Minutes are never owed. A spend that would go below zero is refused by the
    -- conditional update; this is the backstop if one ever is not.
    CONSTRAINT "credit_account_non_negative" CHECK ("balance" >= 0)
);

ALTER TABLE "CreditAccount" ADD CONSTRAINT "CreditAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Append-only, exactly as the loyalty ledger is. A correction is a new entry.
CREATE FUNCTION credit_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CreditLedger is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER credit_ledger_no_update
  BEFORE UPDATE ON "CreditLedger"
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_append_only();

CREATE TRIGGER credit_ledger_no_delete
  BEFORE DELETE ON "CreditLedger"
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_append_only();
