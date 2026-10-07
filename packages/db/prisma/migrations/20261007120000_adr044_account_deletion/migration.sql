-- ADR-044 -- a customer deletes their account.

-- ADD VALUE cannot be used in the transaction that adds it, and nothing here does.
ALTER TYPE "AuthEventType" ADD VALUE 'ACCOUNT_DELETED';

-- Set when the account was deleted. The row stays, anonymised, for the records that
-- must keep an owner: bookings, payments and the ledgers.
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMP(3);
