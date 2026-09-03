import "dotenv/config";

import { createHash } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/prisma/client";
import {
  DEMO_AGENT_DEVICE_TOKEN,
  DEMO_CAPTURES,
  DEMO_IDS,
  DEMO_MISSIONS,
  DEMO_TARGETS,
  assertDevelopmentSeedData,
} from "./development-seed";

const DEMO_PASSWORD_HASH =
  "scrypt$65536$8$1$BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc$h0__krhRoWlhZbCHOc0Wf_46L_kywkY8G1KOWdN5y1Xv6tVPAhQik6YPo8pqo9zhXGfH-l8diHELfuJ3eL0yxw";

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
        email: "demo.observer@darkview.invalid",
        name: "[DEMO] Darkview Observer",
        role: "USER",
        emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
        isDemo: true,
      },
      update: {
        email: "demo.observer@darkview.invalid",
        name: "[DEMO] Darkview Observer",
        role: "USER",
        emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
        isDemo: true,
      },
    });

    await database.user.upsert({
      where: { id: DEMO_IDS.operator },
      create: {
        id: DEMO_IDS.operator,
        email: "demo.operator@darkview.invalid",
        name: "[DEMO] Simulator Operator",
        role: "OPERATOR",
        emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
        isDemo: true,
      },
      update: {
        email: "demo.operator@darkview.invalid",
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
        email: "demo.viewer@darkview.invalid",
        name: "[DEMO] Mission Viewer",
        role: "USER",
        emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
        isDemo: true,
      },
      update: {
        email: "demo.viewer@darkview.invalid",
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
          passwordHash: DEMO_PASSWORD_HASH,
          isDemo: true,
        },
        update: { passwordHash: DEMO_PASSWORD_HASH, isDemo: true },
      });
    }

    // Same algorithm the realtime service uses to verify the presented token.
    const demoDeviceTokenHash = createHash("sha256")
      .update(DEMO_AGENT_DEVICE_TOKEN, "utf8")
      .digest("base64url");

    await database.observatory.upsert({
      where: { id: DEMO_IDS.observatory },
      create: {
        id: DEMO_IDS.observatory,
        slug: "demo-tbilisi",
        nameEn: "[DEMO] Darkview Tbilisi Observatory",
        nameKa: "[დემო] Darkview თბილისის ობსერვატორია",
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
        nameEn: "[DEMO] Darkview Tbilisi Observatory",
        nameKa: "[დემო] Darkview თბილისის ობსერვატორია",
        status: "ONLINE",
        mode: "SIMULATED",
        deviceTokenHash: demoDeviceTokenHash,
        isDemo: true,
      },
    });

    // MAX_ALT_SAFE is MEASURED from the physical optical train (DV-034). It is null
    // here and must stay null until that measurement exists: while it is null the
    // system is UNMEASURED and both cloud and agent refuse every slew. A seeded
    // value would defeat the entire safety envelope, so the seed must never set one.
    await database.safetyEnvelope.upsert({
      where: { observatoryId: DEMO_IDS.observatory },
      create: {
        id: DEMO_IDS.safetyEnvelope,
        observatoryId: DEMO_IDS.observatory,
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
      update: { minAltitudeDegrees: 25 },
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

    for (const target of DEMO_TARGETS) {
      const { id, bestMonths, ...targetData } = target;
      const data = { ...targetData, bestMonths: [...bestMonths] };
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
      [DEMO_MISSIONS[4].id, "OBSERVING", "[DEMO] Shared mission is live", "189"],
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
        targetId: DEMO_TARGETS[0].id,
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
        targetId: DEMO_TARGETS[0].id,
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

    await database.missionPresence.upsert({
      where: {
        missionId_userId: {
          missionId: DEMO_MISSIONS[4].id,
          userId: DEMO_IDS.viewer,
        },
      },
      create: {
        id: DEMO_IDS.livePresence,
        missionId: DEMO_MISSIONS[4].id,
        userId: DEMO_IDS.viewer,
        lastSeenAt: new Date("2026-08-25T21:45:00.000Z"),
        isDemo: true,
      },
      update: { leftAt: null, isDemo: true },
    });

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
        status: "JOINED",
        canSaveCaptures: true,
        isDemo: true,
      },
      update: {
        status: "JOINED",
        canSaveCaptures: true,
        leftAt: null,
        isDemo: true,
      },
    });

    await database.captureAccess.upsert({
      where: {
        captureId_userId: {
          captureId: DEMO_CAPTURES[3].id,
          userId: DEMO_IDS.viewer,
        },
      },
      create: {
        id: DEMO_IDS.liveCaptureAccess,
        captureId: DEMO_CAPTURES[3].id,
        missionId: DEMO_MISSIONS[4].id,
        userId: DEMO_IDS.viewer,
        status: "AVAILABLE",
        isDemo: true,
      },
      update: { status: "AVAILABLE", savedAt: null, isDemo: true },
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
      await database.creditLedger.upsert({
        where: { idempotencyKey: entry.idempotencyKey },
        create: { id, ...data },
        update: data,
      });
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

    const commandId = "CMD-DEMO-START-SATURN";
    await database.observatoryCommand.upsert({
      where: { id: commandId },
      create: {
        id: commandId,
        missionId: DEMO_MISSIONS[0].id,
        userId: DEMO_IDS.operator,
        observatoryId: DEMO_IDS.observatory,
        operation: "START_MISSION",
        status: "COMPLETED",
        issuedAt: new Date("2026-08-20T18:34:00.000Z"),
        expiresAt: new Date("2026-08-20T18:35:00.000Z"),
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
      "Development seed complete: all observations are marked demo and simulated.\n" +
        `Agent device token for the demo observatory: ${DEMO_AGENT_DEVICE_TOKEN}`,
    );
  } finally {
    await database.$disconnect();
  }
}

await seedDevelopmentDatabase();
