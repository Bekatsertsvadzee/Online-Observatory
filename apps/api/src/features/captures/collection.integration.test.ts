import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

// Not a credential and cannot become one: the endpoint does not resolve and the
// key is not an account. These tests assert what a signed URL *names*, and none
// of them reaches a bucket.
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

const { listCaptures, getCapture } = await import("@/features/captures/collection");
const { getCaptureDownload } = await import("@/features/captures/download");
const { zCapture, zCapturePage } = await import("@darkview/contracts/zod");

/**
 * DV-061 -- the Collection, against a real PostgreSQL instance.
 *
 * The claim worth proving here is ownership, and it is not provable against a
 * fake: what stops one customer reading another's images is a WHERE clause, and a
 * WHERE clause is only real when a database applies it. The second claim is
 * ordering across a keyset boundary, which needs rows the query planner is free to
 * return in an order of its own choosing.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const NOW = new Date("2026-07-15T20:00:00.000Z");

let database: PrismaClient;
let observatoryId: string;
let telescopeId: string;
let targetId: string;
let missionId: string;
let ownerId: string;
let strangerId: string;

/** One capture, `minutesAgo` before NOW, owned by `userId`. */
async function addCapture(input: {
  userId: string;
  minutesAgo: number;
  framesStacked?: number;
  fits?: boolean;
  assets?: { kind: "IMAGE" | "FITS" | "THUMBNAIL" | "UNMARKED"; storageKey: string }[];
}) {
  const capture = await database.capture.create({
    data: {
      id: randomUUID(),
      userId: input.userId,
      missionId,
      targetId,
      observatoryId,
      telescopeId,
      capturedAt: new Date(NOW.getTime() - input.minutesAgo * 60_000),
      imagingProfile: "GLOBULAR_CLUSTER",
      opticalConfig: "F10_NATIVE",
      exposureMilliseconds: 4000,
      gain: 250,
      framesStacked: input.framesStacked ?? 40,
      integrationSeconds: 160,
      fitsAvailable: input.fits ?? false,
      processingPreset: "NATURAL",
      mode: "SIMULATED",
      ...(input.assets ? { assets: { create: input.assets } } : {}),
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
  // Captures first: Capture holds Restrict foreign keys to Mission, Target,
  // Telescope, Observatory and User.
  await database.capture.deleteMany();
  await database.auditLog.deleteMany();
  await database.missionEvent.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  // ObservatoryNetworkNode holds Restrict foreign keys to Observatory and User
  // (ADR-013), so a node left behind blocks every later suite's cleanup.
  await database.networkAvailabilityWindow.deleteMany();
  await database.observatoryNetworkNode.deleteMany();
  await database.safetyEnvelope.deleteMany();
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
  observatoryId = observatory.id;

  const telescope = await database.telescope.create({
    data: {
      observatoryId,
      name: "NexStar 6SE",
      manufacturer: "Celestron",
      model: "NexStar 6SE",
      apertureMm: 150,
      focalLengthMm: 1500,
    },
  });
  telescopeId = telescope.id;

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
  targetId = target.id;

  const owner = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Owner", emailVerifiedAt: NOW },
  });
  ownerId = owner.id;

  const stranger = await database.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      name: "Stranger",
      emailVerifiedAt: NOW,
    },
  });
  strangerId = stranger.id;

  const mission = await database.mission.create({
    data: { userId: ownerId, targetId, observatoryId, telescopeId, state: "OBSERVING" },
  });
  missionId = mission.id;
});

describe("whose Collection this is", () => {
  it("returns only the caller's captures", async () => {
    await addCapture({ userId: ownerId, minutesAgo: 10 });
    await addCapture({ userId: strangerId, minutesAgo: 5 });

    const page = await listCaptures({ userId: ownerId, limit: 20 });

    expect(page.items).toHaveLength(1);
    expect(page.items[0].userId).toBe(ownerId);
  });

  it("is empty for somebody who has taken none", async () => {
    await addCapture({ userId: ownerId, minutesAgo: 10 });

    const page = await listCaptures({ userId: strangerId, limit: 20 });

    expect(page.items).toEqual([]);
    expect(page.page).toEqual({ hasMore: false, nextCursor: null });
  });

  it("does not hand one customer another's capture by id", async () => {
    // Scoped in the query, not filtered afterwards. The route turns this null into
    // a 404, identical to the answer for an id that never existed.
    const theirs = await addCapture({ userId: strangerId, minutesAgo: 5 });

    expect(await getCapture({ userId: ownerId, captureId: theirs })).toBeNull();
    expect(await getCapture({ userId: strangerId, captureId: theirs })).not.toBeNull();
  });

  it("answers null for a capture id that is not an id at all", async () => {
    // Capture.id is text rather than a uuid column, so an arbitrary string reaches
    // the database and must come back as nothing rather than as an error.
    expect(await getCapture({ userId: ownerId, captureId: "not-an-id" })).toBeNull();
  });
});

describe("the order a customer reads it in", () => {
  it("puts the most recently taken first", async () => {
    const oldest = await addCapture({ userId: ownerId, minutesAgo: 90 });
    const newest = await addCapture({ userId: ownerId, minutesAgo: 5 });
    const middle = await addCapture({ userId: ownerId, minutesAgo: 40 });

    const page = await listCaptures({ userId: ownerId, limit: 20 });

    expect(page.items.map((capture) => capture.id)).toEqual([newest, middle, oldest]);
  });

  it("orders by when the shutter closed, not by when the cloud heard", async () => {
    // A capture the agent queued through an outage and delivered an hour later
    // belongs where it was taken in the customer's evening, not at the top of the
    // list above images from a later session. `createdAt` defaults to now() for
    // both of these, so only `capturedAt` can tell them apart.
    const earlier = await addCapture({ userId: ownerId, minutesAgo: 120 });
    const later = await addCapture({ userId: ownerId, minutesAgo: 10 });

    // Written second, taken first.
    const delayed = await addCapture({ userId: ownerId, minutesAgo: 200 });

    const page = await listCaptures({ userId: ownerId, limit: 20 });

    expect(page.items.map((capture) => capture.id)).toEqual([later, earlier, delayed]);
  });

  it("pages without repeating or skipping a capture", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      ids.push(await addCapture({ userId: ownerId, minutesAgo: index }));
    }

    const first = await listCaptures({ userId: ownerId, limit: 3 });
    expect(first.page.hasMore).toBe(true);

    const second = await listCaptures({
      userId: ownerId,
      limit: 3,
      cursor: first.page.nextCursor ?? undefined,
    });
    const third = await listCaptures({
      userId: ownerId,
      limit: 3,
      cursor: second.page.nextCursor ?? undefined,
    });

    const seen = [...first.items, ...second.items, ...third.items].map((c) => c.id);
    expect(seen).toEqual(ids);
    expect(new Set(seen).size).toBe(7);
    expect(third.page.hasMore).toBe(false);
    expect(third.page.nextCursor).toBeNull();
  });

  it("pages captures taken in the same instant without losing one", async () => {
    // A stacked sequence produces captures with identical capturedAt. Without the
    // id tiebreak the order is the planner's choice and a keyset cursor over it
    // skips rows.
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(await addCapture({ userId: ownerId, minutesAgo: 30 }));
    }

    const first = await listCaptures({ userId: ownerId, limit: 2 });
    const second = await listCaptures({
      userId: ownerId,
      limit: 2,
      cursor: first.page.nextCursor ?? undefined,
    });
    const third = await listCaptures({
      userId: ownerId,
      limit: 2,
      cursor: second.page.nextCursor ?? undefined,
    });

    const seen = [...first.items, ...second.items, ...third.items].map((c) => c.id);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...ids].sort());
  });
});

describe("what crosses the boundary", () => {
  it("is exactly what the contract declares", async () => {
    await addCapture({ userId: ownerId, minutesAgo: 5, fits: true });

    const page = await listCaptures({ userId: ownerId, limit: 20 });

    // strictObject: an extra property fails. This is what keeps observatoryId,
    // telescopeId, processingPreset, commandId and isDemo from leaking into a
    // customer response by being added to the select.
    expect(zCapturePage.safeParse(page).success).toBe(true);
    expect(zCapture.safeParse(page.items[0]).success).toBe(true);
  });

  it("carries no thumbnail URL yet", async () => {
    // A signed, short-expiry URL and nothing to sign against. Null is the
    // contract's own word for it; a fabricated path would be a broken image.
    await addCapture({ userId: ownerId, minutesAgo: 5 });

    const page = await listCaptures({ userId: ownerId, limit: 20 });

    expect(page.items[0].thumbnailUrl).toBeNull();
  });

  it("never presents simulator output as telescope output", async () => {
    await addCapture({ userId: ownerId, minutesAgo: 5 });

    const page = await listCaptures({ userId: ownerId, limit: 20 });

    expect(page.items[0].mode).toBe("SIMULATED");
  });
});

describe("the signed download of a capture", () => {
  const KEY = "captures/obs/mission/command/IMAGE";

  it("signs a URL naming that capture's own object", async () => {
    const captureId = await addCapture({
      userId: ownerId,
      minutesAgo: 1,
      assets: [{ kind: "IMAGE", storageKey: KEY }],
    });

    const result = await getCaptureDownload({
      userId: ownerId,
      captureId,
      kind: "IMAGE",
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const url = new URL(result.download.url);
    expect(url.pathname).toBe(`/${KEY}`);
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(result.download.expiresAt).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("will not sign somebody else's capture", async () => {
    // The whole access model. What stops one customer reaching another's image is
    // a WHERE clause, and a WHERE clause is only real when a database applies it.
    // A signed URL is a bearer credential for an object in a private bucket, so
    // minting one for the wrong caller is not a leaked row -- it is a leaked file.
    const captureId = await addCapture({
      userId: strangerId,
      minutesAgo: 1,
      assets: [{ kind: "IMAGE", storageKey: KEY }],
    });

    const result = await getCaptureDownload({
      userId: ownerId,
      captureId,
      kind: "IMAGE",
      now: NOW,
    });

    expect(result.ok).toBe(false);
  });

  it("answers 404 for an asset that was never written", async () => {
    // Most captures have no FITS. Asking for one is an ordinary miss, not an
    // error, and it must not be distinguishable from a capture that is not yours.
    const captureId = await addCapture({
      userId: ownerId,
      minutesAgo: 1,
      assets: [{ kind: "IMAGE", storageKey: KEY }],
    });

    const result = await getCaptureDownload({
      userId: ownerId,
      captureId,
      kind: "FITS",
      now: NOW,
    });

    expect(result.ok).toBe(false);
  });

  it("signs each asset of the same capture separately", async () => {
    const captureId = await addCapture({
      userId: ownerId,
      minutesAgo: 1,
      assets: [
        { kind: "IMAGE", storageKey: KEY },
        { kind: "FITS", storageKey: "captures/obs/mission/command/FITS" },
      ],
    });

    const image = await getCaptureDownload({ userId: ownerId, captureId, kind: "IMAGE", now: NOW });
    const fits = await getCaptureDownload({ userId: ownerId, captureId, kind: "FITS", now: NOW });

    expect(image.ok && fits.ok).toBe(true);
    if (!image.ok || !fits.ok) return;
    expect(new URL(image.download.url).pathname).toBe(`/${KEY}`);
    expect(new URL(fits.download.url).pathname).toBe("/captures/obs/mission/command/FITS");
  });
});
