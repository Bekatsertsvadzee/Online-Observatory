export const DEMO_IDS = {
  observer: "00000000-0000-4000-8000-000000000001",
  operator: "00000000-0000-4000-8000-000000000002",
  viewer: "00000000-0000-4000-8000-000000000003",
  observatory: "00000000-0000-4000-8000-000000000010",
  telescope: "00000000-0000-4000-8000-000000000011",
  camera: "00000000-0000-4000-8000-000000000012",
  safetyEnvelope: "00000000-0000-4000-8000-000000000013",
  subscription: "00000000-0000-4000-8000-000000000020",
  booking: "00000000-0000-4000-8000-000000000021",
  privateBooking: "00000000-0000-4000-8000-000000000022",
  privateSession: "00000000-0000-4000-8000-000000000023",
  livePresence: "00000000-0000-4000-8000-000000000024",
  liveParticipant: "00000000-0000-4000-8000-000000000025",
  liveCaptureAccess: "00000000-0000-4000-8000-000000000026",
  networkNode: "00000000-0000-4000-8000-000000000027",
  collections: {
    solarSystem: "00000000-0000-4000-8000-000000000031",
    messier: "00000000-0000-4000-8000-000000000032",
    deepSky: "00000000-0000-4000-8000-000000000033",
  },
} as const;

/**
 * Device token for the demo observatory's agent link.
 *
 * Development only. seed.ts refuses to run unless NODE_ENV=development, and this
 * value is deliberately unmistakable so it can never be confused for a real one.
 * A production token is generated per observatory and stored in secret storage;
 * only its SHA-256 is ever written to the database.
 */
export const DEMO_AGENT_DEVICE_TOKEN = "DEMO-DEVICE-TOKEN-NOT-FOR-ANY-REAL-OBSERVATORY";

import { PHASE1_TARGETS } from "./phase1-catalogue";

export const DEMO_MISSIONS = [
  {
    id: "00000000-0000-4000-8000-000000000201",
    targetId: PHASE1_TARGETS[0].id,
    state: "COMPLETE",
    requestedAt: new Date("2026-08-20T18:30:00.000Z"),
    startedAt: new Date("2026-08-20T18:35:00.000Z"),
    completedAt: new Date("2026-08-20T18:58:00.000Z"),
    scheduledFor: null,
    sharingMode: "PRIVATE",
    joinPolicy: "DISABLED",
    allowSharedCaptures: false,
    mode: "SIMULATED",
    isDemo: true,
  },
  {
    id: "00000000-0000-4000-8000-000000000202",
    targetId: PHASE1_TARGETS[3].id,
    state: "COMPLETE",
    requestedAt: new Date("2026-08-18T19:00:00.000Z"),
    startedAt: new Date("2026-08-18T19:05:00.000Z"),
    completedAt: new Date("2026-08-18T19:34:00.000Z"),
    scheduledFor: null,
    sharingMode: "PRIVATE",
    joinPolicy: "DISABLED",
    allowSharedCaptures: false,
    mode: "SIMULATED",
    isDemo: true,
  },
  {
    id: "00000000-0000-4000-8000-000000000203",
    targetId: PHASE1_TARGETS[2].id,
    state: "COMPLETE",
    requestedAt: new Date("2026-08-12T18:45:00.000Z"),
    startedAt: new Date("2026-08-12T18:50:00.000Z"),
    completedAt: new Date("2026-08-12T19:24:00.000Z"),
    scheduledFor: null,
    sharingMode: "PRIVATE",
    joinPolicy: "DISABLED",
    allowSharedCaptures: false,
    mode: "SIMULATED",
    isDemo: true,
  },
  {
    id: "00000000-0000-4000-8000-000000000204",
    targetId: PHASE1_TARGETS[1].id,
    state: "SCHEDULED",
    requestedAt: new Date("2026-08-24T12:00:00.000Z"),
    scheduledFor: new Date("2026-09-01T18:30:00.000Z"),
    startedAt: null,
    completedAt: null,
    sharingMode: "PRIVATE",
    joinPolicy: "DISABLED",
    allowSharedCaptures: false,
    mode: "SIMULATED",
    isDemo: true,
  },
  {
    id: "00000000-0000-4000-8000-000000000205",
    targetId: PHASE1_TARGETS[0].id,
    state: "OBSERVING",
    requestedAt: new Date("2026-08-25T21:00:00.000Z"),
    scheduledFor: new Date("2026-08-25T21:30:00.000Z"),
    startedAt: new Date("2026-08-25T21:32:00.000Z"),
    completedAt: null,
    sharingMode: "PUBLIC",
    joinPolicy: "OPEN",
    allowSharedCaptures: true,
    mode: "SIMULATED",
    isDemo: true,
  },
] as const;

export const DEMO_CAPTURES = [
  {
    id: "CAP-DEMO-0001",
    imagingProfile: "PLANETARY",
    opticalConfig: "F20_BARLOW",
    exposureMilliseconds: 20,
    gain: 300,
    framesStacked: 900,
    integrationSeconds: 18,
    fitsAvailable: false,
    missionId: DEMO_MISSIONS[0].id,
    targetId: PHASE1_TARGETS[0].id,
    capturedAt: new Date("2026-08-20T18:52:00.000Z"),
    processingPreset: "NATURAL",
    thumbnailStorageKey: "/captures/saturn-dv-0001.svg",
    visibility: "PRIVATE",
    mode: "SIMULATED",
    isDemo: true,
  },
  {
    id: "CAP-DEMO-0002",
    imagingProfile: "PLANETARY_NEBULA",
    opticalConfig: "F6_3_REDUCER",
    exposureMilliseconds: 4000,
    gain: 300,
    framesStacked: 120,
    integrationSeconds: 480,
    fitsAvailable: false,
    missionId: DEMO_MISSIONS[1].id,
    targetId: PHASE1_TARGETS[3].id,
    capturedAt: new Date("2026-08-18T19:28:00.000Z"),
    processingPreset: "DETAIL",
    thumbnailStorageKey: "/captures/ring-nebula-dv-0002.svg",
    visibility: "GALLERY",
    mode: "SIMULATED",
    isDemo: true,
  },
  {
    id: "CAP-DEMO-0003",
    imagingProfile: "BRIGHT_NEBULA",
    opticalConfig: "F6_3_REDUCER",
    exposureMilliseconds: 3000,
    gain: 250,
    framesStacked: 150,
    integrationSeconds: 450,
    fitsAvailable: false,
    missionId: DEMO_MISSIONS[2].id,
    targetId: PHASE1_TARGETS[2].id,
    capturedAt: new Date("2026-08-12T19:17:00.000Z"),
    processingPreset: "BRIGHT",
    thumbnailStorageKey: "/captures/orion-nebula-dv-0003.svg",
    visibility: "GALLERY",
    mode: "SIMULATED",
    isDemo: true,
  },
  {
    id: "CAP-DEMO-LIVE-0001",
    imagingProfile: "PLANETARY",
    opticalConfig: "F20_BARLOW",
    exposureMilliseconds: 20,
    gain: 300,
    framesStacked: 450,
    integrationSeconds: 9,
    fitsAvailable: false,
    missionId: DEMO_MISSIONS[4].id,
    targetId: PHASE1_TARGETS[0].id,
    capturedAt: new Date("2026-08-25T21:44:00.000Z"),
    processingPreset: "NATURAL",
    thumbnailStorageKey: "/captures/saturn-dv-0001.svg",
    visibility: "GALLERY",
    mode: "SIMULATED",
    isDemo: true,
  },
] as const;

export function assertDevelopmentSeedData() {
  const rows = [...DEMO_MISSIONS, ...DEMO_CAPTURES];

  if (rows.some((row) => !row.isDemo)) {
    throw new Error("Development seed contains an unmarked record.");
  }

  if ([...DEMO_MISSIONS, ...DEMO_CAPTURES].some((row) => row.mode !== "SIMULATED")) {
    throw new Error("Development observations must always be simulated.");
  }

}
