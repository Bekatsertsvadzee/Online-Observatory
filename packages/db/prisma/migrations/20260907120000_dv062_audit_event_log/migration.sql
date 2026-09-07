-- DV-062 -- the audit and event log becomes something an operator can read.
--
-- Two alignment gaps, both of them the contract's own fields going nowhere.
--
-- AuditEvent declares `missionId` and `GET /admin/logs?missionId=` filters on it.
-- AuditLog had only the polymorphic entityType/entityId pair, so the one query an
-- operator runs during an incident would have been a scan. It becomes a column with
-- an index, and the foreign key is SetNull: deleting a mission must never delete the
-- account of what was done to it.
--
-- MissionEvent declares `failureReason` and `commandId`. AgentMissionEvent sends
-- both and the cloud discarded both -- the mission kept only its latest failure
-- reason, and nothing recorded which command caused which transition. They become
-- the event's own columns, which is what makes the trail correlated rather than
-- merely chronological.

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN "missionId" UUID;

-- AlterTable
ALTER TABLE "MissionEvent" ADD COLUMN "commandId" UUID,
ADD COLUMN "failureReason" "MissionFailureReason";

-- CreateIndex
CREATE INDEX "AuditLog_missionId_createdAt_idx" ON "AuditLog"("missionId", "createdAt");

-- CreateIndex
CREATE INDEX "MissionEvent_commandId_idx" ON "MissionEvent"("commandId");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionEvent" ADD CONSTRAINT "MissionEvent_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "ObservatoryCommand"("id") ON DELETE SET NULL ON UPDATE CASCADE;
