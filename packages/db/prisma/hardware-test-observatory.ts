import "dotenv/config";

import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/prisma/client";
import { PHASE1_TARGETS } from "./phase1-catalogue";

/**
 * ADR-074: the observatory the real telescope is brought up on, beside the demo.
 *
 *   DATABASE_URL=... npx tsx prisma/hardware-test-observatory.ts \
 *     --latitude 41.7151 --longitude 44.8271 [--token-file <path>]
 *
 * Creates it once (slug `stellar-tbilisi-hardware`) and, run again, updates only its
 * site coordinates. It is never bookable: it has no network node, so no customer
 * can reserve it, and the API refuses REAL for it if it ever becomes bookable.
 *
 * It starts SIMULATED with an altitude limit nobody has measured: MAX_ALT_SAFE is
 * left null, so every slew is refused until an operator records the measurement
 * from the physical optical train (RUNBOOK §5). Nothing here invents it.
 *
 * With --token-file, a new agent device token is generated and written to that file
 * (mode 600) and only its hash is stored; the token is never printed. Without it the
 * observatory has no token and no agent can connect yet.
 */

const SLUG = "stellar-tbilisi-hardware";

const { values } = parseArgs({
  options: {
    latitude: { type: "string" },
    longitude: { type: "string" },
    "token-file": { type: "string" },
  },
});

const latitude = Number(values.latitude);
const longitude = Number(values.longitude);
if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) {
  throw new Error("--latitude is required, in degrees north (-90 to 90).");
}
if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) {
  throw new Error("--longitude is required, in degrees east (-180 to 180).");
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required.");

const database = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

/** Same algorithm the realtime service uses to verify the presented token. */
function deviceTokenHashOf(token: string) {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

async function main() {
  let deviceTokenHash: string | undefined;
  const tokenFile = values["token-file"];
  if (tokenFile) {
    const token = randomBytes(32).toString("base64url");
    writeFileSync(tokenFile, `DARKVIEW_AGENT_DEVICE_TOKEN=${token}\n`, { mode: 0o600 });
    deviceTokenHash = deviceTokenHashOf(token);
  }

  const existing = await database.observatory.findUnique({ where: { slug: SLUG } });
  if (existing) {
    await database.observatory.update({
      where: { id: existing.id },
      data: { latitude, longitude, ...(deviceTokenHash ? { deviceTokenHash } : {}) },
    });
    console.log(`Updated ${SLUG}: ${existing.id}`);
    return;
  }

  const observatory = await database.observatory.create({
    data: {
      slug: SLUG,
      nameEn: "Stellar Tbilisi — hardware test",
      nameKa: "სტელარი თბილისი — აპარატურის ტესტი",
      city: "Tbilisi",
      countryCode: "GE",
      latitude,
      longitude,
      timezone: "Asia/Tbilisi",
      status: "OFFLINE",
      mode: "SIMULATED",
      deviceTokenHash,
      isDemo: false,
      telescopes: {
        create: {
          name: "Main Telescope",
          manufacturer: "Celestron",
          model: "NexStar 8SE",
          apertureMm: 203,
          focalLengthMm: 2032,
        },
      },
      safetyEnvelope: {
        create: {
          // The same operating values the demo runs on; the altitude limit is not.
          minAltitudeDegrees: 25,
          maxAltitudeDegrees: null,
          sunExclusionDegrees: 30,
          daylightLockSunAltitudeDegrees: -12,
          nudgeMaxDegrees: 0.5,
          nudgeRateDegreesPerSecond: 0.25,
          slewTimeoutSeconds: 120,
          heartbeatLossSeconds: 15,
          linkDeadSeconds: 45,
          refocusTemperatureDeltaC: 1.5,
        },
      },
    },
    include: { telescopes: { select: { id: true } } },
  });

  await database.camera.create({
    data: {
      observatoryId: observatory.id,
      telescopeId: observatory.telescopes[0].id,
      name: "Main Camera",
      manufacturer: "ZWO",
      model: "ASI585MC",
      sensorType: "CMOS colour",
      resolutionX: 3840,
      resolutionY: 2160,
    },
  });

  for (const target of PHASE1_TARGETS) {
    await database.targetObservatory.create({
      data: { targetId: target.id, observatoryId: observatory.id, isDemo: false },
    });
  }

  console.log(`Created ${SLUG}: ${observatory.id}`);
}

try {
  await main();
} finally {
  await database.$disconnect();
}
