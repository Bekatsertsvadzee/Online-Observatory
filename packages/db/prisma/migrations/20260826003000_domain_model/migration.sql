CREATE TYPE "ObservatoryStatus" AS ENUM ('ONLINE', 'OFFLINE', 'WEATHER_HOLD', 'MAINTENANCE');
CREATE TYPE "EquipmentStatus" AS ENUM ('ONLINE', 'OFFLINE', 'MAINTENANCE', 'FAULT');
CREATE TYPE "TargetType" AS ENUM ('PLANET', 'MOON', 'GALAXY', 'NEBULA', 'CLUSTER', 'STAR');
CREATE TYPE "VisibilityRating" AS ENUM ('EXCELLENT', 'GOOD', 'FAIR', 'UNAVAILABLE');
CREATE TYPE "MissionState" AS ENUM ('REQUESTED', 'SCHEDULED', 'PREPARING', 'SLEWING', 'PLATE_SOLVING', 'CENTERING', 'OBSERVING', 'CAPTURING', 'PROCESSING', 'COMPLETE', 'WEATHER_HOLD', 'NOT_VISIBLE', 'HARDWARE_ERROR', 'CANCELLED', 'FAILED');
CREATE TYPE "MissionEventSource" AS ENUM ('SIMULATOR', 'OBSERVATORY', 'SYSTEM');
CREATE TYPE "ReservationStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'ACTIVE', 'COMPLETE', 'CANCELLED');
CREATE TYPE "ProcessingPreset" AS ENUM ('NATURAL', 'BRIGHT', 'DETAIL');
CREATE TYPE "CaptureVisibility" AS ENUM ('PRIVATE', 'UNLISTED', 'PUBLIC');
CREATE TYPE "CollectionKind" AS ENUM ('SOLAR_SYSTEM', 'MESSIER_STARTER', 'DEEP_SKY', 'CUSTOM');
CREATE TYPE "SubscriptionPlan" AS ENUM ('OBSERVER', 'EXPLORER', 'ADVANCED');
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAUSED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "CreditLedgerReason" AS ENUM ('SUBSCRIPTION_GRANT', 'MISSION_DEBIT', 'PRIVATE_SESSION_DEBIT', 'REFUND', 'ADJUSTMENT');
CREATE TYPE "PrivateSessionStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'ACTIVE', 'COMPLETE', 'CANCELLED');
CREATE TYPE "ObservatoryCommandOperation" AS ENUM ('START_MISSION', 'ABORT_MISSION', 'PARK', 'CAPTURE');
CREATE TYPE "ObservatoryCommandStatus" AS ENUM ('RECEIVED', 'AUTHORIZED', 'EXECUTING', 'COMPLETED', 'REJECTED', 'EXPIRED', 'FAILED');
CREATE TYPE "AuditCategory" AS ENUM ('AUTHENTICATION', 'AUTHORIZATION', 'ACCOUNT', 'MISSION', 'OBSERVATORY');

ALTER TABLE "User" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "Account" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

INSERT INTO "Account" ("id", "userId", "passwordHash", "createdAt", "updatedAt")
SELECT "id", "id", "passwordHash", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM "User";

ALTER TABLE "User" DROP COLUMN "passwordHash";

ALTER TABLE "AuthAuditEvent" RENAME TO "AuditLog";
ALTER TABLE "AuditLog" RENAME COLUMN "userId" TO "actorUserId";
ALTER TABLE "AuditLog" ADD COLUMN "category" "AuditCategory";
ALTER TABLE "AuditLog" ADD COLUMN "action" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "entityType" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "entityId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "commandId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "metadata" JSONB;
ALTER TABLE "AuditLog" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;
UPDATE "AuditLog" SET "category" = 'AUTHENTICATION', "action" = "type"::TEXT;
ALTER TABLE "AuditLog" ALTER COLUMN "category" SET NOT NULL;
ALTER TABLE "AuditLog" ALTER COLUMN "action" SET NOT NULL;
ALTER TABLE "AuditLog" DROP COLUMN "type";

CREATE TABLE "Observatory" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameKa" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" "ObservatoryStatus" NOT NULL DEFAULT 'OFFLINE',
    "minimumAltitude" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Observatory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Telescope" (
    "id" UUID NOT NULL,
    "observatoryId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "apertureMm" INTEGER NOT NULL,
    "focalLengthMm" INTEGER NOT NULL,
    "status" "EquipmentStatus" NOT NULL DEFAULT 'OFFLINE',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Telescope_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Camera" (
    "id" UUID NOT NULL,
    "observatoryId" UUID NOT NULL,
    "telescopeId" UUID,
    "name" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "sensorType" TEXT NOT NULL,
    "resolutionX" INTEGER,
    "resolutionY" INTEGER,
    "status" "EquipmentStatus" NOT NULL DEFAULT 'OFFLINE',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Camera_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Target" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "commonName" TEXT NOT NULL,
    "georgianName" TEXT NOT NULL,
    "type" "TargetType" NOT NULL,
    "rightAscensionHours" DOUBLE PRECISION NOT NULL,
    "declinationDegrees" DOUBLE PRECISION NOT NULL,
    "magnitude" DOUBLE PRECISION NOT NULL,
    "angularSize" TEXT NOT NULL,
    "descriptionEn" TEXT NOT NULL,
    "descriptionKa" TEXT NOT NULL,
    "minimumAltitude" DOUBLE PRECISION NOT NULL,
    "preferredObservationDurationMinutes" INTEGER NOT NULL,
    "imagePreset" TEXT NOT NULL,
    "bestMonths" INTEGER[] NOT NULL,
    "currentVisibility" "VisibilityRating" NOT NULL,
    "currentAltitude" DOUBLE PRECISION NOT NULL,
    "qualityScore" INTEGER NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Target_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TargetObservatory" (
    "targetId" UUID NOT NULL,
    "observatoryId" UUID NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "TargetObservatory_pkey" PRIMARY KEY ("targetId", "observatoryId")
);

CREATE TABLE "Mission" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "observatoryId" UUID NOT NULL,
    "telescopeId" UUID NOT NULL,
    "state" "MissionState" NOT NULL DEFAULT 'REQUESTED',
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledFor" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Mission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MissionEvent" (
    "id" UUID NOT NULL,
    "missionId" UUID NOT NULL,
    "state" "MissionState" NOT NULL,
    "source" "MissionEventSource" NOT NULL,
    "message" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "MissionEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Reservation" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "observatoryId" UUID NOT NULL,
    "telescopeId" UUID NOT NULL,
    "missionId" UUID,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'REQUESTED',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Capture" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "missionId" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "observatoryId" UUID NOT NULL,
    "telescopeId" UUID NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "processingPreset" "ProcessingPreset" NOT NULL,
    "thumbnailUrl" TEXT NOT NULL,
    "originalAssetUrl" TEXT NOT NULL,
    "fitsUrl" TEXT,
    "visibility" "CaptureVisibility" NOT NULL DEFAULT 'PRIVATE',
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Capture_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Collection" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "CollectionKind" NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameKa" TEXT NOT NULL,
    "descriptionEn" TEXT NOT NULL,
    "descriptionKa" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CollectionCapture" (
    "collectionId" UUID NOT NULL,
    "captureId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "CollectionCapture_pkey" PRIMARY KEY ("collectionId", "captureId")
);

CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreditLedger" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "missionId" UUID,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" "CreditLedgerReason" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "note" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PrivateSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "observatoryId" UUID NOT NULL,
    "telescopeId" UUID NOT NULL,
    "reservationId" UUID,
    "durationMinutes" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "PrivateSessionStatus" NOT NULL DEFAULT 'REQUESTED',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PrivateSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ObservatoryCommand" (
    "id" TEXT NOT NULL,
    "missionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "observatoryId" UUID NOT NULL,
    "operation" "ObservatoryCommandOperation" NOT NULL,
    "status" "ObservatoryCommandStatus" NOT NULL DEFAULT 'RECEIVED',
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "payload" JSONB,
    "result" JSONB,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ObservatoryCommand_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Account_userId_key" ON "Account"("userId");
CREATE UNIQUE INDEX "Observatory_slug_key" ON "Observatory"("slug");
CREATE UNIQUE INDEX "Telescope_observatoryId_name_key" ON "Telescope"("observatoryId", "name");
CREATE INDEX "Telescope_observatoryId_status_idx" ON "Telescope"("observatoryId", "status");
CREATE UNIQUE INDEX "Camera_observatoryId_name_key" ON "Camera"("observatoryId", "name");
CREATE INDEX "Camera_telescopeId_idx" ON "Camera"("telescopeId");
CREATE UNIQUE INDEX "Target_slug_key" ON "Target"("slug");
CREATE UNIQUE INDEX "Target_catalogId_key" ON "Target"("catalogId");
CREATE INDEX "Target_type_currentVisibility_qualityScore_idx" ON "Target"("type", "currentVisibility", "qualityScore");
CREATE INDEX "TargetObservatory_observatoryId_idx" ON "TargetObservatory"("observatoryId");
CREATE INDEX "Mission_userId_requestedAt_idx" ON "Mission"("userId", "requestedAt");
CREATE INDEX "Mission_observatoryId_state_scheduledFor_idx" ON "Mission"("observatoryId", "state", "scheduledFor");
CREATE INDEX "Mission_targetId_idx" ON "Mission"("targetId");
CREATE INDEX "Mission_telescopeId_idx" ON "Mission"("telescopeId");
CREATE INDEX "MissionEvent_missionId_occurredAt_idx" ON "MissionEvent"("missionId", "occurredAt");
CREATE UNIQUE INDEX "Reservation_missionId_key" ON "Reservation"("missionId");
CREATE INDEX "Reservation_observatoryId_startsAt_endsAt_idx" ON "Reservation"("observatoryId", "startsAt", "endsAt");
CREATE INDEX "Reservation_userId_startsAt_idx" ON "Reservation"("userId", "startsAt");
CREATE INDEX "Capture_userId_capturedAt_idx" ON "Capture"("userId", "capturedAt");
CREATE INDEX "Capture_missionId_idx" ON "Capture"("missionId");
CREATE INDEX "Capture_targetId_idx" ON "Capture"("targetId");
CREATE INDEX "Capture_observatoryId_idx" ON "Capture"("observatoryId");
CREATE UNIQUE INDEX "Collection_userId_kind_key" ON "Collection"("userId", "kind");
CREATE INDEX "Collection_userId_idx" ON "Collection"("userId");
CREATE INDEX "CollectionCapture_captureId_idx" ON "CollectionCapture"("captureId");
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");
CREATE UNIQUE INDEX "CreditLedger_idempotencyKey_key" ON "CreditLedger"("idempotencyKey");
CREATE INDEX "CreditLedger_userId_createdAt_idx" ON "CreditLedger"("userId", "createdAt");
CREATE INDEX "CreditLedger_missionId_idx" ON "CreditLedger"("missionId");
CREATE UNIQUE INDEX "PrivateSession_reservationId_key" ON "PrivateSession"("reservationId");
CREATE INDEX "PrivateSession_observatoryId_startsAt_idx" ON "PrivateSession"("observatoryId", "startsAt");
CREATE INDEX "PrivateSession_userId_startsAt_idx" ON "PrivateSession"("userId", "startsAt");
CREATE INDEX "ObservatoryCommand_missionId_issuedAt_idx" ON "ObservatoryCommand"("missionId", "issuedAt");
CREATE INDEX "ObservatoryCommand_observatoryId_status_issuedAt_idx" ON "ObservatoryCommand"("observatoryId", "status", "issuedAt");
CREATE INDEX "ObservatoryCommand_userId_idx" ON "ObservatoryCommand"("userId");

DROP INDEX "AuthAuditEvent_userId_idx";
DROP INDEX "AuthAuditEvent_createdAt_idx";
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");
CREATE INDEX "AuditLog_category_createdAt_idx" ON "AuditLog"("category", "createdAt");
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");
CREATE INDEX "AuditLog_commandId_idx" ON "AuditLog"("commandId");

ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Telescope" ADD CONSTRAINT "Telescope_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Camera" ADD CONSTRAINT "Camera_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Camera" ADD CONSTRAINT "Camera_telescopeId_fkey" FOREIGN KEY ("telescopeId") REFERENCES "Telescope"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TargetObservatory" ADD CONSTRAINT "TargetObservatory_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TargetObservatory" ADD CONSTRAINT "TargetObservatory_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_telescopeId_fkey" FOREIGN KEY ("telescopeId") REFERENCES "Telescope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MissionEvent" ADD CONSTRAINT "MissionEvent_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_telescopeId_fkey" FOREIGN KEY ("telescopeId") REFERENCES "Telescope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Capture" ADD CONSTRAINT "Capture_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Capture" ADD CONSTRAINT "Capture_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Capture" ADD CONSTRAINT "Capture_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Capture" ADD CONSTRAINT "Capture_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Capture" ADD CONSTRAINT "Capture_telescopeId_fkey" FOREIGN KEY ("telescopeId") REFERENCES "Telescope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollectionCapture" ADD CONSTRAINT "CollectionCapture_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollectionCapture" ADD CONSTRAINT "CollectionCapture_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "Capture"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PrivateSession" ADD CONSTRAINT "PrivateSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrivateSession" ADD CONSTRAINT "PrivateSession_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrivateSession" ADD CONSTRAINT "PrivateSession_telescopeId_fkey" FOREIGN KEY ("telescopeId") REFERENCES "Telescope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrivateSession" ADD CONSTRAINT "PrivateSession_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ObservatoryCommand" ADD CONSTRAINT "ObservatoryCommand_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ObservatoryCommand" ADD CONSTRAINT "ObservatoryCommand_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ObservatoryCommand" ADD CONSTRAINT "ObservatoryCommand_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "ObservatoryCommand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AuditLog" RENAME CONSTRAINT "AuthAuditEvent_pkey" TO "AuditLog_pkey";
ALTER TABLE "AuditLog" RENAME CONSTRAINT "AuthAuditEvent_userId_fkey" TO "AuditLog_actorUserId_fkey";
