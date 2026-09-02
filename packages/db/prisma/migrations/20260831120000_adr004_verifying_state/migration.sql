-- ADR-004: the mission state machine is exactly the enumeration in CLAUDE.md.
-- PLATE_SOLVING was a third spelling of the plate-solve step; CLAUDE.md calls it
-- VERIFYING. Renaming the value preserves existing rows.
ALTER TYPE "MissionState" RENAME VALUE 'PLATE_SOLVING' TO 'VERIFYING';
