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

const { PATCH } = await import("@/app/captures/[captureId]/route");
const { zCapture } = await import("@darkview/contracts/zod");

/**
 * #144 -- PATCH /captures/{captureId} against a real PostgreSQL instance, through
 * the route: the session and Origin checks, the ownership WHERE clause, the
 * conditional update and the audit row are each only real when they run.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

let database: PrismaClient;
let ownerId: string;
let strangerId: string;
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

function patchAs(userId: string | null, captureId: string, body: unknown) {
  requestState.userId = userId;
  return PATCH(
    new Request(`https://darkview.test/api/captures/${captureId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ captureId }) },
  );
}

async function visibilityOf(captureId: string) {
  const row = await database.capture.findUniqueOrThrow({ where: { id: captureId } });
  return row.visibility;
}

function visibilityAudits(captureId: string) {
  return database.auditLog.findMany({
    where: { action: "CAPTURE_VISIBILITY_CHANGED", entityId: captureId },
    orderBy: { createdAt: "asc" },
  });
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
      name: "NexStar 6SE",
      manufacturer: "Celestron",
      model: "NexStar 6SE",
      apertureMm: 150,
      focalLengthMm: 1500,
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
  strangerId = (await user("Stranger")).id;
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

describe("PATCH /captures/{captureId}", () => {
  it("lets the owner publish a REAL capture and take it back, auditing each change", async () => {
    const captureId = await addCapture("REAL");

    const published = await patchAs(ownerId, captureId, { visibility: "GALLERY" });
    expect(published.status).toBe(200);
    const body = zCapture.parse(await published.json());
    expect(body).toMatchObject({ id: captureId, visibility: "GALLERY", mode: "REAL" });
    expect(await visibilityOf(captureId)).toBe("GALLERY");

    const withdrawn = await patchAs(ownerId, captureId, { visibility: "PRIVATE" });
    expect(withdrawn.status).toBe(200);
    expect((await withdrawn.json()).visibility).toBe("PRIVATE");
    expect(await visibilityOf(captureId)).toBe("PRIVATE");

    const audits = await visibilityAudits(captureId);
    expect(audits.map((row) => row.metadata)).toEqual([
      { from: "PRIVATE", to: "GALLERY" },
      { from: "GALLERY", to: "PRIVATE" },
    ]);
    expect(audits.every((row) => row.category === "MISSION")).toBe(true);
    expect(audits.every((row) => row.actorUserId === ownerId)).toBe(true);
    expect(audits.every((row) => row.missionId === missionId)).toBe(true);
  });

  it("is idempotent: the visibility it already has answers 200 and writes nothing", async () => {
    const captureId = await addCapture("REAL");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await patchAs(ownerId, captureId, { visibility: "GALLERY" });
      expect(response.status).toBe(200);
      expect((await response.json()).visibility).toBe("GALLERY");
    }

    expect(await visibilityAudits(captureId)).toHaveLength(1);
  });

  it("writes one change and one audit row when two requests race", async () => {
    const captureId = await addCapture("REAL");

    const responses = await Promise.all([
      patchAs(ownerId, captureId, { visibility: "GALLERY" }),
      patchAs(ownerId, captureId, { visibility: "GALLERY" }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await visibilityAudits(captureId)).toHaveLength(1);
  });

  it("answers 404 to another customer, identically to a capture that does not exist", async () => {
    const captureId = await addCapture("REAL");

    const theirs = await patchAs(strangerId, captureId, { visibility: "GALLERY" });
    const missing = await patchAs(strangerId, randomUUID(), { visibility: "GALLERY" });

    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await theirs.json()).toEqual(await missing.json());
    expect(await visibilityOf(captureId)).toBe("PRIVATE");
    expect(await visibilityAudits(captureId)).toHaveLength(0);
  });

  it("answers 404 to an observer of the capture's own mission (ADR-007)", async () => {
    const captureId = await addCapture("REAL", "GALLERY");

    for (const visibility of ["PRIVATE", "GALLERY"]) {
      expect((await patchAs(observerId, captureId, { visibility })).status).toBe(404);
    }
    expect(await visibilityOf(captureId)).toBe("GALLERY");
  });

  it("answers 401 without a session and changes nothing", async () => {
    const captureId = await addCapture("REAL");

    expect((await patchAs(null, captureId, { visibility: "GALLERY" })).status).toBe(401);
    expect(await visibilityOf(captureId)).toBe("PRIVATE");
  });

  it("answers 422 for a visibility the contract does not name", async () => {
    const captureId = await addCapture("REAL");

    const response = await patchAs(ownerId, captureId, { visibility: "PUBLIC" });

    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("VALIDATION_FAILED");
    expect(await visibilityOf(captureId)).toBe("PRIVATE");
  });

  it("refuses to publish a SIMULATED capture with 409, and writes nothing", async () => {
    const captureId = await addCapture("SIMULATED");

    const response = await patchAs(ownerId, captureId, { visibility: "GALLERY" });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("CONFLICT");
    expect(await visibilityOf(captureId)).toBe("PRIVATE");
    expect(await visibilityAudits(captureId)).toHaveLength(0);
  });

  it("always lets the owner take a SIMULATED capture out of the gallery", async () => {
    const captureId = await addCapture("SIMULATED", "GALLERY");

    const response = await patchAs(ownerId, captureId, { visibility: "PRIVATE" });

    expect(response.status).toBe(200);
    expect(await visibilityOf(captureId)).toBe("PRIVATE");
    expect(await visibilityAudits(captureId)).toHaveLength(1);
  });
});
