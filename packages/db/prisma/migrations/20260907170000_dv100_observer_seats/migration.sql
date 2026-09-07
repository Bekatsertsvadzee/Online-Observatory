-- DV-100 -- observer seats, and the cap that ADR-007 fixed at five.
--
-- The contract's Mission carries observerCapacity and observerCount. Only the
-- first is stored: a count kept in a column is a second source of truth for
-- something the rows already answer, and the two drift the first time a seat is
-- released by a path that forgets to decrement.
--
-- The cap is a CHECK rather than an application rule, for the same reason DV-055's
-- held-slot index and DV-058's active-owner index are constraints: "enforced
-- server-side" in a decision record means the server cannot be talked out of it.

ALTER TABLE "Mission" ADD COLUMN "observerCapacity" INTEGER NOT NULL DEFAULT 5;

-- ADR-007: "Maximum five observers per session, in addition to the controller. A
-- hard cap, enforced server-side." Zero is allowed -- it is how an operator closes
-- a mission to observers without changing its join policy.
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_observer_capacity_within_adr007"
  CHECK ("observerCapacity" >= 0 AND "observerCapacity" <= 5);
