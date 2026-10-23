import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { zSlotList, zWaitlistEntry, zWaitlistEntryList } from "@darkview/contracts/zod";
import { PrismaClient } from "@darkview/db";
import { sweepWaitlist, WAITLIST_OFFER_MINUTES } from "@darkview/db/waitlist";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({
    NODE_ENV: process.env.NODE_ENV ?? "test",
    APP_URL: "https://darkview.test",
    VIEWING_CONDITIONS_MAX_AGE_MINUTES: 180,
  }),
}));

const { reserveSlot } = await import("@/features/booking/reserve");
const { listSlotsForDate } = await import("@/features/booking/slots");
const { joinWaitlist, leaveWaitlist, listMyWaitlistEntries } = await import(
  "@/features/waitlist/waitlist"
);
const { nightWindow } = await import("@/lib/slots/darkness");
const { generateSlots, SLOT_DURATION_MINUTES } = await import("@/lib/slots/generate");

/**
 * Clients ADR-068 against a real PostgreSQL instance: joining and leaving, the sweep
 * that offers a freed slot in order and moves on when an offer lapses, the hold an
 * offer puts on the slot, and the forecast every slot carries.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const SITE = { latitude: 41.7151, longitude: 44.8271, timezone: "Asia/Tbilisi" };
/** A winter afternoon in Tbilisi: every slot that night is still ahead. */
const NOW = new Date("2026-12-15T12:00:00.000Z");
const NIGHT = "2026-12-15";
const MINUTE = 60_000;

let database: PrismaClient;
let observatoryId: string;
let holderId: string;
let firstId: string;
let secondId: string;

function slotStartAt(index: number): Date {
  const window = nightWindow(NIGHT, SITE.timezone, {
    latitudeDegrees: SITE.latitude,
    longitudeDegrees: SITE.longitude,
  })!;
  const slots = generateSlots({
    observatoryId,
    window,
    now: NOW,
    observatory: { online: true, weatherHold: false },
    held: [],
  }).filter((slot) => slot.available);
  return new Date(slots[index * 3].startAt);
}

async function createUser(name: string) {
  const user = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name, emailVerifiedAt: NOW },
  });
  return user.id;
}

function reserve(userId: string, slot = 0, now = NOW) {
  return reserveSlot({
    userId,
    request: {
      observatoryId,
      slotStartAt: slotStartAt(slot).toISOString(),
      durationMinutes: SLOT_DURATION_MINUTES,
    },
    idempotencyKey: null,
    now,
  });
}

function join(userId: string, slot = 0, now = NOW) {
  return joinWaitlist({
    userId,
    request: {
      observatoryId,
      slotStartAt: slotStartAt(slot).toISOString(),
      durationMinutes: SLOT_DURATION_MINUTES,
    },
    now,
  });
}

/** The holder's booking, cancelled: the slot is free again. */
async function freeTheSlot() {
  await database.booking.updateMany({
    where: { userId: holderId },
    data: { status: "CANCELLED", holdExpiresAt: null },
  });
}

async function entry(id: string) {
  return database.waitlistEntry.findUniqueOrThrow({ where: { id } });
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING, max: 8 }),
  });
  testDatabase.current = database;
  await database.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(async () => {
  await database.waitlistEntry.deleteMany();
  await database.viewingForecastHour.deleteMany();
  await database.bookingEntitlement.deleteMany();
  await database.emailNotification.deleteMany();
  await database.auditLog.deleteMany();
  await database.networkAvailabilityWindow.deleteMany();
  await database.observatoryNetworkNode.deleteMany();
  await database.capture.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  await database.missionEvent.deleteMany();
  await database.observerPack.deleteMany();
  await database.booking.deleteMany();
  await database.mission.deleteMany();
  await database.giftVoucher.deleteMany();
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
      nameKa: "Test Observatory",
      city: "Tbilisi",
      countryCode: "GE",
      ...SITE,
      status: "ONLINE",
    },
  });
  observatoryId = observatory.id;
  const telescope = await database.telescope.create({
    data: {
      observatoryId,
      name: "NexStar 8SE",
      manufacturer: "Celestron",
      model: "NexStar 8SE",
      apertureMm: 203,
      focalLengthMm: 2032,
      status: "ONLINE",
    },
  });
  holderId = await createUser("Holder");
  firstId = await createUser("First");
  secondId = await createUser("Second");
  await database.observatoryNetworkNode.create({
    data: {
      ownerId: holderId,
      observatoryId,
      primaryTelescopeId: telescope.id,
      kind: "FIRST_PARTY",
      approvalStatus: "APPROVED",
      capabilities: [],
      approvedAt: NOW,
    },
  });
  // Polaris, up all night over Tbilisi, so every slot can be booked on it.
  await database.target.create({
    data: {
      slug: `polaris-${randomUUID()}`,
      nameEn: "Polaris",
      nameKa: "პოლარისი",
      type: "DOUBLE_STAR",
      positionSource: "FIXED",
      rightAscensionHours: 2.5303,
      declinationDegrees: 89.2641,
      angularSizeArcmin: 0.3,
      magnitude: 2,
      opticalConfig: "F10_NATIVE",
      imagingProfile: "DOUBLE_STAR",
      minAltitudeDegrees: 25,
      expectedMissionMinutes: 30,
    },
  });
});

describe("joining a slot's waitlist", () => {
  it("is for a slot somebody else holds, and says where you are in line", async () => {
    expect(await join(firstId)).toMatchObject({ ok: false, status: 409 });

    expect((await reserve(holderId)).ok).toBe(true);
    const first = await join(firstId);
    const second = await join(secondId);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(zWaitlistEntry.parse(first.body)).toEqual(first.body);
    expect(first.body).toMatchObject({ status: "WAITING", position: 1, offerExpiresAt: null });
    expect(second.body.position).toBe(2);

    // The holder cannot wait for their own slot, and nobody waits twice.
    expect(await join(holderId)).toMatchObject({ ok: false, status: 409 });
    expect(await join(firstId)).toMatchObject({ ok: false, status: 409 });

    const mine = await listMyWaitlistEntries(secondId, NOW);
    expect(zWaitlistEntryList.parse(mine)).toEqual(mine);
    expect(mine.items).toHaveLength(1);
  });

  it("allows three places at once", async () => {
    for (const slot of [0, 1, 2, 3]) expect((await reserve(holderId, slot)).ok).toBe(true);
    for (const slot of [0, 1, 2]) expect((await join(firstId, slot)).ok).toBe(true);
    expect(await join(firstId, 3)).toMatchObject({ ok: false, status: 422 });
  });

  it("refuses an instant the observatory does not offer", async () => {
    const result = await joinWaitlist({
      userId: firstId,
      request: {
        observatoryId,
        slotStartAt: new Date(slotStartAt(0).getTime() + 7 * MINUTE).toISOString(),
        durationMinutes: SLOT_DURATION_MINUTES,
      },
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, status: 422 });
  });

  it("can be left, and leaving another person's place is a 404", async () => {
    await reserve(holderId);
    const first = await join(firstId);
    if (!first.ok) throw new Error(first.message);
    expect(await leaveWaitlist({ userId: secondId, entryId: first.body.id, now: NOW })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await leaveWaitlist({ userId: firstId, entryId: first.body.id, now: NOW })).toEqual({ ok: true });
    expect((await entry(first.body.id)).status).toBe("LEFT");
    // Left, so the same slot can be joined again.
    expect((await join(firstId)).ok).toBe(true);
  });
});

describe("the sweep (clients ADR-068)", () => {
  it("offers a freed slot to the first in line, once, and emails them", async () => {
    await reserve(holderId);
    const first = await join(firstId);
    const second = await join(secondId);
    if (!first.ok || !second.ok) throw new Error("join failed");

    // Still held: nothing to offer.
    expect((await sweepWaitlist(database, NOW)).offered).toBe(0);

    await freeTheSlot();
    const swept = await sweepWaitlist(database, NOW);
    expect(swept.offered).toBe(1);
    expect(await entry(first.body.id)).toMatchObject({
      status: "OFFERED",
      offerExpiresAt: new Date(NOW.getTime() + WAITLIST_OFFER_MINUTES * MINUTE),
    });
    expect((await entry(second.body.id)).status).toBe("WAITING");
    expect(
      await database.emailNotification.count({
        where: { kind: "WAITLIST_OFFER", userId: firstId },
      }),
    ).toBe(1);

    // Two passes at once offer nothing new.
    const again = await Promise.all([sweepWaitlist(database, NOW), sweepWaitlist(database, NOW)]);
    expect(again.reduce((total, pass) => total + pass.offered, 0)).toBe(0);

    const listed = await listMyWaitlistEntries(firstId, NOW);
    expect(listed.items[0]).toMatchObject({ status: "OFFERED", position: null });
  });

  it("holds the offered slot: others cannot reserve it, the offeree can, and that claims it", async () => {
    await reserve(holderId);
    const first = await join(firstId);
    if (!first.ok) throw new Error(first.message);
    await freeTheSlot();
    await sweepWaitlist(database, NOW);

    const slots = await listSlotsForDate(observatoryId, NIGHT, NOW, 180);
    const offered = slots!.items.find((slot) => Date.parse(slot.startAt) === slotStartAt(0).getTime());
    expect(offered).toMatchObject({ available: false, unavailableReason: "HELD_FOR_WAITLIST" });

    expect(await reserve(secondId)).toMatchObject({ ok: false, status: 409, code: "SLOT_UNAVAILABLE" });
    const claimed = await reserve(firstId);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    expect((await sweepWaitlist(database, NOW)).claimed).toBe(1);
    expect(await entry(first.body.id)).toMatchObject({
      status: "CLAIMED",
      claimedBookingId: claimed.body.booking.id,
    });
  });

  it("lapses an unclaimed offer and offers the slot to the next in line", async () => {
    await reserve(holderId);
    const first = await join(firstId);
    const second = await join(secondId);
    if (!first.ok || !second.ok) throw new Error("join failed");
    await freeTheSlot();
    await sweepWaitlist(database, NOW);

    const later = new Date(NOW.getTime() + (WAITLIST_OFFER_MINUTES + 1) * MINUTE);
    const swept = await sweepWaitlist(database, later);
    expect(swept).toMatchObject({ lapsed: 1, offered: 1 });
    expect((await entry(first.body.id)).status).toBe("LAPSED");
    expect((await entry(second.body.id)).status).toBe("OFFERED");
  });

  it("ends every place once its slot has started", async () => {
    await reserve(holderId);
    const first = await join(firstId);
    if (!first.ok) throw new Error(first.message);
    const after = new Date(slotStartAt(0).getTime() + MINUTE);
    expect((await sweepWaitlist(database, after)).ended).toBe(1);
    expect((await entry(first.body.id)).status).toBe("ENDED");
  });
});

describe("the forecast on every slot (clients ADR-068)", () => {
  it("is the cloudiest stored hour the slot touches, and UNKNOWN where an hour is missing or stale", async () => {
    const start = slotStartAt(0);
    const hour = Math.floor(start.getTime() / 3_600_000) * 3_600_000;
    for (const [offset, cover] of [
      [0, 10],
      [1, 70],
    ] as const) {
      await database.viewingForecastHour.create({
        data: {
          observatoryId,
          at: new Date(hour + offset * 3_600_000),
          source: "OPEN_METEO",
          fetchedAt: NOW,
          cloudCoverPercent: cover,
        },
      });
    }

    const list = await listSlotsForDate(observatoryId, NIGHT, NOW, 180);
    expect(zSlotList.parse(list)).toEqual(list);
    const forecastAt = (ms: number) =>
      list!.items.find((slot) => Date.parse(slot.startAt) === ms)?.forecast;

    // A slot inside the first hour, one across both, and one past the stored hours.
    const inside = list!.items.find(
      (slot) => Date.parse(slot.startAt) >= hour && Date.parse(slot.endAt) <= hour + 3_600_000,
    );
    if (inside) expect(inside.forecast).toEqual({ status: "KNOWN", cloudCoverPercent: 10 });
    const across = list!.items.find(
      (slot) => Date.parse(slot.startAt) < hour + 3_600_000 && Date.parse(slot.endAt) > hour + 3_600_000,
    )!;
    expect(across.forecast).toEqual({ status: "KNOWN", cloudCoverPercent: 70 });
    expect(forecastAt(Date.parse(list!.items.at(-1)!.startAt))).toEqual({
      status: "UNKNOWN",
      cloudCoverPercent: null,
    });

    // Too old: unknown, never clear.
    const stale = await listSlotsForDate(
      observatoryId,
      NIGHT,
      new Date(NOW.getTime() + 181 * MINUTE),
      180,
    );
    expect(stale!.items.every((slot) => slot.forecast.status === "UNKNOWN")).toBe(true);
  });
});
