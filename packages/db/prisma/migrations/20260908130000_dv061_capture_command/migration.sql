-- DV-061. A capture is traceable to the command that produced it, and the
-- correlation is also what makes recording one idempotent.
--
-- MissionEvent and AuditLog already carry commandId. Without this column the
-- capture is the single artefact of a mission that cannot be joined back to the
-- instruction that made it -- which is exactly the row an operator reconstructing
-- a session most wants to correlate.
--
-- The unique index is the idempotency guarantee. The realtime service already
-- deduplicates by messageId, but that lives in the application and in one table;
-- this puts "one capture per CAPTURE command" where it cannot be bypassed by a
-- future writer, an operator script, or an agent build that regenerates a
-- messageId on retry. Postgres permits many NULLs under a unique index, so a
-- capture with no originating command is unconstrained -- which is what we want.
ALTER TABLE "Capture" ADD COLUMN "commandId" UUID;

ALTER TABLE "Capture"
  ADD CONSTRAINT "Capture_commandId_fkey"
  FOREIGN KEY ("commandId") REFERENCES "ObservatoryCommand"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Capture_command_unique" ON "Capture" ("commandId");
