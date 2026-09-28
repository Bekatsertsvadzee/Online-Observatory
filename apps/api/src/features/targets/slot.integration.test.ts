import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { zSlotTargetList } from "@darkview/contracts/zod";
import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({ NODE_ENV: "test", APP_URL: "https://darkview.test" }),
}));

const { listSlotTargets } = await import("@/features/targets/slot");
const { reserveSlot } = await import("@/features/booking/reserve");
const { nightWindow } = await import("@/lib/slots/darkness");
const { generateSlots, SLOT_DURATION_MINUTES } = await import("@/lib/slots/generate");

/**
 * #151 -- which targets a slot can deliver, and the booking that refuses the rest.
 *
 * Against a real PostgreSQL instance: the claim is that the observatory's own site
 * and stored envelope, horizon mask included, decide the answer, and that the
 * refusal writes nothing.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

/** The seeded sites (`packages/db/prisma/development-seed.ts` and `seed.ts`). */
const TBILISI = { latitude: 41.7151, longitude: 44.8271, timezone: "Asia/Tbilisi" };
const MAUNA_KEA = { latitude: 19.8207, longitude: -155.4681, timezone: "Pacific/Honolulu" };

/** A December afternoon in Tbilisi, before that night's first slot. */
const NOW = new Date("2026-12-15T12:00:00.000Z");
const NIGHT = "2026-12-15";

/** FABRICATED for tests; MAX_ALT_SAFE is measured, and no real value exists yet. */
const FABRICATED_CLEARANCE_DEGREES = 65;

let database: PrismaClient;
let saturnId: string;
let jupiterId: string;

/**
 * That night's slots at Tbilisi, from the generator itself. Saturn is high in the
 * south at dusk and sets before midnight UTC; Jupiter rises late in the evening.
 */
function tbilisiSlot(which: "first" | "late"): Date {
  const window = nightWindow(NIGHT, TBILISI.timezone, {
    latitudeDegrees: TBILISI.latitude,
    longitudeDegrees: TBILISI.longitude,
  });
  if (!window) throw new Error("no darkness on the fixture night");

  const slots = generateSlots({
    observatoryId: randomUUID(),
    window,
    now: NOW,
    observatory: { online: true, weatherHold: false },
    bookedStartAt: new Set(),
  });
  const slot =
    which === "first"
      ? slots[0]
      : slots.find((candidate) => candidate.startAt >= "2026-12-15T23:00:00.000Z");
  if (!slot) throw new Error(`no ${which} slot on the fixture night`);
  return new Date(slot.startAt);
}

async function bookableObservatory(
  site: typeof TBILISI,
  horizonMask: { azimuthDegrees: number; minAltitudeDegrees: number }[] = [],
) {
  const observatory = await database.observatory.create({
    data: {
      slug: `test-${randomUUID()}`,
      nameEn: "Test",
      nameKa: "Test",
      city: "Test",
      countryCode: "GE",
      ...site,
      status: "ONLINE",
      mode: "SIMULATED",
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
      status: "ONLINE",
    },
  });
  const owner = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Owner" },
  });
  await database.observatoryNetworkNode.create({
    data: {
      ownerId: owner.id,
      observatoryId: observatory.id,
      primaryTelescopeId: telescope.id,
      kind: "FIRST_PARTY",
      approvalStatus: "APPROVED",
      capabilities: [],
      approvedAt: NOW,
    },
  });
  await database.safetyEnvelope.create({
    data: {
      observatoryId: observatory.id,
      minAltitudeDegrees: 15,
      maxAltitudeDegrees: FABRICATED_CLEARANCE_DEGREES,
      maxAltitudeMeasuredBy: "test fixture",
      sunExclusionDegrees: 30,
      daylightLockSunAltitudeDegrees: -6,
      nudgeMaxDegrees: 0.5,
      nudgeRateDegreesPerSecond: 0.5,
      slewTimeoutSeconds: 120,
      heartbeatLossSeconds: 15,
      linkDeadSeconds: 60,
      refocusTemperatureDeltaC: 2,
      horizonMask: { create: horizonMask },
    },
  });
  return observatory.id;
}

function planet(body: "SATURN" | "JUPITER", nameEn: string) {
  return database.target.create({
    data: {
      slug: `${nameEn.toLowerCase()}-${randomUUID()}`,
      nameEn,
      nameKa: nameEn,
      type: "PLANET",
      positionSource: "EPHEMERIS",
      solarSystemBody: body,
      angularSizeArcmin: 0.7,
      magnitude: 0.5,
      opticalConfig: "F20_BARLOW",
      imagingProfile: "PLANETARY",
      minAltitudeDegrees: 25,
      expectedMissionMinutes: 15,
    },
  });
}

async function customer() {
  const user = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Customer", emailVerifiedAt: NOW },
  });
  return user.id;
}

function book(observatoryId: string, userId: string, targetId: string, slotStartAt: Date) {
  return reserveSlot({
    userId,
    request: {
      observatoryId,
      targetId,
      slotStartAt: slotStartAt.toISOString(),
      durationMinutes: SLOT_DURATION_MINUTES,
    },
    idempotencyKey: null,
    now: NOW,
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
  // Every Restrict foreign key cleared before the row it points at, as the other
  // suites sharing this database do.
  await database.capture.deleteMany();
  await database.auditLog.deleteMany();
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

  saturnId = (await planet("SATURN", "Saturn")).id;
  jupiterId = (await planet("JUPITER", "Jupiter")).id;
});

function itemFor(list: Awaited<ReturnType<typeof listSlotTargets>>, targetId: string) {
  const item = list?.items.find((candidate) => candidate.target.id === targetId);
  if (!item) throw new Error(`${targetId} missing from the list`);
  return item.visibility;
}

describe("GET /targets/visibility: which targets a slot can deliver", () => {
  it("offers Saturn and not Jupiter in the first Tbilisi slot, and the reverse late", async () => {
    const tbilisi = await bookableObservatory(TBILISI);

    const early = await listSlotTargets(tbilisi, tbilisiSlot("first"), SLOT_DURATION_MINUTES);
    expect(itemFor(early, saturnId)).toMatchObject({ observable: true, blockReasons: [] });
    expect(itemFor(early, jupiterId)).toMatchObject({
      observable: false,
      blockReasons: ["BELOW_HORIZON"],
    });

    const late = await listSlotTargets(tbilisi, tbilisiSlot("late"), SLOT_DURATION_MINUTES);
    expect(itemFor(late, saturnId).observable).toBe(false);
    expect(itemFor(late, saturnId).blockReasons).toContain("BELOW_HORIZON");
    expect(itemFor(late, jupiterId).observable).toBe(true);
  });

  it("judges each observatory at its own site", async () => {
    const tbilisi = await bookableObservatory(TBILISI);
    const maunaKea = await bookableObservatory(MAUNA_KEA);
    const startAt = tbilisiSlot("first");

    const there = await listSlotTargets(maunaKea, startAt, SLOT_DURATION_MINUTES);

    // Dusk in Tbilisi is before dawn on Mauna Kea, with Saturn long set there.
    expect(itemFor(await listSlotTargets(tbilisi, startAt, SLOT_DURATION_MINUTES), saturnId).observable).toBe(true);
    expect(itemFor(there, saturnId).blockReasons).toContain("BELOW_HORIZON");
    expect(there?.observatoryId).toBe(maunaKea);
  });

  it("applies the observatory's stored horizon mask", async () => {
    // A wall across the south, where Saturn stands at dusk.
    const walled = await bookableObservatory(TBILISI, [
      { azimuthDegrees: 90, minAltitudeDegrees: 10 },
      { azimuthDegrees: 150, minAltitudeDegrees: 70 },
      { azimuthDegrees: 250, minAltitudeDegrees: 70 },
      { azimuthDegrees: 300, minAltitudeDegrees: 10 },
    ]);

    const list = await listSlotTargets(walled, tbilisiSlot("first"), SLOT_DURATION_MINUTES);

    expect(itemFor(list, saturnId)).toMatchObject({
      observable: false,
      blockReasons: ["BEHIND_HORIZON_MASK"],
    });
  });

  it("produces a list the contract's own schema accepts", async () => {
    const tbilisi = await bookableObservatory(TBILISI);

    const list = await listSlotTargets(tbilisi, tbilisiSlot("first"), SLOT_DURATION_MINUTES);

    expect(zSlotTargetList.safeParse(list).success).toBe(true);
    expect(list?.startAt).toBe(tbilisiSlot("first").toISOString());
  });

  it("answers nothing for an id that is not an observatory", async () => {
    expect(await listSlotTargets(randomUUID(), tbilisiSlot("first"), 30)).toBeNull();
  });
});

describe("POST /bookings refuses a target the slot cannot deliver", () => {
  it("refuses Jupiter before it has risen, with the reason, and holds nothing", async () => {
    const tbilisi = await bookableObservatory(TBILISI);
    const userId = await customer();

    const result = await book(tbilisi, userId, jupiterId, tbilisiSlot("first"));

    expect(result).toMatchObject({
      ok: false,
      status: 422,
      code: "TARGET_NOT_OBSERVABLE",
      details: { blockReasons: ["BELOW_HORIZON"] },
    });
    expect(await database.booking.count()).toBe(0);
    expect(await database.payment.count()).toBe(0);
  });

  it("refuses Saturn after it has set -- the case the request was raised for", async () => {
    const tbilisi = await bookableObservatory(TBILISI);

    const result = await book(tbilisi, await customer(), saturnId, tbilisiSlot("late"));

    expect(result).toMatchObject({ ok: false, status: 422, code: "TARGET_NOT_OBSERVABLE" });
    expect(await database.booking.count()).toBe(0);
  });

  it("refuses a target behind the stored horizon mask", async () => {
    const walled = await bookableObservatory(TBILISI, [
      { azimuthDegrees: 90, minAltitudeDegrees: 10 },
      { azimuthDegrees: 150, minAltitudeDegrees: 70 },
      { azimuthDegrees: 250, minAltitudeDegrees: 70 },
      { azimuthDegrees: 300, minAltitudeDegrees: 10 },
    ]);

    const result = await book(walled, await customer(), saturnId, tbilisiSlot("first"));

    expect(result).toMatchObject({
      ok: false,
      code: "TARGET_NOT_OBSERVABLE",
      details: { blockReasons: ["BEHIND_HORIZON_MASK"] },
    });
  });

  it("books what the list offers, so the two surfaces agree", async () => {
    const tbilisi = await bookableObservatory(TBILISI);
    const startAt = tbilisiSlot("first");
    const list = await listSlotTargets(tbilisi, startAt, SLOT_DURATION_MINUTES);
    expect(itemFor(list, saturnId).observable).toBe(true);

    const result = await book(tbilisi, await customer(), saturnId, startAt);

    expect(result.ok).toBe(true);
  });
});
