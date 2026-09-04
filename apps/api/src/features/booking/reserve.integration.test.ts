import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

const { PAYMENT_HOLD_MINUTES, releaseSlotForFailedPayment, reserveSlot } =
  await import("@/features/booking/reserve");
const { listSlotsForDate } = await import("@/features/booking/slots");
const { nightWindow } = await import("@/lib/slots/darkness");
const { generateSlots, PROVISIONAL_SLOT_PRICE_MINOR, SLOT_DURATION_MINUTES } =
  await import("@/lib/slots/generate");

/**
 * DV-055 runs against a real PostgreSQL instance, on purpose.
 *
 * Acceptance criterion 1 says so in as many words: "proven by a concurrency test
 * running against a real PostgreSQL instance, not a mock". The claim under test is
 * that a *partial unique index* is what makes a slot exclusive. A mocked client
 * has no indexes, so a mocked version of this test could only prove that the code
 * does what the code does.
 *
 * Run it with `npm run test:integration`, which migrates the database first. CI
 * runs it against a postgres service container.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

/** Comfortably above the concurrency under test, so the pool is never the limit. */
const POOL_SIZE = 32;

/** Acceptance criterion 2: "at least 20". */
const CONCURRENCY = 20;

const HELD_SLOT_INDEX = "Booking_held_slot_unique";

const SITE = {
  latitude: 41.7151,
  longitude: 44.8271,
  timezone: "Asia/Tbilisi",
};

/**
 * A fixed instant on a long winter afternoon in Tbilisi: darkness has not begun,
 * so every slot that night is still in the future. Nothing here reads the wall
 * clock -- a test that books "tonight" fails at dawn.
 */
const NOW = new Date("2026-12-15T12:00:00.000Z");
const NIGHT = "2026-12-15";

let database: PrismaClient;
let observatoryId: string;
let telescopeId: string;
let targetId: string;
let userId: string;

/** The first bookable slot of that night, taken from the generator itself. */
function firstSlotStartAt(): Date {
  const window = nightWindow(NIGHT, SITE.timezone, {
    latitudeDegrees: SITE.latitude,
    longitudeDegrees: SITE.longitude,
  });

  if (!window) throw new Error("no astronomical darkness on the fixture night");

  const slot = generateSlots({
    window,
    now: NOW,
    observatory: { online: true, weatherHold: false },
    bookedStartAt: new Set(),
  }).find((candidate) => candidate.available);

  if (!slot) throw new Error("no available slot on the fixture night");
  return new Date(slot.startAt);
}

async function createUser(): Promise<string> {
  const user = await database.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      name: "Concurrency Tester",
      emailVerifiedAt: NOW,
    },
  });
  return user.id;
}

async function reserve(options: {
  userId?: string;
  slotStartAt: Date;
  idempotencyKey?: string | null;
  now?: Date;
}) {
  return reserveSlot({
    userId: options.userId ?? userId,
    request: {
      targetId,
      slotStartAt: options.slotStartAt.toISOString(),
      durationMinutes: SLOT_DURATION_MINUTES,
    },
    idempotencyKey: options.idempotencyKey ?? null,
    now: options.now ?? NOW,
  });
}

async function heldBookingsAt(slotStartAt: Date): Promise<number> {
  return database.booking.count({
    where: {
      slotStartAt,
      status: { in: ["PENDING_PAYMENT", "CONFIRMED"] },
    },
  });
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING, max: POOL_SIZE }),
  });
  testDatabase.current = database;

  // Fail loudly rather than silently skipping: a green run that never touched a
  // database would be worse than a red one.
  await database.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(async () => {
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
      latitude: SITE.latitude,
      longitude: SITE.longitude,
      timezone: SITE.timezone,
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

  userId = await createUser();
});

describe("reserving a slot", () => {
  it("returns the booking and a payment intent for a free slot", async () => {
    const slotStartAt = firstSlotStartAt();

    const result = await reserve({ slotStartAt });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.body.booking.status).toBe("PENDING_PAYMENT");
    expect(result.body.booking.slotStartAt).toBe(slotStartAt.toISOString());
    expect(result.body.paymentIntent.status).toBe("PENDING");
    expect(result.body.paymentIntent.provider).toBe("SANDBOX");

    // Price comes from the generator, never from the request body.
    expect(result.body.booking.priceMinor).toBe(PROVISIONAL_SLOT_PRICE_MINOR);

    expect(result.body.paymentIntent.expiresAt).toBe(
      new Date(NOW.getTime() + PAYMENT_HOLD_MINUTES * 60_000).toISOString(),
    );
  });

  it("refuses an instant that is not a slot the observatory offers", async () => {
    // Two and a half minutes past a real slot: off the five-minute alignment grid
    // and off the forty-minute stride, so the generator never emits it.
    const offGrid = new Date(firstSlotStartAt().getTime() + 150_000);

    const result = await reserve({ slotStartAt: offGrid });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(result.code).toBe("VALIDATION_FAILED");
  });

  it("refuses a slot in broad daylight", async () => {
    const noon = new Date("2026-12-16T09:00:00.000Z");

    const result = await reserve({ slotStartAt: noon });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
  });

  it("refuses a slot that has already started", async () => {
    const slotStartAt = firstSlotStartAt();

    const result = await reserve({
      slotStartAt,
      now: new Date(slotStartAt.getTime() + 60_000),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe("SLOT_UNAVAILABLE");
  });

  it("refuses to sell a night the observatory is holding for weather", async () => {
    await database.weatherState.create({
      data: { observatoryId, status: "UNSAFE", holdActive: true },
    });

    const result = await reserve({ slotStartAt: firstSlotStartAt() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe("WEATHER_HOLD");
  });
});

describe("two people, one slot", () => {
  /**
   * DV-055 acceptance criterion 1.
   */
  it("gives the slot to exactly one of two simultaneous requests", async () => {
    const slotStartAt = firstSlotStartAt();
    const otherUserId = await createUser();

    const [first, second] = await Promise.all([
      reserve({ slotStartAt }),
      reserve({ userId: otherUserId, slotStartAt }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);

    const rejected = outcomes.find((result) => !result.ok);
    expect(rejected && !rejected.ok && rejected.status).toBe(409);
    expect(rejected && !rejected.ok && rejected.code).toBe("SLOT_UNAVAILABLE");

    expect(await heldBookingsAt(slotStartAt)).toBe(1);
  });

  /**
   * DV-055 acceptance criterion 2.
   */
  it(`never double-books at a concurrency of ${CONCURRENCY}`, async () => {
    const slotStartAt = firstSlotStartAt();

    const users = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => createUser()),
    );

    const results = await Promise.all(
      users.map((id) => reserve({ userId: id, slotStartAt })),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(CONCURRENCY - 1);
    expect(await heldBookingsAt(slotStartAt)).toBe(1);

    // Every loser is told the same, contract-shaped thing.
    for (const result of results) {
      if (result.ok) continue;
      expect(result.status).toBe(409);
      expect(result.code).toBe("SLOT_UNAVAILABLE");
    }
  });

  /**
   * DV-055 acceptance criterion 3 -- "dropping the unique index makes the test
   * fail, proving the index, not the application logic, is what holds".
   *
   * Rather than leave that as a manual experiment someone has to remember to
   * re-run, the drop happens here. If this test ever starts finding one booking
   * with the index gone, something above the database has quietly taken over the
   * exclusivity guarantee -- and that something cannot be correct, because it
   * would be racing in application memory. The index is restored afterwards.
   */
  it("double-books once the partial unique index is dropped", async () => {
    const slotStartAt = firstSlotStartAt();

    const users = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => createUser()),
    );

    await database.$executeRawUnsafe(`DROP INDEX "${HELD_SLOT_INDEX}"`);

    try {
      const results = await Promise.all(
        users.map((id) => reserve({ userId: id, slotStartAt })),
      );

      expect(results.filter((result) => result.ok).length).toBeGreaterThan(1);
      expect(await heldBookingsAt(slotStartAt)).toBeGreaterThan(1);
    } finally {
      await database.booking.deleteMany({ where: { slotStartAt } });
      await database.$executeRawUnsafe(
        `CREATE UNIQUE INDEX "${HELD_SLOT_INDEX}" ON "Booking" ("observatoryId", "slotStartAt") ` +
          `WHERE "status" IN ('PENDING_PAYMENT', 'CONFIRMED')`,
      );
    }
  });

  it("restores the index the previous test dropped", async () => {
    const rows = (await database.$queryRaw`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'Booking' AND indexname = ${HELD_SLOT_INDEX}
    `) as { indexdef: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("PENDING_PAYMENT");
    expect(rows[0].indexdef).toContain("CONFIRMED");
  });
});

describe("releasing a slot", () => {
  /**
   * DV-055 acceptance criterion 4.
   */
  it("gives the slot back when payment fails, and creates no mission", async () => {
    const slotStartAt = firstSlotStartAt();

    const first = await reserve({ slotStartAt });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // While the hold stands, nobody else can have it.
    const blocked = await reserve({ userId: await createUser(), slotStartAt });
    expect(blocked.ok).toBe(false);

    const released = await releaseSlotForFailedPayment({
      bookingId: first.body.booking.id,
      reason: "CARD_DECLINED",
      now: NOW,
    });
    expect(released.released).toBe(true);

    expect(await database.mission.count()).toBe(0);

    const after = await database.booking.findUniqueOrThrow({
      where: { id: first.body.booking.id },
      include: { payment: true },
    });
    expect(after.status).toBe("CANCELLED");
    expect(after.missionId).toBeNull();
    expect(after.payment?.status).toBe("FAILED");
    expect(after.payment?.failureReason).toBe("CARD_DECLINED");

    // And the slot is genuinely on sale again, to someone else.
    const retry = await reserve({ userId: await createUser(), slotStartAt });
    expect(retry.ok).toBe(true);
    expect(await heldBookingsAt(slotStartAt)).toBe(1);
  });

  it("refuses to unwind a booking that already has a mission", async () => {
    const slotStartAt = firstSlotStartAt();

    const first = await reserve({ slotStartAt });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const mission = await database.mission.create({
      data: { userId, targetId, observatoryId, telescopeId },
    });
    await database.booking.update({
      where: { id: first.body.booking.id },
      data: { missionId: mission.id },
    });

    await expect(
      releaseSlotForFailedPayment({
        bookingId: first.body.booking.id,
        reason: "CARD_DECLINED",
        now: NOW,
      }),
    ).rejects.toThrow(/already has a mission/);
  });

  it("frees the slot once an unpaid hold lapses", async () => {
    const slotStartAt = firstSlotStartAt();

    const first = await reserve({ slotStartAt });
    expect(first.ok).toBe(true);

    const afterHold = new Date(NOW.getTime() + (PAYMENT_HOLD_MINUTES + 1) * 60_000);

    // GET /slots stops calling it taken without anything having swept the table.
    const slots = await listSlotsForDate(NIGHT, afterHold);
    const listed = slots.items.find(
      (slot) => Date.parse(slot.startAt) === slotStartAt.getTime(),
    );
    expect(listed?.available).toBe(true);

    // And a second customer can actually take it: the lapsed hold is expired
    // inside the reservation transaction, not by a background job.
    const second = await reserve({
      userId: await createUser(),
      slotStartAt,
      now: afterHold,
    });
    expect(second.ok).toBe(true);

    const lapsed = await database.booking.findUniqueOrThrow({
      where: { id: (first as { body: { booking: { id: string } } }).body.booking.id },
    });
    expect(lapsed.status).toBe("EXPIRED");
    expect(await heldBookingsAt(slotStartAt)).toBe(1);
  });

  it("keeps a live hold off the slot list", async () => {
    const slotStartAt = firstSlotStartAt();
    await reserve({ slotStartAt });

    const slots = await listSlotsForDate(NIGHT, NOW);
    const listed = slots.items.find(
      (slot) => Date.parse(slot.startAt) === slotStartAt.getTime(),
    );

    expect(listed?.available).toBe(false);
    expect(listed?.unavailableReason).toBe("ALREADY_BOOKED");
  });
});

describe("retrying a booking", () => {
  /**
   * DV-055 acceptance criterion 5.
   */
  it("returns the first booking when the same idempotency key is replayed", async () => {
    const slotStartAt = firstSlotStartAt();
    const key = `retry-${randomUUID()}`;

    const first = await reserve({ slotStartAt, idempotencyKey: key });
    const second = await reserve({ slotStartAt, idempotencyKey: key });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.replayed).toBe(true);
    expect(second.body.booking.id).toBe(first.body.booking.id);
    expect(second.body.paymentIntent.paymentId).toBe(first.body.paymentIntent.paymentId);

    expect(await database.booking.count()).toBe(1);
    expect(await database.payment.count()).toBe(1);
  });

  it("is idempotent even when the retry races the original", async () => {
    const slotStartAt = firstSlotStartAt();
    const key = `race-${randomUUID()}`;

    const results = await Promise.all([
      reserve({ slotStartAt, idempotencyKey: key }),
      reserve({ slotStartAt, idempotencyKey: key }),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);

    const ids = new Set(
      results.map((result) => (result.ok ? result.body.booking.id : "rejected")),
    );
    expect(ids.size).toBe(1);
    expect(await database.booking.count()).toBe(1);
  });

  it("keys are scoped to the user, so two customers cannot collide on one", async () => {
    const slotStartAt = firstSlotStartAt();
    const otherSlotStartAt = new Date(slotStartAt.getTime() + 40 * 60_000);
    const key = "shared-client-default-key";

    const mine = await reserve({ slotStartAt, idempotencyKey: key });
    const theirs = await reserve({
      userId: await createUser(),
      slotStartAt: otherSlotStartAt,
      idempotencyKey: key,
    });

    expect(mine.ok).toBe(true);
    expect(theirs.ok).toBe(true);
    if (!mine.ok || !theirs.ok) return;

    expect(theirs.replayed).toBe(false);
    expect(theirs.body.booking.id).not.toBe(mine.body.booking.id);
  });

  it("does not replay a key onto a different slot", async () => {
    const slotStartAt = firstSlotStartAt();
    const otherSlotStartAt = new Date(slotStartAt.getTime() + 40 * 60_000);
    const key = `sticky-${randomUUID()}`;

    const first = await reserve({ slotStartAt, idempotencyKey: key });
    const second = await reserve({ slotStartAt: otherSlotStartAt, idempotencyKey: key });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // A key identifies the request, not the slot. Reusing one for a genuinely
    // different booking returns the original -- which is why a client must mint a
    // fresh key per booking attempt, and why the contract says so.
    expect(second.replayed).toBe(true);
    expect(second.body.booking.slotStartAt).toBe(first.body.booking.slotStartAt);
    expect(await database.booking.count()).toBe(1);
  });
});
