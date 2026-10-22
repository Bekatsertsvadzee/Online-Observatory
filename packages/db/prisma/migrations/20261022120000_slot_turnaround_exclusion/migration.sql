-- Quarter-hour starts -- the turnaround joins the exclusivity rule.
--
-- Until now slots were a tiling: thirty minutes on a forty-minute stride, so every
-- offered start already sat a full turnaround away from its neighbours and
-- DV-066's constraint only had to forbid raw overlap. Starts are now offered every
-- fifteen minutes, so a booking at 22:00 and another at 22:30 no longer overlap
-- and the constraint below, as it stood, would accept both -- leaving no time to
-- park, slew and refocus between two customers.
--
-- Checking the gap in application code before the insert cannot be correct under
-- concurrency (two transactions both read a free telescope, both insert), which is
-- why DV-055 put exclusivity in the database in the first place. So the rule moves
-- here: each held booking holds [start, start + duration + turnaround). Two such
-- ranges overlap exactly when one session would begin within the turnaround of the
-- other's end, on either side.
--
-- The 10 is SLOT_TURNAROUND_MINUTES in apps/api/src/lib/slots/generate.ts. Change
-- the two together; the integration suite reads this definition back and asserts it.
--
-- Existing held bookings were made on the forty-minute stride, so their widened
-- ranges touch and do not overlap. If any pair does not satisfy the new rule this
-- ALTER fails and the migration rolls back; nothing is silently admitted.
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_held_slot_exclusion";

ALTER TABLE "Booking" ADD CONSTRAINT "Booking_held_slot_exclusion" EXCLUDE USING gist (
  "observatoryId" WITH =,
  tsrange("slotStartAt", "slotStartAt" + make_interval(mins => "durationMinutes" + 10)) WITH &&
) WHERE ("status" IN ('PENDING_PAYMENT', 'CONFIRMED'));
