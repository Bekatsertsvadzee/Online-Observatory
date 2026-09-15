-- DV-064 -- email notifications, through an outbox.
--
-- A notification is written in the same transaction as the event that causes it,
-- so an event cannot commit without its email queued and a rolled-back event
-- queues nothing. The realtime service delivers the outbox; a mail outage delays
-- an email and never fails the booking, payment or mission behind it.

CREATE TYPE "EmailNotificationKind" AS ENUM ('BOOKING_CONFIRMED', 'SLOT_REMINDER', 'WEATHER_HOLD', 'CAPTURE_READY');

-- SKIPPED: not sent because it no longer applies -- a reminder for a booking
-- that was cancelled after it was queued. Distinct from FAILED, which is a
-- delivery that ran out of attempts.
CREATE TYPE "EmailNotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

CREATE TABLE "EmailNotification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "kind" "EmailNotificationKind" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "EmailNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailNotification_pkey" PRIMARY KEY ("id")
);

-- One email per event per recipient. Queueing the same event twice -- a repeated
-- payment callback, a reminder sweep that runs every minute -- writes one row.
CREATE UNIQUE INDEX "EmailNotification_dedupeKey_key" ON "EmailNotification"("dedupeKey");

-- The dispatcher's query: what is due now.
CREATE INDEX "EmailNotification_status_nextAttemptAt_idx" ON "EmailNotification"("status", "nextAttemptAt");

ALTER TABLE "EmailNotification" ADD CONSTRAINT "EmailNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
