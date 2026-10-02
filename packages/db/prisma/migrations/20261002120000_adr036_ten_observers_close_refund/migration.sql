-- ADR-036 -- ten observer seats, and a refund for the time a close takes.
--
-- ADR-036 amends ADR-007 rule 3 from five observers to ten, and adds a rule ADR-007
-- did not have: when the owner closes a session to observers, every paid seat is
-- refunded the share of its price that matches the time it loses.

-- The cap moves from five to ten. Still a CHECK, for the reason DV-100 gave: "enforced
-- server-side" means the server cannot be talked out of it. Zero stays allowed.
ALTER TABLE "Mission" DROP CONSTRAINT "Mission_observer_capacity_within_adr007";
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_observer_capacity_within_adr036"
  CHECK ("observerCapacity" >= 0 AND "observerCapacity" <= 10);

-- New missions open with the full ten. Existing rows keep the capacity they were
-- given: raising a mission somebody set to five, or an operator set lower, is not
-- this migration's decision to make.
ALTER TABLE "Mission" ALTER COLUMN "observerCapacity" SET DEFAULT 10;

-- The refund. Recorded on the pack rather than as a new PaymentStatus or a refund
-- table: one seat is refunded at most once, and the pack is the sale it belongs to.
--
-- refundedMinor is the contract's ObserverPack.refundedMinor, set only once the money
-- has actually gone back, with refundedAt as the instant it did. refundOwedMinor is a
-- refund decided but not issued, because no live provider's refund API is integrated
-- yet -- the case DV-111 calls PROVIDER_REFUND_UNAVAILABLE. Kept apart so an owed
-- refund is never read as a paid one.
ALTER TABLE "ObserverPack"
  ADD COLUMN "refundedMinor" INTEGER,
  ADD COLUMN "refundedAt" TIMESTAMP(3),
  ADD COLUMN "refundOwedMinor" INTEGER;

-- Money is integer minor units, never negative, and never more than was paid.
ALTER TABLE "ObserverPack" ADD CONSTRAINT "ObserverPack_refund_within_price"
  CHECK (
    ("refundedMinor" IS NULL OR ("refundedMinor" >= 0 AND "refundedMinor" <= "priceMinor"))
    AND ("refundOwedMinor" IS NULL OR ("refundOwedMinor" >= 0 AND "refundOwedMinor" <= "priceMinor"))
  );

-- An issued refund knows when it was issued, and an unissued one has no such instant.
ALTER TABLE "ObserverPack" ADD CONSTRAINT "ObserverPack_refunded_has_instant"
  CHECK (("refundedMinor" IS NULL) = ("refundedAt" IS NULL));

-- Issued or owed, never both. The close writes either column only while both are
-- null, by a conditional update, which is what keeps a second close from refunding
-- a seat twice.
ALTER TABLE "ObserverPack" ADD CONSTRAINT "ObserverPack_refund_issued_or_owed"
  CHECK ("refundedMinor" IS NULL OR "refundOwedMinor" IS NULL);

-- The observer is told, in the same outbox as the other refund emails.
ALTER TYPE "EmailNotificationKind" ADD VALUE 'OBSERVER_PACK_REFUNDED';
