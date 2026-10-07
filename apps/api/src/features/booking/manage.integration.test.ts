import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({
    NODE_ENV: process.env.NODE_ENV ?? "test",
    APP_URL: "https://darkview.test",
  }),
}));

const { getMyBooking, listMyBookings } = await import("@/features/booking/manage");
const { zBookingPage, zGetBookingResponse } = await import("@darkview/contracts/zod");

/**
 * `listBookings` (#152) against a real PostgreSQL instance: the caller's own
 * bookings only, latest slot first, paged by a keyset cursor that never repeats
 * or skips a row and never pages through somebody else's.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const FIRST_SLOT = new Date("2026-12-15T17:00:00.000Z");

let database: PrismaClient;
let observatoryId: string;
let telescopeId: string;
let targetId: string;
let userId: string;
let otherUserId: string;

async function booking(options: {
  owner: string;
  hour: number;
  status?: "CONFIRMED" | "CANCELLED";
}): Promise<string> {
  const created = await database.booking.create({
    data: {
      userId: options.owner,
      targetId,
      observatoryId,
      telescopeId,
      slotStartAt: new Date(FIRST_SLOT.getTime() + options.hour * 3_600_000),
      durationMinutes: 30,
      status: options.status ?? "CONFIRMED",
      priceMinor: 4500,
    },
    select: { id: true },
  });
  return created.id;
}

beforeAll(async () => {
  database = new PrismaClient({ adapter: new PrismaPg({ connectionString: CONNECTION_STRING }) });
  testDatabase.current = database;
  await database.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(async () => {
  await database.bookingEntitlement.deleteMany();
  await database.emailNotification.deleteMany();
  await database.networkAvailabilityWindow.deleteMany();
  await database.observatoryNetworkNode.deleteMany();
  await database.capture.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  await database.missionEvent.deleteMany();
  await database.auditLog.deleteMany();
  await database.observerPack.deleteMany();
  await database.booking.deleteMany();
  await database.mission.deleteMany();
  await database.payment.deleteMany();
  await database.safetyEnvelope.deleteMany();
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
      status: "ONLINE",
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

  userId = (
    await database.user.create({
      data: { email: `${randomUUID()}@example.test`, name: "Customer" },
    })
  ).id;
  otherUserId = (
    await database.user.create({
      data: { email: `${randomUUID()}@example.test`, name: "Somebody else" },
    })
  ).id;
});

describe("listing the caller's bookings", () => {
  it("returns only the caller's, latest slot first, in a body the contract accepts", async () => {
    const early = await booking({ owner: userId, hour: 0 });
    await booking({ owner: otherUserId, hour: 1 });
    const late = await booking({ owner: userId, hour: 2 });

    const page = await listMyBookings({ userId, limit: 20 });

    expect(() => zBookingPage.parse(page)).not.toThrow();
    expect(page.items.map((item) => item.id)).toEqual([late, early]);
    expect(page.items.every((item) => item.userId === userId)).toBe(true);
    expect(page.page).toEqual({ hasMore: false, nextCursor: null });
  });

  it("pages with the cursor without repeating or skipping, ties broken by id", async () => {
    // Two cancelled bookings share a start time, which the exclusion constraint
    // allows once neither holds the slot. Without the id tiebreak their order would
    // be the planner's choice and a keyset cursor over it could skip one.
    const ids = [
      await booking({ owner: userId, hour: 0 }),
      await booking({ owner: userId, hour: 1, status: "CANCELLED" }),
      await booking({ owner: userId, hour: 1, status: "CANCELLED" }),
      await booking({ owner: userId, hour: 2 }),
      await booking({ owner: userId, hour: 3 }),
    ];
    await booking({ owner: otherUserId, hour: 4 });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await listMyBookings({ userId, cursor, limit: 2 });
      pages += 1;
      seen.push(...page.items.map((item) => item.id));
      if (!page.page.hasMore) {
        expect(page.page.nextCursor).toBeNull();
        break;
      }
      cursor = page.page.nextCursor ?? undefined;
    }

    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(ids.length);
  });

  it("ends the list at a cursor that is not one of the caller's bookings", async () => {
    await booking({ owner: userId, hour: 0 });
    const foreign = await booking({ owner: otherUserId, hour: 1 });

    for (const cursor of [foreign, randomUUID(), "not-a-uuid"]) {
      expect(await listMyBookings({ userId, cursor, limit: 20 })).toEqual({
        items: [],
        page: { hasMore: false, nextCursor: null },
      });
    }
  });

  it("returns an empty page to a customer with no bookings", async () => {
    await booking({ owner: otherUserId, hour: 0 });
    expect(await listMyBookings({ userId, limit: 20 })).toEqual({
      items: [],
      page: { hasMore: false, nextCursor: null },
    });
  });
});

/**
 * ADR-043: a held booking carries the intent `createBooking` answered, so the
 * customer who left the checkout can come back and pay from the booking itself.
 */
describe("reading a held booking", () => {
  const HOLD_EXPIRES_AT = new Date("2026-12-15T12:15:00.000Z");

  async function heldBooking(options: { status: "PENDING_PAYMENT" | "CONFIRMED" }) {
    const payment = await database.payment.create({
      data: {
        userId,
        provider: "SANDBOX",
        status: options.status === "CONFIRMED" ? "CAPTURED" : "PENDING",
        amountMinor: 4500,
        redirectUrl: "https://darkview.test/api/payments/checkout",
      },
      select: { id: true },
    });
    const created = await database.booking.create({
      data: {
        userId,
        targetId,
        observatoryId,
        telescopeId,
        paymentId: payment.id,
        slotStartAt: FIRST_SLOT,
        durationMinutes: 30,
        status: options.status,
        holdExpiresAt: options.status === "PENDING_PAYMENT" ? HOLD_EXPIRES_AT : null,
        priceMinor: 4500,
      },
      select: { id: true },
    });
    return { bookingId: created.id, paymentId: payment.id };
  }

  it("answers the intent, with the hold's deadline, while the booking awaits payment", async () => {
    const { bookingId, paymentId } = await heldBooking({ status: "PENDING_PAYMENT" });

    const read = await getMyBooking({ userId, bookingId });
    expect(zGetBookingResponse.safeParse(read).success).toBe(true);
    expect(read?.paymentIntent).toEqual({
      paymentId,
      provider: "SANDBOX",
      status: "PENDING",
      redirectUrl: "https://darkview.test/api/payments/checkout",
      expiresAt: HOLD_EXPIRES_AT.toISOString(),
    });

    const page = await listMyBookings({ userId, limit: 10 });
    expect(page.items.map((item) => item.paymentIntent?.paymentId)).toEqual([paymentId]);
  });

  it("answers null once the booking is paid, although the payment row remains", async () => {
    const { bookingId } = await heldBooking({ status: "CONFIRMED" });

    const read = await getMyBooking({ userId, bookingId });
    expect(read?.paymentId).not.toBeNull();
    expect(read?.paymentIntent).toBeNull();
  });
});
