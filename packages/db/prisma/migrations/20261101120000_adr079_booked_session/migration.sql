-- ADR-079: a booked session runs for its whole slot.

-- A live session may move to another object visible now.
ALTER TYPE "CommandType" ADD VALUE 'RETARGET';

-- One email at the session's end listing every capture, in place of one per capture.
ALTER TYPE "EmailNotificationKind" ADD VALUE 'SESSION_SUMMARY';

-- The object the session is on now (targetId stays the booked one), when the agent
-- accepted it (the dwell lock), whether the picture is UNRECOVERED (which waives the
-- lock), and the two once-only markers of the session's end.
ALTER TABLE "Mission" ADD COLUMN     "currentTargetId" UUID,
ADD COLUMN     "currentTargetSince" TIMESTAMP(3),
ADD COLUMN     "imageUnrecoveredSince" TIMESTAMP(3),
ADD COLUMN     "sessionEndedNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "slotEndNotifiedAt" TIMESTAMP(3);

CREATE INDEX "Mission_currentTargetId_idx" ON "Mission"("currentTargetId");

ALTER TABLE "Mission" ADD CONSTRAINT "Mission_currentTargetId_fkey" FOREIGN KEY ("currentTargetId") REFERENCES "Target"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A mission live when this runs is on its booked target, and has been since it
-- started. Missions that already ended are left with no current target: nothing in
-- ADR-079 applies to them, and the session-end sweep reads a null here as "ended
-- before booked sessions existed" and sends them nothing.
UPDATE "Mission"
SET "currentTargetId" = "targetId", "currentTargetSince" = "startedAt"
WHERE "state" IN (
  'PREPARING', 'SLEWING', 'VERIFYING', 'CENTERING', 'OBSERVING', 'CAPTURING', 'PROCESSING'
);

-- PROCESSING returns to OBSERVING while the slot runs, so it is a live state and a
-- mission in it holds the observatory like any other live one. The predicate is
-- LIVE_MISSION_STATES in apps/api and apps/realtime; all three change together.
--
-- Fails if an observatory has a mission stuck in PROCESSING beside another live one.
-- Before applying, this must return no rows:
--   SELECT "observatoryId" FROM "Mission" WHERE "state" IN ('PREPARING', 'SLEWING',
--     'VERIFYING', 'CENTERING', 'OBSERVING', 'CAPTURING', 'PROCESSING')
--   GROUP BY "observatoryId" HAVING count(*) > 1;
DROP INDEX "Mission_active_per_observatory_unique";
CREATE UNIQUE INDEX "Mission_active_per_observatory_unique"
  ON "Mission" ("observatoryId")
  WHERE "state" IN (
    'PREPARING', 'SLEWING', 'VERIFYING', 'CENTERING', 'OBSERVING', 'CAPTURING', 'PROCESSING'
  );
