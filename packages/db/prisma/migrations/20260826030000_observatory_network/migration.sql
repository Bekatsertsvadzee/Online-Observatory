CREATE TYPE "NetworkNodeKind" AS ENUM ('FIRST_PARTY', 'PARTNER');
CREATE TYPE "NetworkNodeApprovalStatus" AS ENUM ('DRAFT', 'UNDER_REVIEW', 'APPROVED', 'SUSPENDED');

CREATE TABLE "ObservatoryNetworkNode" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "observatoryId" UUID NOT NULL,
    "primaryTelescopeId" UUID,
    "kind" "NetworkNodeKind" NOT NULL,
    "approvalStatus" "NetworkNodeApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "capabilities" TEXT[],
    "approvedAt" TIMESTAMP(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ObservatoryNetworkNode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NetworkAvailabilityWindow" (
    "id" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NetworkAvailabilityWindow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ObservatoryNetworkNode_observatoryId_key" ON "ObservatoryNetworkNode"("observatoryId");
CREATE INDEX "ObservatoryNetworkNode_ownerId_idx" ON "ObservatoryNetworkNode"("ownerId");
CREATE INDEX "ObservatoryNetworkNode_approvalStatus_kind_idx" ON "ObservatoryNetworkNode"("approvalStatus", "kind");
CREATE INDEX "ObservatoryNetworkNode_primaryTelescopeId_idx" ON "ObservatoryNetworkNode"("primaryTelescopeId");
CREATE UNIQUE INDEX "NetworkAvailabilityWindow_nodeId_weekday_startMinute_endMinute_key" ON "NetworkAvailabilityWindow"("nodeId", "weekday", "startMinute", "endMinute");
CREATE INDEX "NetworkAvailabilityWindow_nodeId_enabled_weekday_idx" ON "NetworkAvailabilityWindow"("nodeId", "enabled", "weekday");

ALTER TABLE "ObservatoryNetworkNode" ADD CONSTRAINT "ObservatoryNetworkNode_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ObservatoryNetworkNode" ADD CONSTRAINT "ObservatoryNetworkNode_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ObservatoryNetworkNode" ADD CONSTRAINT "ObservatoryNetworkNode_primaryTelescopeId_fkey" FOREIGN KEY ("primaryTelescopeId") REFERENCES "Telescope"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NetworkAvailabilityWindow" ADD CONSTRAINT "NetworkAvailabilityWindow_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "ObservatoryNetworkNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
