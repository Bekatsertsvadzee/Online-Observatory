-- The schema models these ids and timestamps client-side (@default(uuid()), @updatedAt),
-- but earlier migrations also gave them database defaults. A fresh migrate diff reported
-- the gap; this closes it so the next generated migration starts clean.
-- AlterTable
ALTER TABLE "BookingEntitlement" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "CreditAccount" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "EmailNotification" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "GiftVoucher" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "LoyaltyLedgerEntry" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "LoyaltyScheme" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ObserverPack" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "SubscriptionPlanConfig" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ViewingForecastHour" ALTER COLUMN "id" DROP DEFAULT;

