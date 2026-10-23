-- Clients ADR-066: the owner opens a session to Tonight, live. Off for every mission,
-- including those that exist already.
ALTER TABLE "Mission" ADD COLUMN "broadcast" BOOLEAN NOT NULL DEFAULT false;
