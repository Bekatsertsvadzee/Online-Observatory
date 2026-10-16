-- ADR-050: the week's vote. One row per customer, observatory and week; casting again
-- updates the row rather than adding one.
CREATE TABLE "Vote" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "observatoryId" UUID NOT NULL,
    "week" DATE NOT NULL,
    "targetId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Vote_userId_observatoryId_week_key" ON "Vote"("userId", "observatoryId", "week");
CREATE INDEX "Vote_observatoryId_week_idx" ON "Vote"("observatoryId", "week");

ALTER TABLE "Vote" ADD CONSTRAINT "Vote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Vote" ADD CONSTRAINT "Vote_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Vote" ADD CONSTRAINT "Vote_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE CASCADE ON UPDATE CASCADE;
