CREATE TYPE "MissionSharingMode" AS ENUM ('PRIVATE', 'PUBLIC');
CREATE TYPE "MissionJoinPolicy" AS ENUM ('DISABLED', 'OPEN');
CREATE TYPE "MissionParticipantStatus" AS ENUM ('JOINED', 'LEFT');
CREATE TYPE "CaptureAccessStatus" AS ENUM ('AVAILABLE', 'SAVED', 'REVOKED');

ALTER TABLE "Mission" ADD COLUMN "sharingMode" "MissionSharingMode" NOT NULL DEFAULT 'PRIVATE';
ALTER TABLE "Mission" ADD COLUMN "joinPolicy" "MissionJoinPolicy" NOT NULL DEFAULT 'DISABLED';
ALTER TABLE "Mission" ADD COLUMN "allowSharedCaptures" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "MissionPresence" (
    "id" UUID NOT NULL,
    "missionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MissionPresence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MissionParticipant" (
    "id" UUID NOT NULL,
    "missionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "MissionParticipantStatus" NOT NULL DEFAULT 'JOINED',
    "canSaveCaptures" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MissionParticipant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CaptureAccess" (
    "id" UUID NOT NULL,
    "captureId" TEXT NOT NULL,
    "missionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "CaptureAccessStatus" NOT NULL DEFAULT 'AVAILABLE',
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "savedAt" TIMESTAMP(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "CaptureAccess_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MissionPresence_missionId_userId_key" ON "MissionPresence"("missionId", "userId");
CREATE INDEX "MissionPresence_missionId_leftAt_lastSeenAt_idx" ON "MissionPresence"("missionId", "leftAt", "lastSeenAt");
CREATE UNIQUE INDEX "MissionParticipant_missionId_userId_key" ON "MissionParticipant"("missionId", "userId");
CREATE INDEX "MissionParticipant_missionId_status_idx" ON "MissionParticipant"("missionId", "status");
CREATE UNIQUE INDEX "CaptureAccess_captureId_userId_key" ON "CaptureAccess"("captureId", "userId");
CREATE INDEX "CaptureAccess_missionId_userId_status_idx" ON "CaptureAccess"("missionId", "userId", "status");

ALTER TABLE "MissionPresence" ADD CONSTRAINT "MissionPresence_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MissionPresence" ADD CONSTRAINT "MissionPresence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MissionParticipant" ADD CONSTRAINT "MissionParticipant_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MissionParticipant" ADD CONSTRAINT "MissionParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CaptureAccess" ADD CONSTRAINT "CaptureAccess_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "Capture"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CaptureAccess" ADD CONSTRAINT "CaptureAccess_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CaptureAccess" ADD CONSTRAINT "CaptureAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
