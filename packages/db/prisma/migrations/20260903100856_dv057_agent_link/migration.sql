-- DV-057 -- the agent link's stored state.
--
-- Observatory.deviceTokenHash holds SHA-256 of the agent's device token, never the
-- token. AgentMessage records the id of every accepted inbound message so that the
-- agent's replay after an outage is idempotent rather than duplicating rows.
-- Additive: existing observatories get a null token and admit no agent until one is
-- issued, which is the correct fail-closed default.

-- AlterTable
ALTER TABLE "Observatory" ADD COLUMN     "deviceTokenHash" TEXT,
ADD COLUMN     "linkLostAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AgentMessage" (
    "messageId" UUID NOT NULL,
    "observatoryId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("messageId")
);

-- CreateIndex
CREATE INDEX "AgentMessage_observatoryId_receivedAt_idx" ON "AgentMessage"("observatoryId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Observatory_deviceTokenHash_key" ON "Observatory"("deviceTokenHash");

-- AddForeignKey
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

