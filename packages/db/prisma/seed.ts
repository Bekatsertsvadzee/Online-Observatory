import "dotenv/config";

import { createHash } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/prisma/client";
import { SIMULATOR_ENVELOPE_MEASURER } from "../simulator-envelope";
import { PHASE1_TARGETS } from "./phase1-catalogue";
import {
  DEMO_ACCOUNT_EMAILS,
  DEMO_ACCOUNT_PASSWORD,
  DEMO_ACCOUNT_PASSWORD_HASH,
  DEMO_AGENT_DEVICE_TOKEN,
  DEMO_CAPTURES,
  DEMO_IDS,
  DEMO_MISSIONS,
  DEMO_NIGHT_AGENT_DEVICE_TOKEN,
  DEMO_NIGHT_SITE,
  SIMULATOR_MAX_ALTITUDE_DEGREES,
  assertDevelopmentSeedData,
} from "./development-seed";

/** Same algorithm the realtime service uses to verify the presented token. */
function deviceTokenHashOf(token: string) {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

/**
 * The simulator's safety envelope, for one SIMULATED demo observatory (ADR-032).
 *
 * MAX_ALT_SAFE is MEASURED from the physical optical train (DV-034), and no
 * observatory with real hardware may carry a value nobody measured. This one is
 * written anyway, and it is safe for three independent reasons:
 *
 * 1. It is written only after re-reading the row and finding it SIMULATED and
 *    isDemo. Anything else throws, and nothing is written.
 * 2. It is recorded under SIMULATOR_ENVELOPE_MEASURER, not a person. The API's and
 *    the realtime service's envelope loaders read a marked envelope on any
 *    observatory that is not SIMULATED as UNMEASURED; setSafetyEnvelope refuses the
 *    marker there, switching to REAL is refused while it stands, and node approval
 *    never counts it as measured.
 * 3. The agent applies the same rule on its own: a marked envelope reaching an
 *    agent whose driver mode or mount is not SIMULATED is UNMEASURED, and every
 *    slew is refused.
 *
 * So the number moves the simulator and nothing else.
 */
async function seedSimulatorEnvelope(
  database: PrismaClient,
  input: { id: string; observatoryId: string },
) {
  const observatory = await database.observatory.findUniqueOrThrow({
    where: { id: input.observatoryId },
    select: { mode: true, isDemo: true },
  });
  if (observatory.mode !== "SIMULATED" || !observatory.isDemo) {
    throw new Error(
      `Refusing to write the simulator envelope to ${input.observatoryId}: ` +
        "it is only ever written to a SIMULATED demo observatory.",
    );
  }

  const simulatorLimit = {
    maxAltitudeDegrees: SIMULATOR_MAX_ALTITUDE_DEGREES,
    maxAltitudeMeasuredAt: new Date("2026-09-28T00:00:00.000Z"),
    maxAltitudeMeasuredBy: SIMULATOR_ENVELOPE_MEASURER,
    maxAltitudeMeasurementNote:
      "Development seed, ADR-032. NOT A MEASUREMENT: nobody measured this. It lets the " +
      "simulator slew, and is read as UNMEASURED on any observatory or agent that is " +
      "not SIMULATED.",
  };

  await database.safetyEnvelope.upsert({
    where: { observatoryId: input.observatoryId },
    create: {
      id: input.id,
      observatoryId: input.observatoryId,
      minAltitudeDegrees: 25,
      ...simulatorLimit,
      sunExclusionDegrees: 30,
      daylightLockSunAltitudeDegrees: -12,
      nudgeMaxDegrees: 0.5,
      nudgeRateDegreesPerSecond: 0.25,
      slewTimeoutSeconds: 120,
      heartbeatLossSeconds: 15,
      linkDeadSeconds: 45,
      refocusTemperatureDeltaC: 1.5,
    },
    update: { minAltitudeDegrees: 25, ...simulatorLimit },
  });
}

async function seedDevelopmentDatabase() {
  if (process.env.NODE_ENV !== "development") {
    throw new Error("Development seed requires NODE_ENV=development.");
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to seed the development database.");
  }

  assertDevelopmentSeedData();

  const database = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    await database.user.upsert({
      where: { id: DEMO_IDS.observer },
      create: {
        id: DEMO_IDS.observer,
        email: DEMO_ACCOUNT_EMAILS.observer,
        name: "[DEMO] Stellar Observer",
        role: "USER",
        emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
        isDemo: true,
      },
      update: {
        email: DEMO_ACCOUNT_EMAILS.observer,
        name: "[DEMO] Stellar Observer",
        role: "USER",
        emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
        isDemo: true,
      },
    });

    await database.user.upsert({
      where: { id: DEMO_IDS.operator },
      create: {
        id: DEMO_IDS.operator,
        email: DEMO_ACCOUNT_EMAILS.operator,
        name: "[DEMO] Simulator Operator",
        role: "OPERATOR",
        emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
        isDemo: true,
      },
      update: {
        email: DEMO_ACCOUNT_EMAILS.operator,
        name: "[DEMO] Simulator Operator",
        role: "OPERATOR",
        emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
        isDemo: true,
      },
    });

    await database.user.upsert({
      where: { id: DEMO_IDS.viewer },
      create: {
        id: DEMO_IDS.viewer,
        email: DEMO_ACCOUNT_EMAILS.viewer,
        name: "[DEMO] Mission Viewer",
        role: "USER",
        emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
        isDemo: true,
      },
      update: {
        email: DEMO_ACCOUNT_EMAILS.viewer,
        name: "[DEMO] Mission Viewer",
        role: "USER",
        emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
        isDemo: true,
      },
    });

    for (const userId of [DEMO_IDS.observer, DEMO_IDS.operator, DEMO_IDS.viewer]) {
      await database.account.upsert({
        where: { userId },
        create: {
          id: userId,
          userId,
          passwordHash: DEMO_ACCOUNT_PASSWORD_HASH,
          isDemo: true,
        },
        update: { passwordHash: DEMO_ACCOUNT_PASSWORD_HASH, isDemo: true },
      });
    }

    const demoDeviceTokenHash = deviceTokenHashOf(DEMO_AGENT_DEVICE_TOKEN);

    await database.observatory.upsert({
      where: { id: DEMO_IDS.observatory },
      create: {
        id: DEMO_IDS.observatory,
        slug: "demo-tbilisi",
        nameEn: "[DEMO] Stellar Tbilisi Observatory",
        nameKa: "[დემო] სტელარის თბილისის ობსერვატორია",
        city: "Tbilisi",
        countryCode: "GE",
        latitude: 41.7151,
        longitude: 44.8271,
        timezone: "Asia/Tbilisi",
        status: "ONLINE",
        mode: "SIMULATED",
        deviceTokenHash: demoDeviceTokenHash,
        isDemo: true,
      },
      update: {
        nameEn: "[DEMO] Stellar Tbilisi Observatory",
        nameKa: "[დემო] სტელარის თბილისის ობსერვატორია",
        status: "ONLINE",
        mode: "SIMULATED",
        deviceTokenHash: demoDeviceTokenHash,
        isDemo: true,
      },
    });

    await seedSimulatorEnvelope(database, {
      id: DEMO_IDS.safetyEnvelope,
      observatoryId: DEMO_IDS.observatory,
    });

    await database.telescope.upsert({
      where: { id: DEMO_IDS.telescope },
      create: {
        id: DEMO_IDS.telescope,
        observatoryId: DEMO_IDS.observatory,
        name: "[DEMO] Main Telescope",
        manufacturer: "Celestron",
        model: "NexStar 6SE configuration",
        apertureMm: 150,
        focalLengthMm: 1500,
        status: "ONLINE",
        isDemo: true,
      },
      update: {
        manufacturer: "Celestron",
        model: "NexStar 6SE configuration",
        apertureMm: 150,
        focalLengthMm: 1500,
        status: "ONLINE",
        isDemo: true,
      },
    });

    await database.camera.upsert({
      where: { id: DEMO_IDS.camera },
      create: {
        id: DEMO_IDS.camera,
        observatoryId: DEMO_IDS.observatory,
        telescopeId: DEMO_IDS.telescope,
        name: "[DEMO] Development Astronomy Camera",
        manufacturer: "Configuration pending",
        model: "Development placeholder",
        sensorType: "Development placeholder",
        status: "ONLINE",
        isDemo: true,
      },
      update: {
        telescopeId: DEMO_IDS.telescope,
        manufacturer: "Configuration pending",
        model: "Development placeholder",
        sensorType: "Development placeholder",
        status: "ONLINE",
        isDemo: true,
      },
    });

    await database.observatoryNetworkNode.upsert({
      where: { id: DEMO_IDS.networkNode },
      create: {
        id: DEMO_IDS.networkNode,
        ownerId: DEMO_IDS.operator,
        observatoryId: DEMO_IDS.observatory,
        primaryTelescopeId: DEMO_IDS.telescope,
        kind: "FIRST_PARTY",
        approvalStatus: "APPROVED",
        capabilities: ["PLANETARY", "LUNAR", "BRIGHT_DEEP_SKY"],
        approvedAt: new Date("2026-08-01T00:00:00.000Z"),
        isDemo: true,
      },
      update: {
        ownerId: DEMO_IDS.operator,
        primaryTelescopeId: DEMO_IDS.telescope,
        kind: "FIRST_PARTY",
        approvalStatus: "APPROVED",
        capabilities: ["PLANETARY", "LUNAR", "BRIGHT_DEEP_SKY"],
        approvedAt: new Date("2026-08-01T00:00:00.000Z"),
        isDemo: true,
      },
    });

    for (let weekday = 0; weekday < 7; weekday += 1) {
      const id = `00000000-0000-4000-8000-00000000053${weekday}`;
      await database.networkAvailabilityWindow.upsert({
        where: { id },
        create: {
          id,
          nodeId: DEMO_IDS.networkNode,
          weekday,
          startMinute: 1080,
          endMinute: 1439,
          enabled: true,
          isDemo: true,
        },
        update: {
          startMinute: 1080,
          endMinute: 1439,
          enabled: true,
          isDemo: true,
        },
      });
    }

    // The Phase 1 catalogue is real product data, not demo data: exactly the twelve
    // objects of Build Plan section 01. previewImageUrl stays null until the
    // operator has photographed the target through this telescope.
    for (const target of PHASE1_TARGETS) {
      const { id, ...data } = target;
      await database.target.upsert({
        where: { id },
        create: { id, ...data },
        update: data,
      });
      await database.targetObservatory.upsert({
        where: {
          targetId_observatoryId: {
            targetId: id,
            observatoryId: DEMO_IDS.observatory,
          },
        },
        create: {
          targetId: id,
          observatoryId: DEMO_IDS.observatory,
          isDemo: false,
        },
        update: { isDemo: false },
      });
    }

    // The night-side simulator (#146). Everything the Tbilisi demo has, at a site
    // where it is night during Tbilisi's working day. No safety rule is exempted:
    // the cloud and the agent both judge the Sun from these coordinates.
    await database.observatory.upsert({
      where: { id: DEMO_IDS.nightObservatory },
      create: {
        id: DEMO_IDS.nightObservatory,
        slug: "demo-night-side",
        nameEn: "[DEMO] Stellar Night-side Simulator",
        nameKa: "[დემო] სტელარის ღამის მხარის სიმულატორი",
        city: "Mauna Kea",
        countryCode: "US",
        latitude: DEMO_NIGHT_SITE.latitude,
        longitude: DEMO_NIGHT_SITE.longitude,
        timezone: DEMO_NIGHT_SITE.timezone,
        status: "ONLINE",
        mode: "SIMULATED",
        deviceTokenHash: deviceTokenHashOf(DEMO_NIGHT_AGENT_DEVICE_TOKEN),
        isDemo: true,
      },
      update: {
        nameEn: "[DEMO] Stellar Night-side Simulator",
        nameKa: "[დემო] სტელარის ღამის მხარის სიმულატორი",
        latitude: DEMO_NIGHT_SITE.latitude,
        longitude: DEMO_NIGHT_SITE.longitude,
        timezone: DEMO_NIGHT_SITE.timezone,
        status: "ONLINE",
        mode: "SIMULATED",
        deviceTokenHash: deviceTokenHashOf(DEMO_NIGHT_AGENT_DEVICE_TOKEN),
        isDemo: true,
      },
    });

    await seedSimulatorEnvelope(database, {
      id: DEMO_IDS.nightSafetyEnvelope,
      observatoryId: DEMO_IDS.nightObservatory,
    });

    const nightTelescope = {
      name: "[DEMO] Night-side Telescope",
      manufacturer: "Celestron",
      model: "NexStar 6SE configuration",
      apertureMm: 150,
      focalLengthMm: 1500,
      status: "ONLINE" as const,
      isDemo: true,
    };
    await database.telescope.upsert({
      where: { id: DEMO_IDS.nightTelescope },
      create: {
        id: DEMO_IDS.nightTelescope,
        observatoryId: DEMO_IDS.nightObservatory,
        ...nightTelescope,
      },
      update: nightTelescope,
    });

    const nightCamera = {
      telescopeId: DEMO_IDS.nightTelescope,
      name: "[DEMO] Night-side Development Camera",
      manufacturer: "Configuration pending",
      model: "Development placeholder",
      sensorType: "Development placeholder",
      status: "ONLINE" as const,
      isDemo: true,
    };
    await database.camera.upsert({
      where: { id: DEMO_IDS.nightCamera },
      create: {
        id: DEMO_IDS.nightCamera,
        observatoryId: DEMO_IDS.nightObservatory,
        ...nightCamera,
      },
      update: nightCamera,
    });

    const nightNode = {
      ownerId: DEMO_IDS.operator,
      primaryTelescopeId: DEMO_IDS.nightTelescope,
      kind: "FIRST_PARTY" as const,
      approvalStatus: "APPROVED" as const,
      capabilities: ["PLANETARY" as const, "LUNAR" as const, "BRIGHT_DEEP_SKY" as const],
      approvedAt: new Date("2026-09-28T00:00:00.000Z"),
      isDemo: true,
    };
    await database.observatoryNetworkNode.upsert({
      where: { id: DEMO_IDS.nightNetworkNode },
      create: {
        id: DEMO_IDS.nightNetworkNode,
        observatoryId: DEMO_IDS.nightObservatory,
        ...nightNode,
      },
      update: nightNode,
    });

    // The whole local night, every weekday. A window may not wrap midnight
    // (lib/slots/availability.ts), so each day has an evening window to local
    // midnight (endMinute 1440 is exclusive) and a morning one from it; the slot
    // generator merges the two across midnight and intersects them with
    // astronomical darkness, which still decides what is actually sold.
    const nightWindows = [
      { suffix: "054", startMinute: 1020, endMinute: 1440 },
      { suffix: "055", startMinute: 0, endMinute: 420 },
    ];
    for (const { suffix, startMinute, endMinute } of nightWindows) {
      for (let weekday = 0; weekday < 7; weekday += 1) {
        const id = `00000000-0000-4000-8000-00000000${suffix}${weekday}`;
        await database.networkAvailabilityWindow.upsert({
          where: { id },
          create: {
            id,
            nodeId: DEMO_IDS.nightNetworkNode,
            weekday,
            startMinute,
            endMinute,
            enabled: true,
            isDemo: true,
          },
          update: { startMinute, endMinute, enabled: true, isDemo: true },
        });
      }
    }

    for (const target of PHASE1_TARGETS) {
      await database.targetObservatory.upsert({
        where: {
          targetId_observatoryId: {
            targetId: target.id,
            observatoryId: DEMO_IDS.nightObservatory,
          },
        },
        create: {
          targetId: target.id,
          observatoryId: DEMO_IDS.nightObservatory,
          isDemo: true,
        },
        update: { isDemo: true },
      });
    }

    for (const mission of DEMO_MISSIONS) {
      const { id, ...missionData } = mission;
      const data = {
        ...missionData,
        userId: DEMO_IDS.observer,
        observatoryId: DEMO_IDS.observatory,
        telescopeId: DEMO_IDS.telescope,
      };
      await database.mission.upsert({
        where: { id },
        create: { id, ...data },
        update: data,
      });
    }

    const missionEvents = [
      [DEMO_MISSIONS[0].id, "PREPARING", "[DEMO] Simulator safety checks passed", "181"],
      [DEMO_MISSIONS[0].id, "CAPTURING", "[DEMO] Simulator created an image", "182"],
      [DEMO_MISSIONS[0].id, "COMPLETE", "[DEMO] Simulated mission completed", "183"],
      [DEMO_MISSIONS[1].id, "PREPARING", "[DEMO] Simulator safety checks passed", "184"],
      [DEMO_MISSIONS[1].id, "COMPLETE", "[DEMO] Simulated mission completed", "185"],
      [DEMO_MISSIONS[2].id, "PREPARING", "[DEMO] Simulator safety checks passed", "186"],
      [DEMO_MISSIONS[2].id, "COMPLETE", "[DEMO] Simulated mission completed", "187"],
      [DEMO_MISSIONS[3].id, "SCHEDULED", "[DEMO] Simulated mission scheduled", "188"],
      [DEMO_MISSIONS[4].id, "COMPLETE", "[DEMO] Shared mission completed", "189"],
    ] as const;

    for (const [missionId, state, message, suffix] of missionEvents) {
      const id = `00000000-0000-4000-8000-000000000${suffix}`;
      await database.missionEvent.upsert({
        where: { id },
        create: {
          id,
          missionId,
          state,
          source: "AGENT",
          message,
          simulated: true,
          isDemo: true,
        },
        update: {
          state,
          source: "AGENT",
          message,
          simulated: true,
          isDemo: true,
        },
      });
    }

    await database.booking.upsert({
      where: { id: DEMO_IDS.booking },
      create: {
        id: DEMO_IDS.booking,
        userId: DEMO_IDS.observer,
        targetId: PHASE1_TARGETS[0].id,
        observatoryId: DEMO_IDS.observatory,
        telescopeId: DEMO_IDS.telescope,
        missionId: DEMO_MISSIONS[3].id,
        slotStartAt: new Date("2026-09-01T18:30:00.000Z"),
        durationMinutes: 15,
        status: "CONFIRMED",
        priceMinor: 4500,
        currency: "GEL",
        isDemo: true,
      },
      update: { status: "CONFIRMED", isDemo: true },
    });

    await database.booking.upsert({
      where: { id: DEMO_IDS.privateBooking },
      create: {
        id: DEMO_IDS.privateBooking,
        userId: DEMO_IDS.observer,
        targetId: PHASE1_TARGETS[0].id,
        observatoryId: DEMO_IDS.observatory,
        telescopeId: DEMO_IDS.telescope,
        slotStartAt: new Date("2026-09-05T18:00:00.000Z"),
        durationMinutes: 60,
        status: "CONFIRMED",
        priceMinor: 18000,
        currency: "GEL",
        isDemo: true,
      },
      update: { status: "CONFIRMED", isDemo: true },
    });

    // Before #163 the demo captures had "CAP-DEMO-*" ids, which the contract's
    // `format: uuid` refuses. A database seeded then still holds them; their assets,
    // collection entries and access rows cascade with them.
    await database.capture.deleteMany({
      where: { id: { startsWith: "CAP-DEMO-" }, isDemo: true },
    });

    for (const capture of DEMO_CAPTURES) {
      const { id, thumbnailStorageKey, ...captureData } = capture;
      const data = {
        ...captureData,
        userId: DEMO_IDS.observer,
        observatoryId: DEMO_IDS.observatory,
        telescopeId: DEMO_IDS.telescope,
      };
      await database.capture.upsert({
        where: { id },
        create: { id, ...data },
        update: data,
      });
      await database.captureAsset.upsert({
        where: { captureId_kind: { captureId: id, kind: "THUMBNAIL" } },
        create: { captureId: id, kind: "THUMBNAIL", storageKey: thumbnailStorageKey },
        update: { storageKey: thumbnailStorageKey },
      });
    }

    // ADR-034: ADR-007 stands and presence is dropped, so the demo no longer seeds
    // a presence row or a shared-capture grant. Deleted by id rather than just no
    // longer written, so a development database seeded before #150 loses them too.
    await database.missionPresence.deleteMany({ where: { id: DEMO_IDS.livePresence } });
    await database.captureAccess.deleteMany({ where: { id: DEMO_IDS.liveCaptureAccess } });

    await database.missionParticipant.upsert({
      where: {
        missionId_userId: {
          missionId: DEMO_MISSIONS[4].id,
          userId: DEMO_IDS.viewer,
        },
      },
      create: {
        id: DEMO_IDS.liveParticipant,
        missionId: DEMO_MISSIONS[4].id,
        userId: DEMO_IDS.viewer,
        status: "LEFT",
        canSaveCaptures: false,
        leftAt: DEMO_MISSIONS[4].completedAt,
        isDemo: true,
      },
      update: {
        status: "LEFT",
        canSaveCaptures: false,
        leftAt: DEMO_MISSIONS[4].completedAt,
        isDemo: true,
      },
    });

    const collections = [
      {
        id: DEMO_IDS.collections.solarSystem,
        kind: "SOLAR_SYSTEM" as const,
        nameEn: "Solar System",
        nameKa: "მზის სისტემა",
        descriptionEn: "Planets and moons observed in demo missions.",
        descriptionKa: "სადემონსტრაციო მისიებში დაკვირვებული პლანეტები და მთვარეები.",
      },
      {
        id: DEMO_IDS.collections.messier,
        kind: "MESSIER_STARTER" as const,
        nameEn: "Messier Starter",
        nameKa: "მესიეს საწყისი კოლექცია",
        descriptionEn: "A demo introduction to Messier objects.",
        descriptionKa: "მესიეს ობიექტების სადემონსტრაციო საწყისი კოლექცია.",
      },
      {
        id: DEMO_IDS.collections.deepSky,
        kind: "DEEP_SKY" as const,
        nameEn: "Deep Sky",
        nameKa: "ღრმა ცა",
        descriptionEn: "Galaxies, nebulae, and clusters from demo missions.",
        descriptionKa: "სადემონსტრაციო მისიების გალაქტიკები, ნისლეულები და გროვები.",
      },
    ];

    for (const collection of collections) {
      const { id, ...collectionData } = collection;
      const data = { ...collectionData, userId: DEMO_IDS.observer, isDemo: true };
      await database.collection.upsert({
        where: { id },
        create: { id, ...data },
        update: data,
      });
    }

    const collectionCaptures = [
      [DEMO_IDS.collections.solarSystem, DEMO_CAPTURES[0].id],
      [DEMO_IDS.collections.messier, DEMO_CAPTURES[1].id],
      [DEMO_IDS.collections.messier, DEMO_CAPTURES[2].id],
      [DEMO_IDS.collections.deepSky, DEMO_CAPTURES[1].id],
      [DEMO_IDS.collections.deepSky, DEMO_CAPTURES[2].id],
    ] as const;

    for (const [collectionId, captureId] of collectionCaptures) {
      await database.collectionCapture.upsert({
        where: { collectionId_captureId: { collectionId, captureId } },
        create: { collectionId, captureId, isDemo: true },
        update: { isDemo: true },
      });
    }

    await database.subscription.upsert({
      where: { userId: DEMO_IDS.observer },
      create: {
        id: DEMO_IDS.subscription,
        userId: DEMO_IDS.observer,
        plan: "EXPLORER",
        status: "TRIALING",
        priceMinor: 0,
        startsAt: new Date("2026-08-01T00:00:00.000Z"),
        endsAt: new Date("2026-09-01T00:00:00.000Z"),
        isDemo: true,
      },
      update: { plan: "EXPLORER", status: "TRIALING", isDemo: true },
    });

    const ledgerEntries = [
      {
        id: "00000000-0000-4000-8000-000000000401",
        missionId: null,
        amount: 5,
        balanceAfter: 5,
        reason: "SUBSCRIPTION_GRANT" as const,
        idempotencyKey: "demo-subscription-grant-2026-08",
        note: "[DEMO] Explorer mission credit grant",
      },
      {
        id: "00000000-0000-4000-8000-000000000402",
        missionId: DEMO_MISSIONS[0].id,
        amount: -1,
        balanceAfter: 4,
        reason: "MISSION_DEBIT" as const,
        idempotencyKey: "demo-mission-debit-saturn",
        note: "[DEMO] Simulated Saturn mission",
      },
    ];

    for (const entry of ledgerEntries) {
      const { id, ...entryData } = entry;
      const data = { ...entryData, userId: DEMO_IDS.observer, isDemo: true };
      // Created once and never updated: CreditLedger is append-only (a trigger
      // refuses every UPDATE), so an upsert made the second seed run fail.
      const existing = await database.creditLedger.findUnique({
        where: { idempotencyKey: entry.idempotencyKey },
        select: { id: true },
      });
      if (!existing) await database.creditLedger.create({ data: { id, ...data } });
    }

    await database.privateSession.upsert({
      where: { id: DEMO_IDS.privateSession },
      create: {
        id: DEMO_IDS.privateSession,
        userId: DEMO_IDS.observer,
        observatoryId: DEMO_IDS.observatory,
        telescopeId: DEMO_IDS.telescope,
        bookingId: DEMO_IDS.privateBooking,
        durationMinutes: 60,
        startsAt: new Date("2026-09-05T18:00:00.000Z"),
        endsAt: new Date("2026-09-05T19:00:00.000Z"),
        status: "CONFIRMED",
        isDemo: true,
      },
      update: { status: "CONFIRMED", isDemo: true },
    });

    // The session this demo command was issued under. Revoked, because the mission
    // it belongs to is COMPLETE -- an active session on a finished mission would be
    // a state the orchestrator can never produce.
    const demoSessionId = "00000000-0000-4000-8000-000000000601";
    await database.missionSession.upsert({
      where: { id: demoSessionId },
      create: {
        id: demoSessionId,
        missionId: DEMO_MISSIONS[0].id,
        userId: DEMO_IDS.operator,
        issuedAt: new Date("2026-08-20T18:30:00.000Z"),
        expiresAt: new Date("2026-08-20T19:00:00.000Z"),
        revokedAt: new Date("2026-08-20T18:52:00.000Z"),
        revokedFor: "MISSION_COMPLETE",
        isDemo: true,
      },
      update: { revokedAt: new Date("2026-08-20T18:52:00.000Z"), isDemo: true },
    });

    // A real commandId: it is the agent's idempotency key and the agent parses it
    // as a UUID, so demo data may not demonstrate a shape that could never be sent.
    const commandId = "00000000-0000-4000-8000-000000000611";
    await database.observatoryCommand.upsert({
      where: { id: commandId },
      create: {
        id: commandId,
        missionId: DEMO_MISSIONS[0].id,
        sessionId: demoSessionId,
        userId: DEMO_IDS.operator,
        observatoryId: DEMO_IDS.observatory,
        type: "GOTO",
        status: "COMPLETED",
        issuedAt: new Date("2026-08-20T18:34:00.000Z"),
        expiresAt: new Date("2026-08-20T18:35:00.000Z"),
        relayedAt: new Date("2026-08-20T18:34:01.000Z"),
        completedAt: new Date("2026-08-20T18:35:00.000Z"),
        payload: { mode: "SIMULATOR", target: "DEMO-SATURN" },
        result: { accepted: true, simulated: true },
        simulated: true,
        isDemo: true,
      },
      update: {
        status: "COMPLETED",
        result: { accepted: true, simulated: true },
        simulated: true,
        isDemo: true,
      },
    });

    const auditLogs = [
      {
        id: "00000000-0000-4000-8000-000000000501",
        category: "AUTH" as const,
        action: "DEMO_USER_SEEDED",
        actorUserId: DEMO_IDS.observer,
        entityType: "User",
        entityId: DEMO_IDS.observer,
        commandId: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000502",
        category: "OBSERVATORY_MODE" as const,
        action: "SIMULATED_COMMAND_COMPLETED",
        actorUserId: DEMO_IDS.operator,
        entityType: "ObservatoryCommand",
        entityId: commandId,
        commandId,
      },
    ];

    for (const auditLog of auditLogs) {
      const { id, ...data } = auditLog;
      await database.auditLog.upsert({
        where: { id },
        create: { id, ...data, metadata: { demo: true }, isDemo: true },
        update: { ...data, metadata: { demo: true }, isDemo: true },
      });
    }

    console.info(
      `Development seed complete: ${PHASE1_TARGETS.length} catalogue targets, ` +
        "all observations marked demo and simulated.\n" +
        `Agent device token for the demo observatory: ${DEMO_AGENT_DEVICE_TOKEN}\n` +
        "Agent device token for the night-side demo observatory " +
        `(${DEMO_IDS.nightObservatory}, ${DEMO_NIGHT_SITE.latitude}, ` +
        `${DEMO_NIGHT_SITE.longitude}): ${DEMO_NIGHT_AGENT_DEVICE_TOKEN}\n` +
        `Demo accounts (password "${DEMO_ACCOUNT_PASSWORD}", development only): ` +
        Object.values(DEMO_ACCOUNT_EMAILS).join(", "),
    );
  } finally {
    await database.$disconnect();
  }
}

await seedDevelopmentDatabase();
