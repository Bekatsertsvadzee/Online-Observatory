-- DV-110 -- viewing conditions: an hourly forecast per observatory.
--
-- Advisory only. Nothing in this table sets or clears a weather hold; the
-- operator's hold in "WeatherState" stays authoritative. The realtime service
-- fetches on a schedule and overwrites the hours it covers. A failed fetch writes
-- nothing, so stale hours age out and are reported UNKNOWN, never clear.

CREATE TYPE "ForecastSource" AS ENUM ('METEOBLUE', 'OPEN_METEO');

CREATE TABLE "ViewingForecastHour" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "observatoryId" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "source" "ForecastSource" NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "cloudCoverPercent" DOUBLE PRECISION,
    "cloudCoverLowPercent" DOUBLE PRECISION,
    "cloudCoverMidPercent" DOUBLE PRECISION,
    "cloudCoverHighPercent" DOUBLE PRECISION,
    "precipitationProbabilityPercent" DOUBLE PRECISION,
    "relativeHumidityPercent" DOUBLE PRECISION,
    "windSpeedMetresPerSecond" DOUBLE PRECISION,
    "seeingArcseconds" DOUBLE PRECISION,

    CONSTRAINT "ViewingForecastHour_pkey" PRIMARY KEY ("id")
);

-- One row per observatory per hour: a fetch overwrites, it never duplicates.
CREATE UNIQUE INDEX "ViewingForecastHour_observatoryId_at_key" ON "ViewingForecastHour"("observatoryId", "at");

ALTER TABLE "ViewingForecastHour" ADD CONSTRAINT "ViewingForecastHour_observatoryId_fkey" FOREIGN KEY ("observatoryId") REFERENCES "Observatory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
