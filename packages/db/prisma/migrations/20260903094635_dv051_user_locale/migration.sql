-- DV-051 -- the contract's User requires `locale`, and the table had no column for it,
-- so GET /me could not return the contract shape. Additive: existing rows take 'en',
-- which is the same default the API already applied when no locale was known.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "locale" "Locale" NOT NULL DEFAULT 'en';
