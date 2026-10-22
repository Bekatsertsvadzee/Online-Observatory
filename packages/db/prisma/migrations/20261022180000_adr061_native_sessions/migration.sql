-- ADR-061: a session belongs to the web client (cookies) or a native client (bearer).
-- Every existing session is a web one.
-- CreateEnum
CREATE TYPE "SessionClient" AS ENUM ('WEB', 'NATIVE');

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "client" "SessionClient" NOT NULL DEFAULT 'WEB';
