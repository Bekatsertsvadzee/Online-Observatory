-- DV-058 -- session ownership becomes the database's rule, and a minted command
-- becomes a durable row shaped like the contract.
--
-- CLAUDE.md: "One active mission at a time. One active session owner at a time."
-- Until now both were assertions in prose. Neither can be enforced by reading and
-- then writing: two requests that arrive together both read "no owner" and both
-- write one. So both become partial unique indexes, and the application's job is
-- to translate the resulting unique violation into a 409.
--
-- This is the same shape as DV-055's Booking_held_slot_unique, for the same reason.

-- CreateTable
CREATE TABLE "MissionSession" (
    "id" UUID NOT NULL,
    "missionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedFor" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MissionSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MissionSession_missionId_issuedAt_idx" ON "MissionSession"("missionId", "issuedAt");

-- CreateIndex
CREATE INDEX "MissionSession_userId_issuedAt_idx" ON "MissionSession"("userId", "issuedAt");

-- CreateIndex
CREATE INDEX "MissionSession_revokedAt_expiresAt_idx" ON "MissionSession"("revokedAt", "expiresAt");

-- AddForeignKey
ALTER TABLE "MissionSession" ADD CONSTRAINT "MissionSession_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionSession" ADD CONSTRAINT "MissionSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- ONE ACTIVE SESSION OWNER PER MISSION.
--
-- A row with revokedAt IS NULL is the current owner. Ending a session, expiring
-- one, or an operator taking control are all the same write: set revokedAt. The
-- row leaves the index and the next owner can be inserted.
--
-- Expiry is deliberately NOT in the predicate. An index cannot compare against
-- now(), so a lapsed session is swept inside the transaction that opens the next
-- one -- again as DV-055 does for unpaid holds.
--
-- Prisma cannot express a partial index, so it is written here by hand.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "MissionSession_active_owner_unique"
  ON "MissionSession" ("missionId")
  WHERE "revokedAt" IS NULL;


-- ---------------------------------------------------------------------------
-- ONE ACTIVE MISSION PER OBSERVATORY.
--
-- There is one telescope. Two missions in a state that commands it would each
-- believe they had it, and the agent -- which holds exactly one mission -- would
-- refuse whichever it was not holding, at a time and in a way nobody could
-- predict. Better to make the second one impossible.
--
-- The listed states are the ones during which a mission may move the mount. They
-- match activeMissionStates in apps/api/src/lib/observatory/command-authorization.ts.
-- REQUESTED and SCHEDULED are excluded on purpose: a night's worth of bookings is
-- scheduled ahead, and only one of them is live at a time. The terminal and hold
-- states are excluded because they command nothing.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "Mission_active_per_observatory_unique"
  ON "Mission" ("observatoryId")
  WHERE "state" IN (
    'PREPARING', 'SLEWING', 'VERIFYING', 'CENTERING', 'OBSERVING', 'CAPTURING'
  );


-- AddConstraint
-- A session that has been revoked must say when. Without this a revokedFor with a
-- null revokedAt would read as an active session carrying a revocation reason,
-- which is not a state that means anything.
ALTER TABLE "MissionSession" ADD CONSTRAINT "mission_session_revocation_is_dated" CHECK (
  "revokedFor" IS NULL OR "revokedAt" IS NOT NULL
);


-- ---------------------------------------------------------------------------
-- ObservatoryCommand becomes the record of one minted CommandEnvelope.
--
-- DESTRUCTIVE: every existing row is deleted. Read before applying to a database
-- you care about.
--
-- Three things change and none can be backfilled:
--
--   operation -> type   ObservatoryCommandOperation had START_MISSION and
--                       ABORT_MISSION, which are not command types the contract
--                       has. It could not express GOTO, NUDGE, FOCUS or
--                       SET_PROFILE at all, so a relay row could not say what it
--                       actually sent. The enum is now the contract's CommandType.
--
--   id -> UUID          id is the contract's commandId and the agent's idempotency
--                       key. The agent parses it as a UUID, so a value it could
--                       not parse must not be storable. The one seeded row's id
--                       was "CMD-DEMO-START-SATURN", which is not one.
--
--   sessionId added     NOT NULL, and no existing row has a session to point at:
--                       MissionSession did not exist until this migration.
--
-- Safe now, before launch, and never again. In this repository every such row is
-- seeded demo data, regenerated by the seed. AuditLog.commandId is ON DELETE SET
-- NULL, so the audit rows survive with a null reference rather than disappearing.
-- ---------------------------------------------------------------------------
DELETE FROM "ObservatoryCommand";

-- CreateEnum
CREATE TYPE "CommandType" AS ENUM ('GOTO', 'NUDGE', 'CAPTURE', 'FOCUS', 'ABORT', 'PARK', 'SET_PROFILE');

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_commandId_fkey";

-- AlterTable
ALTER TABLE "AuditLog" ALTER COLUMN "commandId" TYPE UUID USING "commandId"::uuid;

-- AlterTable
ALTER TABLE "ObservatoryCommand" DROP CONSTRAINT "ObservatoryCommand_pkey",
DROP COLUMN "operation",
ADD COLUMN     "relayedAt" TIMESTAMP(3),
ADD COLUMN     "sessionId" UUID NOT NULL,
ADD COLUMN     "type" "CommandType" NOT NULL,
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
ADD CONSTRAINT "ObservatoryCommand_pkey" PRIMARY KEY ("id");

-- DropEnum
DROP TYPE "ObservatoryCommandOperation";

-- CreateIndex
CREATE INDEX "ObservatoryCommand_observatoryId_relayedAt_idx" ON "ObservatoryCommand"("observatoryId", "relayedAt");

-- AddForeignKey
ALTER TABLE "ObservatoryCommand" ADD CONSTRAINT "ObservatoryCommand_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "MissionSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "ObservatoryCommand"("id") ON DELETE SET NULL ON UPDATE CASCADE;
