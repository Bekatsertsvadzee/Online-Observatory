import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase, removed, failRemoval } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
  removed: [] as string[],
  failRemoval: { next: false },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({
    APP_URL: "https://darkview.test",
    AUTH_SECRET: "integration-test-secret-integration-test-secret",
    TRUSTED_PROXY_HOPS: 0,
  }),
}));
vi.mock("@/lib/storage/configuration", () => ({ getStorage: () => ({}) }));
vi.mock("@darkview/storage/objects", () => ({
  deleteObject: async (_storage: unknown, key: string) => {
    if (failRemoval.next) {
      failRemoval.next = false;
      throw new Error("storage unreachable");
    }
    removed.push(key);
  },
}));

const { deleteAccount, deletedEmail, DELETED_NAME } =
  await import("@/features/auth/deletion");
const { getMissionWatchView } = await import("@/features/missions/watch");
const { hashPassword } = await import("@/lib/auth/password");

/**
 * ADR-044 against a real PostgreSQL instance: the account is anonymised in place, its
 * captures and everything personal go, its bookings and payments stay, and nothing is
 * touched while something is still owed either way.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const PASSWORD = "a correct horse battery";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const HOUR = 3_600_000;

let database: PrismaClient;
let passwordHash: string;
let fixture: { observatoryId: string; telescopeId: string; targetId: string };

async function customer(role: "USER" | "OPERATOR" = "USER") {
  const user = await database.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      name: "Nino",
      role,
      emailVerifiedAt: NOW,
      account: { create: { passwordHash } },
      sessions: {
        create: {
          tokenHash: randomUUID(),
          csrfTokenHash: randomUUID(),
          expiresAt: new Date(NOW.getTime() + 24 * HOUR),
        },
      },
    },
  });
  const session = {
    id: randomUUID(),
    expiresAt: new Date(NOW.getTime() + HOUR),
    csrfToken: "csrf",
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      locale: user.locale,
      createdAt: user.createdAt,
    },
  };
  return { userId: user.id, email: user.email, session };
}

async function mission(userId: string, state: "COMPLETE" | "OBSERVING" | "WEATHER_HOLD") {
  return database.mission.create({ data: { userId, ...fixture, state } });
}

async function booking(
  userId: string,
  options: {
    status: "CONFIRMED" | "PENDING_PAYMENT";
    startsIn: number;
    missionId?: string;
    holdExpiresAt?: Date;
  },
) {
  const payment = await database.payment.create({
    data: {
      userId,
      provider: "SANDBOX",
      status: options.status === "CONFIRMED" ? "CAPTURED" : "PENDING",
      amountMinor: 4500,
    },
  });
  // Its own observatory: the exclusion constraint refuses two live bookings that
  // overlap at one observatory, whichever test made them.
  const site = await place();
  return database.booking.create({
    data: {
      userId,
      ...fixture,
      ...site,
      paymentId: payment.id,
      missionId: options.missionId,
      slotStartAt: new Date(NOW.getTime() + options.startsIn),
      durationMinutes: 30,
      status: options.status,
      holdExpiresAt:
        options.status === "PENDING_PAYMENT"
          ? (options.holdExpiresAt ?? new Date(NOW.getTime() + 15 * 60_000))
          : null,
      priceMinor: 4500,
    },
  });
}

async function capture(userId: string, missionId: string) {
  const id = randomUUID();
  await database.capture.create({
    data: {
      id,
      userId,
      missionId,
      ...fixture,
      capturedAt: new Date(NOW.getTime() - 48 * HOUR),
      imagingProfile: "GLOBULAR_CLUSTER",
      opticalConfig: "F10_NATIVE",
      exposureMilliseconds: 4000,
      gain: 250,
      framesStacked: 40,
      integrationSeconds: 160,
      processingPreset: "NATURAL",
      assets: {
        create: [
          { kind: "IMAGE", storageKey: `captures/${id}/image` },
          { kind: "THUMBNAIL", storageKey: `captures/${id}/thumbnail` },
        ],
      },
    },
  });
  const collection = await database.collection.create({
    data: {
      userId,
      kind: "CUSTOM",
      nameEn: "Mine",
      nameKa: "ჩემი",
      descriptionEn: "",
      descriptionKa: "",
    },
  });
  await database.collectionCapture.create({
    data: { collectionId: collection.id, captureId: id },
  });
  return id;
}

async function place() {
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
  return { observatoryId: observatory.id, telescopeId: telescope.id };
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING }),
  });
  testDatabase.current = database;
  passwordHash = await hashPassword(PASSWORD);

  const site = await place();
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
  fixture = { ...site, targetId: target.id };
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(() => {
  removed.length = 0;
  failRemoval.next = false;
});

describe("deleting an account", () => {
  it("anonymises the account, deletes its captures and keeps its bookings and payments", async () => {
    const { userId, email, session } = await customer();
    const past = await mission(userId, "COMPLETE");
    const paid = await booking(userId, {
      status: "CONFIRMED",
      startsIn: -48 * HOUR,
      missionId: past.id,
    });
    const captureId = await capture(userId, past.id);

    await expect(
      deleteAccount(session, { currentPassword: PASSWORD }, NOW),
    ).resolves.toEqual({
      ok: true,
    });

    const user = await database.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user).toMatchObject({
      name: DELETED_NAME,
      email: deletedEmail(userId),
      emailVerifiedAt: null,
      deletedAt: NOW,
    });
    expect(await database.user.findUnique({ where: { email } })).toBeNull();
    expect(await database.account.count({ where: { userId } })).toBe(0);
    expect(await database.session.count({ where: { userId } })).toBe(0);
    expect(await database.capture.count({ where: { id: captureId } })).toBe(0);
    expect(await database.captureAsset.count({ where: { captureId } })).toBe(0);
    expect(await database.collection.count({ where: { userId } })).toBe(0);
    expect(removed.sort()).toEqual([
      `captures/${captureId}/image`,
      `captures/${captureId}/thumbnail`,
    ]);

    expect(await database.booking.findUnique({ where: { id: paid.id } })).not.toBeNull();
    expect(await database.payment.count({ where: { userId } })).toBe(1);
    expect(
      await database.auditLog.findFirst({
        where: { actorUserId: userId, action: "ACCOUNT_DELETED" },
        select: { actorHash: true, metadata: true },
      }),
    ).toEqual({ actorHash: null, metadata: null });
  });

  it("frees the address for a new registration", async () => {
    const { userId, email, session } = await customer();
    await deleteAccount(session, { currentPassword: PASSWORD }, NOW);

    const again = await database.user.create({ data: { email, name: "Nino again" } });
    expect(again.id).not.toBe(userId);
  });

  it("stops sharing the account's observations", async () => {
    const { userId, session } = await customer();
    const past = await mission(userId, "COMPLETE");
    expect(
      await getMissionWatchView({ missionId: past.id, actorId: userId }),
    ).not.toBeNull();

    await deleteAccount(session, { currentPassword: PASSWORD }, NOW);

    expect(await getMissionWatchView({ missionId: past.id, actorId: userId })).toBeNull();
  });

  it("still deletes when an object cannot be removed, and leaves it to the orphan sweep", async () => {
    const { userId, session } = await customer();
    const past = await mission(userId, "COMPLETE");
    await capture(userId, past.id);
    failRemoval.next = true;

    await expect(
      deleteAccount(session, { currentPassword: PASSWORD }, NOW),
    ).resolves.toEqual({
      ok: true,
    });
    expect(await database.capture.count({ where: { userId } })).toBe(0);
    expect(removed).toHaveLength(1);
  });

  it("refuses a wrong password and changes nothing", async () => {
    const { userId, email, session } = await customer();

    await expect(
      deleteAccount(session, { currentPassword: "not the password" }, NOW),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      details: { fields: ["currentPassword"] },
    });
    const user = await database.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user).toMatchObject({ email, deletedAt: null });
    expect(await database.session.count({ where: { userId } })).toBe(1);
  });
});

describe("what has to be settled first", () => {
  async function refusal(session: Awaited<ReturnType<typeof customer>>["session"]) {
    const result = await deleteAccount(session, { currentPassword: PASSWORD }, NOW);
    expect(result).toMatchObject({ ok: false, status: 409, code: "CONFLICT" });
    return (result as unknown as { details: { blockers: string[] } }).details.blockers;
  }

  it("names a live mission and a paid slot still ahead, and deletes nothing", async () => {
    const { userId, session } = await customer();
    await mission(userId, "OBSERVING");
    await booking(userId, { status: "CONFIRMED", startsIn: 24 * HOUR });

    expect(await refusal(session)).toEqual(["LIVE_MISSION", "UPCOMING_BOOKING"]);
    const user = await database.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.deletedAt).toBeNull();
    expect(await database.account.count({ where: { userId } })).toBe(1);
  });

  it("names a slot held awaiting payment, but not a hold that has lapsed", async () => {
    const held = await customer();
    await booking(held.userId, { status: "PENDING_PAYMENT", startsIn: 24 * HOUR });
    expect(await refusal(held.session)).toEqual(["HELD_BOOKING"]);

    const lapsed = await customer();
    await booking(lapsed.userId, {
      status: "PENDING_PAYMENT",
      startsIn: 24 * HOUR,
      holdExpiresAt: new Date(NOW.getTime() - 60_000),
    });
    await expect(
      deleteAccount(lapsed.session, { currentPassword: PASSWORD }, NOW),
    ).resolves.toEqual({ ok: true });
  });

  it("names a hold only while its slot lasts", async () => {
    const waiting = await customer();
    const live = await mission(waiting.userId, "WEATHER_HOLD");
    await booking(waiting.userId, {
      status: "CONFIRMED",
      startsIn: -10 * 60_000,
      missionId: live.id,
    });
    expect(await refusal(waiting.session)).toEqual(["LIVE_MISSION", "UPCOMING_BOOKING"]);

    const over = await customer();
    const ended = await mission(over.userId, "WEATHER_HOLD");
    await booking(over.userId, {
      status: "CONFIRMED",
      startsIn: -2 * HOUR,
      missionId: ended.id,
    });
    await expect(
      deleteAccount(over.session, { currentPassword: PASSWORD }, NOW),
    ).resolves.toEqual({ ok: true });
  });

  it("names a refund or free slot that is owed", async () => {
    const { userId, session } = await customer();
    const lost = await booking(userId, { status: "CONFIRMED", startsIn: -48 * HOUR });
    await database.bookingEntitlement.create({
      data: {
        bookingId: lost.id,
        userId,
        outcome: "OPEN",
        cause: "WEATHER",
        minutesLost: 30,
        evaluatedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30 * 24 * HOUR),
      },
    });

    expect(await refusal(session)).toEqual(["OPEN_ENTITLEMENT"]);
  });

  it("names an operator account", async () => {
    const { session } = await customer("OPERATOR");
    expect(await refusal(session)).toEqual(["OPERATOR"]);
  });
});
