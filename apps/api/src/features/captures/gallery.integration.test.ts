import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase, requestState } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
  requestState: { userId: null as string | null },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ origin: "https://darkview.test" }),
}));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({
    APP_URL: "https://darkview.test",
    AUTH_SECRET: "a-test-secret-that-keys-rate-limit-buckets-only",
  }),
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentSession: async () =>
    requestState.userId
      ? {
          id: "session",
          expiresAt: new Date("2027-01-01T00:00:00.000Z"),
          csrfToken: "csrf",
          user: {
            id: requestState.userId,
            email: "someone@example.test",
            name: "Someone",
            role: "USER",
            locale: "en",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        }
      : null,
}));
vi.mock("@/lib/storage/configuration", () => ({
  getStorage: () => ({
    S3_ENDPOINT: "https://s3.example.test",
    S3_REGION: "eu-central-1",
    S3_BUCKET: "darkview-test",
    S3_ACCESS_KEY_ID: "AKIATESTTESTTESTTEST",
    S3_SECRET_ACCESS_KEY: "a-test-secret-that-signs-nothing-real",
    S3_FORCE_PATH_STYLE: false,
  }),
}));

const { GET } = await import("@/app/gallery/[captureId]/route");
const { zGalleryCapture } = await import("@darkview/contracts/zod");

/**
 * Phase 6.3, clients ADR-065 -- GET /gallery/{captureId} against a real PostgreSQL,
 * through the route: no session at all, and only a REAL GALLERY capture with an image
 * is ever answered.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

let database: PrismaClient;
let ownerId: string;
let observerId: string;
let missionId: string;
let fixture: { observatoryId: string; telescopeId: string; targetId: string };

async function addCapture(
  mode: "REAL" | "SIMULATED",
  visibility: "PRIVATE" | "GALLERY" = "PRIVATE",
) {
  const capture = await database.capture.create({
    data: {
      id: randomUUID(),
      userId: ownerId,
      missionId,
      ...fixture,
      capturedAt: new Date("2026-07-15T20:00:00.000Z"),
      imagingProfile: "GLOBULAR_CLUSTER",
      opticalConfig: "F10_NATIVE",
      exposureMilliseconds: 4000,
      gain: 250,
      framesStacked: 40,
      integrationSeconds: 160,
      processingPreset: "NATURAL",
      mode,
      visibility,
    },
  });
  return capture.id;
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING }),
  });
  testDatabase.current = database;
  await database.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(async () => {
  await database.capture.deleteMany();
  await database.auditLog.deleteMany();
  await database.rateLimitBucket.deleteMany();
  await database.missionEvent.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  await database.networkAvailabilityWindow.deleteMany();
  await database.observatoryNetworkNode.deleteMany();
  await database.safetyEnvelope.deleteMany();
  await database.observerPack.deleteMany();
  await database.booking.deleteMany();
  await database.mission.deleteMany();
  await database.payment.deleteMany();
  await database.telescope.deleteMany();
  await database.target.deleteMany();
  await database.weatherState.deleteMany();
  await database.observatory.deleteMany();
  await database.user.deleteMany();

  const observatory = await database.observatory.create({
    data: {
      slug: `test-${randomUUID()}`,
      nameEn: "Test Observatory",
      nameKa: "სატესტო ობსერვატორია",
      city: "Tbilisi",
      countryCode: "GE",
      latitude: 41.7151,
      longitude: 44.8271,
      timezone: "Asia/Tbilisi",
      status: "ONLINE",
    },
  });
  const telescope = await database.telescope.create({
    data: {
      observatoryId: observatory.id,
      name: "NexStar 8SE",
      manufacturer: "Celestron",
      model: "NexStar 8SE",
      apertureMm: 203,
      focalLengthMm: 2032,
    },
  });
  const target = await database.target.create({
    data: {
      slug: `m13-${randomUUID()}`,
      nameEn: "M13",
      nameKa: "M13",
      type: "GLOBULAR_CLUSTER",
      positionSource: "FIXED",
      rightAscensionHours: 16.6949,
      declinationDegrees: 36.4613,
      angularSizeArcmin: 20,
      magnitude: 5.8,
      opticalConfig: "F10_NATIVE",
      imagingProfile: "GLOBULAR_CLUSTER",
      minAltitudeDegrees: 25,
      expectedMissionMinutes: 30,
    },
  });
  fixture = {
    observatoryId: observatory.id,
    telescopeId: telescope.id,
    targetId: target.id,
  };

  const user = (name: string) =>
    database.user.create({ data: { email: `${randomUUID()}@example.test`, name } });
  ownerId = (await user("Owner")).id;
  observerId = (await user("Observer")).id;

  const mission = await database.mission.create({
    data: { userId: ownerId, ...fixture, state: "OBSERVING" },
  });
  missionId = mission.id;

  // ADR-007: an observer with a paid seat on the very mission that took the capture.
  const payment = await database.payment.create({
    data: {
      userId: observerId,
      purpose: "OBSERVER_PACK",
      provider: "SANDBOX",
      status: "CAPTURED",
      amountMinor: 1000,
      capturedAt: new Date(),
    },
  });
  await database.observerPack.create({
    data: {
      missionId,
      userId: observerId,
      paymentId: payment.id,
      status: "PAID",
      paidAt: new Date(),
      priceMinor: 1000,
    },
  });
});

async function withImage(captureId: string) {
  await database.captureAsset.create({
    data: {
      captureId,
      kind: "IMAGE",
      storageKey: `captures/${captureId}/image.jpg`,
      byteSize: 1000,
      contentType: "image/jpeg",
    },
  });
  return captureId;
}

function get(captureId: string) {
  return GET(new Request(`https://darkview.test/api/gallery/${captureId}`), {
    params: Promise.resolve({ captureId }),
  });
}

describe("GET /gallery/{captureId}", () => {
  it("answers a published REAL capture to anyone, signed, naming the sky and never the person", async () => {
    const captureId = await withImage(await addCapture("REAL", "GALLERY"));

    const response = await get(captureId);
    expect(response.status).toBe(200);
    const raw = await response.json();
    const body = zGalleryCapture.parse(raw);

    expect(body).toMatchObject({
      id: captureId,
      target: { nameEn: "M13", type: "GLOBULAR_CLUSTER" },
      place: { city: "Tbilisi", countryCode: "GE", timezone: "Asia/Tbilisi" },
      telescope: { apertureMm: 203, focalLengthMm: 2032 },
      framesStacked: 40,
      mode: "REAL",
    });
    expect(body.imageUrl).toContain(`captures/${captureId}/image.jpg`);
    expect(body.imageUrl).toContain("X-Amz-Signature=");
    const text = JSON.stringify(raw);
    for (const leak of [
      ownerId,
      missionId,
      "Owner",
      "Celestron",
      "NexStar",
      "@example.test",
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it("is one 404 for private, simulated, imageless, deleted and unknown", async () => {
    const privateOne = await withImage(await addCapture("REAL", "PRIVATE"));
    const simulated = await withImage(await addCapture("SIMULATED", "GALLERY"));
    const imageless = await addCapture("REAL", "GALLERY");
    const deleted = await withImage(await addCapture("REAL", "GALLERY"));
    await database.captureAsset.deleteMany({ where: { captureId: deleted } });
    await database.capture.delete({ where: { id: deleted } });

    for (const captureId of [
      privateOne,
      simulated,
      imageless,
      deleted,
      randomUUID(),
      "not-an-id",
    ]) {
      const response = await get(captureId);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("stops answering the moment the owner makes it private", async () => {
    const captureId = await withImage(await addCapture("REAL", "GALLERY"));
    expect((await get(captureId)).status).toBe(200);

    await database.capture.update({
      where: { id: captureId },
      data: { visibility: "PRIVATE" },
    });
    expect((await get(captureId)).status).toBe(404);
  });
});
