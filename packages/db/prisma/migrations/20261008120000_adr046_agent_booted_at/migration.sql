-- ADR-046 -- a reconnect is not a restart.

-- The AgentHello.bootedAt last accepted. Null until the first hello after deploy, which
-- is therefore read as a restart: the conservative end.
ALTER TABLE "Observatory" ADD COLUMN "agentBootedAt" TIMESTAMP(3);
