-- Clients ADR-068: a waitlist for a taken slot, and the email that offers it.
-- CreateEnum
CREATE TYPE "WaitlistEntryStatus" AS ENUM ('WAITING', 'OFFERED', 'CLAIMED', 'LAPSED', 'ENDED', 'LEFT');

-- AlterEnum
ALTER TYPE "EmailNotificationKind" ADD VALUE 'WAITLIST_OFFER';

-- AlterEnum: the contract's reason for a slot offered to its waitlist.
ALTER TYPE "SlotUnavailableReason" ADD VALUE 'HELD_FOR_WAITLIST';

-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "observatoryId" UUID NOT NULL,
    "slotStartAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "status" "WaitlistEntryStatus" NOT NULL DEFAULT 'WAITING',
    "offeredAt" TIMESTAMP(3),
    "offerExpiresAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "claimedBookingId" UUID,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistEntry_claimedBookingId_key" ON "WaitlistEntry"("claimedBookingId");

-- CreateIndex
CREATE INDEX "WaitlistEntry_observatoryId_slotStartAt_status_createdAt_idx" ON "WaitlistEntry"("observatoryId", "slotStartAt", "status", "createdAt");

-- CreateIndex
CREATE INDEX "WaitlistEntry_userId_createdAt_idx" ON "WaitlistEntry"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One active place per person per slot. A place that ended can be followed by a new one.
CREATE UNIQUE INDEX "WaitlistEntry_active_place_key" ON "WaitlistEntry"("userId", "observatoryId", "slotStartAt")
  WHERE "status" IN ('WAITING', 'OFFERED');

-- One offer per slot at a time, so two sweeps running at once cannot offer it twice.
CREATE UNIQUE INDEX "WaitlistEntry_one_offer_per_slot_key" ON "WaitlistEntry"("observatoryId", "slotStartAt")
  WHERE "status" = 'OFFERED';
