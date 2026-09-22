-- ADR-024 (DV-126): the posture each agent reports, so a node that has disarmed
-- stops being bookable and the operator console can say why.

CREATE TYPE "AgentPosture" AS ENUM ('SIMULATED', 'ATTENDED', 'UNATTENDED', 'DISARMED');

CREATE TYPE "DisarmReason" AS ENUM (
    'HARDWARE_FAULT',
    'PARK_FAILED',
    'LINK_LOST',
    'APPROVAL_WITHDRAWN',
    'LOCAL_DISARM',
    'SKY_SENSOR_STALE'
);

ALTER TABLE "Observatory" ADD COLUMN "agentPosture" "AgentPosture";
ALTER TABLE "Observatory" ADD COLUMN "agentDisarmReason" "DisarmReason";
