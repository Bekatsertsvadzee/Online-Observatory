-- DV-066 -- exclusivity stops being a claim about one slot length.
--
-- DV-055 keyed exclusivity on the start instant:
--
--   CREATE UNIQUE INDEX "Booking_held_slot_unique"
--     ON "Booking" ("observatoryId", "slotStartAt")
--     WHERE "status" IN ('PENDING_PAYMENT', 'CONFIRMED');
--
-- With one fixed length that is airtight and elegant. Every slot starts on the same
-- stride, so an equal start is the same slot and a different start cannot overlap.
--
-- ADR-015 decided slot duration varies. The instant that happens the index is
-- silently wrong: a sixty-minute booking at 21:00 and a twenty-minute one at 21:20
-- have different start instants, so both inserts succeed and two customers hold one
-- telescope at the same time. Nothing raises, nothing logs, and the first anyone
-- learns of it is two people watching the same mount.
--
-- DV-055 was explicit that exclusivity lives in the index and nowhere else,
-- precisely so it could not be quietly weakened by application code. Honouring that
-- means replacing the index rather than adding a check above it.

-- ---------------------------------------------------------------------------
-- btree_gist, because the constraint compares two things in two different ways.
--
-- An exclusion constraint needs one index over both columns: "observatoryId" by
-- equality and the booked interval by overlap. GiST knows how to overlap a range
-- and does not know how to equate a uuid; btree_gist is what teaches it the second.
--
-- NOT A TRUSTED EXTENSION. On PostgreSQL 13 and later this statement requires a
-- superuser, so a production deployment whose application role is unprivileged must
-- have it installed by an administrator before this migration runs. CI's postgres
-- service container runs as a superuser, so it installs here.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;


-- ---------------------------------------------------------------------------
-- A duration must be positive, and this is not housekeeping.
--
-- tsrange(t, t) is the empty range, and the empty range overlaps nothing -- not
-- even itself. A booking with a zero duration would therefore satisfy the
-- constraint below against every other row, taking itself out of the exclusivity
-- rule while still holding a telescope. A negative duration raises instead, which
-- is loud and therefore harmless.
--
-- So the silent case is the one that has to be closed, and it has to be closed in
-- the database for the same reason the exclusion itself is: the constraint's
-- correctness depends on it, and a guarantee that depends on application code
-- having been careful is not a guarantee.
-- ---------------------------------------------------------------------------
ALTER TABLE "Booking" ADD CONSTRAINT "booking_duration_is_positive" CHECK (
  "durationMinutes" > 0
);


-- ---------------------------------------------------------------------------
-- THE CONSTRAINT IS THE EXCLUSIVITY RULE. It still is; it is now a rule about
-- intervals rather than about instants.
--
-- Two held bookings at one observatory may not overlap in time. Not "may not start
-- together" -- may not overlap. Everything DV-055 said about this still applies:
-- two concurrent transactions both see a free telescope, both insert, and exactly
-- one survives because of this constraint and for no other reason. The test that
-- proves it drops this, watches a named test double-book, and restores it.
--
-- tsrange, not tstzrange. ADR-015's prose wrote tstzrange; "slotStartAt" is
-- TIMESTAMP(3) WITHOUT TIME ZONE, and casting it to timestamptz inside an index
-- expression would read the session's TimeZone, which is not immutable and which
-- PostgreSQL will refuse. Prisma writes every value in that column in UTC, so a
-- tsrange compares like with like and the two forms mean the same thing here. The
-- record carries a dated correction saying so.
--
-- make_interval(mins => ...), not ("durationMinutes" || ' minutes')::interval.
-- interval_in reads IntervalStyle and so is only stable; make_interval is
-- immutable, which is what an index expression requires.
--
-- '[)' is the default bound pair and the right one: a booking that ends at 21:20
-- and one that starts at 21:20 do not overlap, which is how a stride of adjacent
-- slots has to behave.
--
-- The WHERE clause is DV-055's, unchanged. CANCELLED, EXPIRED and REFUNDED stay
-- outside it: releasing a slot is a status change and nothing more.
-- ---------------------------------------------------------------------------
DROP INDEX "Booking_held_slot_unique";

ALTER TABLE "Booking" ADD CONSTRAINT "Booking_held_slot_exclusion" EXCLUDE USING gist (
  "observatoryId" WITH =,
  tsrange("slotStartAt", "slotStartAt" + make_interval(mins => "durationMinutes")) WITH &&
) WHERE ("status" IN ('PENDING_PAYMENT', 'CONFIRMED'));
