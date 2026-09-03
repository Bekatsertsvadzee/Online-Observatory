-- DV-050 -- bring the schema into agreement with contracts/openapi.yaml.
--
-- THIS MIGRATION IS DESTRUCTIVE. It drops the Reservation table and several columns
-- whose contract equivalents hold different data, and it narrows four enums:
--
--   TargetType         GALAXY, NEBULA, CLUSTER, STAR      removed
--   MissionEventSource SIMULATOR, OBSERVATORY, SYSTEM     removed
--   CaptureVisibility  UNLISTED, PUBLIC                   removed
--   AuditCategory      AUTHENTICATION, AUTHORIZATION,
--                      ACCOUNT, OBSERVATORY               removed
--
-- It is safe here only because no database holding real rows has ever been deployed:
-- every prior migration has run against local development databases. It must never be
-- applied to a populated database without a backfill written first. If rows exist,
-- the ALTER TYPE statements below will fail rather than silently discard data, which
-- is the intended behaviour.
--
-- Reservation is not renamed to Booking, because Booking is not the same record: it
-- carries a target, a price and a payment that Reservation never had.

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'OPERATOR');

-- CreateEnum
CREATE TYPE "MissionFailureReason" AS ENUM ('PLATE_SOLVE_FAILED', 'SLEW_TIMEOUT', 'CENTERING_ITERATIONS_EXHAUSTED', 'TRACKING_LOST', 'MOUNT_FAULT', 'CAMERA_FAULT', 'FOCUSER_FAULT', 'AGENT_LINK_LOST', 'HEARTBEAT_LOST', 'SAFETY_REFUSED', 'SAFETY_ENVELOPE_UNMEASURED', 'TARGET_SET_BELOW_LIMIT', 'WEATHER_UNSAFE', 'SESSION_EXPIRED', 'OPERATOR_ABORT', 'CUSTOMER_CANCELLED', 'PAYMENT_FAILED');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('en', 'ka');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('GEL');

-- CreateEnum
CREATE TYPE "ObservatoryMode" AS ENUM ('SIMULATED', 'REAL');

-- CreateEnum
CREATE TYPE "WeatherStatus" AS ENUM ('CLEAR', 'CLOUDY', 'UNSAFE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SessionRole" AS ENUM ('CONTROLLER', 'OBSERVER');

-- CreateEnum
CREATE TYPE "SlotUnavailableReason" AS ENUM ('ALREADY_BOOKED', 'OUTSIDE_ASTRONOMICAL_DARKNESS', 'WEATHER_HOLD', 'OBSERVATORY_OFFLINE', 'MAINTENANCE', 'IN_THE_PAST');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('SANDBOX', 'BOG_IPAY');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ImagingProfile" AS ENUM ('LUNAR', 'PLANETARY', 'DOUBLE_STAR', 'GLOBULAR_CLUSTER', 'PLANETARY_NEBULA', 'BRIGHT_NEBULA');

-- CreateEnum
CREATE TYPE "OpticalConfig" AS ENUM ('F20_BARLOW', 'F10_NATIVE', 'F6_3_REDUCER');

-- CreateEnum
CREATE TYPE "CaptureAssetKind" AS ENUM ('IMAGE', 'THUMBNAIL', 'FITS', 'UNMARKED');

-- AlterEnum
BEGIN;
CREATE TYPE "AuditCategory_new" AS ENUM ('AUTH', 'BOOKING', 'PAYMENT', 'MISSION', 'COMMAND', 'SAFETY', 'OBSERVATORY_MODE', 'OPERATOR_OVERRIDE', 'AGENT_LINK');
ALTER TABLE "AuditLog" ALTER COLUMN "category" TYPE "AuditCategory_new" USING ("category"::text::"AuditCategory_new");
ALTER TYPE "AuditCategory" RENAME TO "AuditCategory_old";
ALTER TYPE "AuditCategory_new" RENAME TO "AuditCategory";
DROP TYPE "public"."AuditCategory_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "CaptureVisibility_new" AS ENUM ('PRIVATE', 'GALLERY');
ALTER TABLE "public"."Capture" ALTER COLUMN "visibility" DROP DEFAULT;
ALTER TABLE "Capture" ALTER COLUMN "visibility" TYPE "CaptureVisibility_new" USING ("visibility"::text::"CaptureVisibility_new");
ALTER TYPE "CaptureVisibility" RENAME TO "CaptureVisibility_old";
ALTER TYPE "CaptureVisibility_new" RENAME TO "CaptureVisibility";
DROP TYPE "public"."CaptureVisibility_old";
ALTER TABLE "Capture" ALTER COLUMN "visibility" SET DEFAULT 'PRIVATE';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "MissionEventSource_new" AS ENUM ('CLOUD', 'AGENT', 'OPERATOR');
ALTER TABLE "MissionEvent" ALTER COLUMN "source" TYPE "MissionEventSource_new" USING ("source"::text::"MissionEventSource_new");
ALTER TYPE "MissionEventSource" RENAME TO "MissionEventSource_old";
ALTER TYPE "MissionEventSource_new" RENAME TO "MissionEventSource";
DROP TYPE "public"."MissionEventSource_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "TargetType_new" AS ENUM ('MOON', 'PLANET', 'DOUBLE_STAR', 'GLOBULAR_CLUSTER', 'PLANETARY_NEBULA', 'BRIGHT_NEBULA');
ALTER TABLE "Target" ALTER COLUMN "type" TYPE "TargetType_new" USING ("type"::text::"TargetType_new");
ALTER TYPE "TargetType" RENAME TO "TargetType_old";
ALTER TYPE "TargetType_new" RENAME TO "TargetType";
DROP TYPE "public"."TargetType_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "PrivateSession" DROP CONSTRAINT "PrivateSession_reservationId_fkey";

-- DropForeignKey
ALTER TABLE "Reservation" DROP CONSTRAINT "Reservation_missionId_fkey";

-- DropForeignKey
ALTER TABLE "Reservation" DROP CONSTRAINT "Reservation_observatoryId_fkey";

-- DropForeignKey
ALTER TABLE "Reservation" DROP CONSTRAINT "Reservation_telescopeId_fkey";

-- DropForeignKey
ALTER TABLE "Reservation" DROP CONSTRAINT "Reservation_userId_fkey";

-- DropIndex
DROP INDEX "PrivateSession_reservationId_key";

-- AlterTable
ALTER TABLE "Capture" DROP COLUMN "fitsUrl",
DROP COLUMN "originalAssetUrl",
DROP COLUMN "simulated",
DROP COLUMN "thumbnailUrl",
ADD COLUMN     "exposureMilliseconds" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "fitsAvailable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "framesStacked" INTEGER NOT NULL,
ADD COLUMN     "gain" INTEGER NOT NULL,
ADD COLUMN     "heightPx" INTEGER,
ADD COLUMN     "imagingProfile" "ImagingProfile" NOT NULL,
ADD COLUMN     "integrationSeconds" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "mode" "ObservatoryMode" NOT NULL DEFAULT 'SIMULATED',
ADD COLUMN     "opticalConfig" "OpticalConfig" NOT NULL,
ADD COLUMN     "solvedFocalLengthMm" DOUBLE PRECISION,
ADD COLUMN     "widthPx" INTEGER;

-- AlterTable
ALTER TABLE "Mission" DROP COLUMN "simulated",
ADD COLUMN     "failureReason" "MissionFailureReason",
ADD COLUMN     "mode" "ObservatoryMode" NOT NULL DEFAULT 'SIMULATED';

-- AlterTable
ALTER TABLE "Observatory" DROP COLUMN "minimumAltitude",
ADD COLUMN     "mode" "ObservatoryMode" NOT NULL DEFAULT 'SIMULATED';

-- AlterTable
ALTER TABLE "PrivateSession" DROP COLUMN "reservationId",
ADD COLUMN     "bookingId" UUID;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "role",
ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'USER';

-- DropTable
DROP TABLE "Reservation";

-- DropEnum
DROP TYPE "ReservationStatus";

-- DropEnum
DROP TYPE "Role";

-- CreateTable
CREATE TABLE "SafetyEnvelope" (
    "id" UUID NOT NULL,
    "observatoryId" UUID NOT NULL,
    "minAltitudeDegrees" DOUBLE PRECISION NOT NULL,
    "maxAltitudeDegrees" DOUBLE PRECISION,
    "maxAltitudeMeasuredAt" TIMESTAMP(3),
    "maxAltitudeMeasuredBy" TEXT,
    "maxAltitudeMeasurementNote" TEXT,
    "sunExclusionDegrees" DOUBLE PRECISION NOT NULL,
    "daylightLockSunAltitudeDegrees" DOUBLE PRECISION NOT NULL,
    "nudgeMaxDegrees" DOUBLE PRECISION NOT NULL,
    "nudgeRateDegreesPerSecond" DOUBLE PRECISION NOT NULL,
    "slewTimeoutSeconds" INTEGER NOT NULL,
    "heartbeatLossSeconds" INTEGER NOT NULL,
    "linkDeadSeconds" INTEGER NOT NULL,
    "refocusTemperatureDeltaC" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SafetyEnvelope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HorizonMaskEntry" (
    "id" UUID NOT NULL,
    "safetyEnvelopeId" UUID NOT NULL,
    "azimuthDegrees" DOUBLE PRECISION NOT NULL,
    "minAltitudeDegrees" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "HorizonMaskEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AzimuthSector" (
    "id" UUID NOT NULL,
    "safetyEnvelopeId" UUID NOT NULL,
    "fromDegrees" DOUBLE PRECISION NOT NULL,
    "toDegrees" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "AzimuthSector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeatherState" (
    "id" UUID NOT NULL,
    "observatoryId" UUID NOT NULL,
    "status" "WeatherStatus" NOT NULL DEFAULT 'UNKNOWN',
    "holdActive" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "setByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeatherState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "observatoryId" UUID NOT NULL,
    "telescopeId" UUID NOT NULL,
    "missionId" UUID,
    "paymentId" UUID,
    "slotStartAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "priceMinor" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'GEL',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amountMinor" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'GEL',
    "providerRef" TEXT,
    "redirectUrl" TEXT,
    "failureReason" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "authorizedAt" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaptureAsset" (
    "id" UUID NOT NULL,
    "captureId" TEXT NOT NULL,
    "kind" "CaptureAssetKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "byteSize" INTEGER,
    "contentType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaptureAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SafetyEnvelope_observatoryId_key" ON "SafetyEnvelope"("observatoryId");

-- CreateIndex
CREATE UNIQUE INDEX "HorizonMaskEntry_safetyEnvelopeId_azimuthDegrees_key" ON "HorizonMaskEntry"("safetyEnvelopeId", "azimuthDegrees");

-- CreateIndex
CREATE INDEX "AzimuthSector_safetyEnvelopeId_idx" ON "AzimuthSector"("safetyEnvelopeId");

-- CreateIndex
CREATE UNIQUE INDEX "WeatherState_observatoryId_key" ON "WeatherState"("observatoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_missionId_key" ON "Booking"("missionId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_paymentId_key" ON "Booking"("paymentId");

-- CreateIndex
CREATE INDEX "Booking_observatoryId_slotStartAt_idx" ON "Booking"("observatoryId", "slotStartAt");

-- CreateIndex
CREATE INDEX "Booking_userId_slotStartAt_idx" ON "Booking"("userId", "slotStartAt");

-- CreateIndex
CREATE INDEX "Booking_status_idx" ON "Booking"("status");

-- CreateIndex
CREATE INDEX "Payment_userId_createdAt_idx" ON "Payment"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_provider_providerRef_key" ON "Payment"("provider", "providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "CaptureAsset_captureId_kind_key" ON "CaptureAsset"("captureId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "PrivateSession_bookingId_key" ON "PrivateSession"("bookingId");

-- AddForeignKey
ALTER TABLE "SafetyEnvelope" ADD CONSTRAINT "SafetyEnvelope_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HorizonMaskEntry" ADD CONSTRAINT "HorizonMaskEntry_safetyEnvelopeId_fkey" FOREIGN KEY ("safetyEnvelopeId") REFERENCES "SafetyEnvelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AzimuthSector" ADD CONSTRAINT "AzimuthSector_safetyEnvelopeId_fkey" FOREIGN KEY ("safetyEnvelopeId") REFERENCES "SafetyEnvelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeatherState" ADD CONSTRAINT "WeatherState_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_telescopeId_fkey" FOREIGN KEY ("telescopeId") REFERENCES "Telescope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaptureAsset" ADD CONSTRAINT "CaptureAsset_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "Capture"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateSession" ADD CONSTRAINT "PrivateSession_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "NetworkAvailabilityWindow_nodeId_weekday_startMinute_endMinute_" RENAME TO "NetworkAvailabilityWindow_nodeId_weekday_startMinute_endMin_key";


-- CreateIndex
-- Prisma cannot express a partial index, so it is written here by hand.
-- One slot, one confirmed booking. Cancelled, expired and refunded bookings are
-- excluded, so a customer who cancels frees the slot for someone else.
CREATE UNIQUE INDEX "Booking_confirmed_slot_unique"
  ON "Booking" ("observatoryId", "slotStartAt")
  WHERE "status" = 'CONFIRMED';
