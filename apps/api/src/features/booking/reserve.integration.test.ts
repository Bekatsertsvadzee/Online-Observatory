import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

/**
 * `reserveSlot` reads one variable, NODE_ENV. `getServerEnvironment` validates the
 * whole server environment, so the real one would make this suite demand APP_URL
 * and AUTH_SECRET to open a database connection it has already been handed. The
 * mock still reads `process.env` at call time, so `vi.stubEnv("NODE_ENV", ...)`
 * below drives the production check exactly as it drives the real function.
 */
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({ NODE_ENV: process.env.NODE_ENV ?? "test" }),
}));

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

/**
 * The most two-way races the deadlock test will run before giving up on
 * provoking one. With the retry removed, 60 rounds surfaced a deadlock in 8 of
 * 10 runs and 200 rounds in 10 of 10, on the machine this was written on.
 */
const RACE_ROUNDS = 200;

const HELD_SLOT_CONSTRAINT = "Booking_held_slot_exclusion";

/**
 * The constraint's definition, as the migration writes it. Restoring it after the
 * drop test uses this, and so does the assertion that the restore really happened,
 * so the two cannot drift apart.
 */
const HELD_SLOT_CONSTRAINT_SQL =
  `ALTER TABLE "Booking" ADD CONSTRAINT "${HELD_SLOT_CONSTRAINT}" EXCLUDE USING gist (` +
  `"observatoryId" WITH =, ` +
  `tsrange("slotStartAt", "slotStartAt" + make_interval(mins => "durationMinutes")) WITH &&` +
  `) WHERE ("status" IN ('PENDING_PAYMENT', 'CONFIRMED'))`;

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
  // Rows that reference a Mission, cleared before the missions they point at.
  // This suite shares one database with the others and must not depend on what
  // the file before it happened to leave behind: Mission has Restrict deletes, so
  // one stray command row from another suite fails every test in this one.
  // Captures first. Capture holds Restrict foreign keys to Mission, Target,
  // Telescope, Observatory and User, so a capture left behind by another suite
  // blocks every delete below it -- and these suites share one database.
  // ObservatoryNetworkNode holds Restrict foreign keys to Observatory and User
  // (ADR-013), so a node left behind blocks every later suite's cleanup.
  await database.networkAvailabilityWindow.deleteMany();
  await database.observatoryNetworkNode.deleteMany();
  await database.capture.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  await database.missionEvent.deleteMany();
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

  it("refuses to reserve at all in production, where SANDBOX is not selectable", async () => {
    // The contract: SANDBOX "is never selectable in a production environment and a
    // production payment success is never simulated". Selling a slot against a
    // payment that cannot really be taken is worse than refusing to sell one.
    vi.stubEnv("NODE_ENV", "production");

    try {
      const result = await reserve({ slotStartAt: firstSlotStartAt() });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(500);
      expect(await database.booking.count()).toBe(0);
      expect(await database.payment.count()).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
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

/**
 * The hours an owner offered, enforced on the booking path as well as the list.
 *
 * `GET /slots` narrowing without `POST /bookings` narrowing would be worse than
 * neither: the grid is public and predictable, so a customer who read one page of
 * it could name an instant the list refuses to show and have it accepted.
 */
describe("availability windows", () => {
  /** Minutes after local midnight, at the observatory. */
  function localMinutes(at: Date): number {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: SITE.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at);
    const value = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value ?? "0");
    return value("hour") * 60 + value("minute");
  }

  /** The weekday, at the observatory. 0 = Sunday. */
  function localWeekday(at: Date): number {
    const iso = new Intl.DateTimeFormat("en-CA", {
      timeZone: SITE.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
    const [year, month, day] = iso.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  }

  async function offerHours(options: {
    around: Date;
    spanMinutes: number;
    approvalStatus?: "DRAFT" | "UNDER_REVIEW" | "APPROVED" | "SUSPENDED";
    enabled?: boolean;
  }) {
    const start = localMinutes(options.around);
    const node = await database.observatoryNetworkNode.create({
      data: {
        ownerId: userId,
        observatoryId,
        primaryTelescopeId: telescopeId,
        kind: "FIRST_PARTY",
        approvalStatus: options.approvalStatus ?? "APPROVED",
        capabilities: [],
        approvedAt: NOW,
      },
    });

    await database.networkAvailabilityWindow.create({
      data: {
        nodeId: node.id,
        weekday: localWeekday(options.around),
        startMinute: start,
        endMinute: Math.min(1440, start + options.spanMinutes),
        enabled: options.enabled ?? true,
      },
    });
  }

  /** A slot the night offers that falls well outside a one-hour opening. */
  function laterSlotStartAt(after: Date): Date {
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
    }).find(
      (candidate) =>
        candidate.available &&
        Date.parse(candidate.startAt) > after.getTime() + 2 * 60 * 60_000,
    );

    if (!slot) throw new Error("the fixture night is too short for this test");
    return new Date(slot.startAt);
  }

  it("still sells a slot inside the hours the owner offered", async () => {
    const slotStartAt = firstSlotStartAt();
    await offerHours({ around: slotStartAt, spanMinutes: 60 });

    const result = await reserve({ slotStartAt });

    expect(result.ok).toBe(true);
  });

  it("refuses a slot outside them, even though darkness allows it", async () => {
    const opening = firstSlotStartAt();
    const outside = laterSlotStartAt(opening);
    await offerHours({ around: opening, spanMinutes: 60 });

    const result = await reserve({ slotStartAt: outside });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(result.code).toBe("VALIDATION_FAILED");
  });

  it("keeps that slot off the list too, so the two surfaces agree", async () => {
    const opening = firstSlotStartAt();
    const outside = laterSlotStartAt(opening);
    await offerHours({ around: opening, spanMinutes: 60 });

    const list = await listSlotsForDate(NIGHT, NOW);
    const offered = list.items.map((slot) => Date.parse(slot.startAt));

    expect(offered).toContain(opening.getTime());
    expect(offered).not.toContain(outside.getTime());
  });

  it("ignores the windows of a node that is not approved", async () => {
    // A SUSPENDED node is not offered to anybody, so its recorded hours are not
    // a statement about availability. Reading them would let a suspended
    // telescope keep shaping the booking page.
    const opening = firstSlotStartAt();
    const outside = laterSlotStartAt(opening);
    await offerHours({ around: opening, spanMinutes: 60, approvalStatus: "SUSPENDED" });

    const result = await reserve({ slotStartAt: outside });

    expect(result.ok).toBe(true);
  });

  it("treats a switched-off window as no window at all", async () => {
    const opening = firstSlotStartAt();
    const outside = laterSlotStartAt(opening);
    await offerHours({ around: opening, spanMinutes: 60, enabled: false });

    const result = await reserve({ slotStartAt: outside });

    expect(result.ok).toBe(true);
  });

  it("sells the whole night when the owner has recorded no hours", async () => {
    // The behaviour every deployment has today, unchanged. An owner who has not
    // thought about hours has not withdrawn their telescope.
    const outside = laterSlotStartAt(firstSlotStartAt());

    const result = await reserve({ slotStartAt: outside });

    expect(result.ok).toBe(true);
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
   * DV-066. An exclusion constraint deadlocks where a unique index did not: two
   * transactions reserving overlapping time each write their index entry, each
   * find the other's uncommitted row, and each wait on the other until PostgreSQL
   * aborts one with 40P01. Unhandled, the loser of a few races in a hundred was
   * handed a 500 instead of a 409.
   *
   * One race per test run is how that got through: the two tests above passed
   * most of the time. This races until PostgreSQL has actually deadlocked, and
   * asserts every loser -- including the deadlock's victim -- was still told the
   * truth.
   *
   * It stops at the first deadlock rather than running a fixed number of rounds,
   * because each one costs a full `deadlock_timeout` (one second by default) before
   * the detector runs. Watching for it is what makes the test short once the retry
   * works, and the round ceiling is what bounds it on a machine where the race is
   * rarer.
   */
  it("answers every lost race with a 409, never a deadlock", async () => {
    const slotStartAt = firstSlotStartAt();

    // Two customers for every round. Nothing about a hold is unique per user
    // without an idempotency key.
    const [first, second] = await Promise.all([createUser(), createUser()]);

    // Counts deadlocks as the reservation's transactions meet them, and passes
    // every call and every error straight through.
    let deadlocks = 0;
    const transaction = database.$transaction.bind(database);
    const watch = vi.spyOn(database, "$transaction").mockImplementation(((
      ...args: Parameters<typeof transaction>
    ) =>
      (transaction(...args) as Promise<unknown>).catch((error: unknown) => {
        if (String(error).includes("40P01")) deadlocks += 1;
        throw error;
      })) as typeof database.$transaction);

    try {
      for (let round = 0; round < RACE_ROUNDS && deadlocks === 0; round += 1) {
        const results = await Promise.all([
          reserve({ userId: first, slotStartAt }),
          reserve({ userId: second, slotStartAt }),
        ]);

        expect(results.filter((result) => result.ok)).toHaveLength(1);
        const loser = results.find((result) => !result.ok);
        expect(loser).toMatchObject({ status: 409, code: "SLOT_UNAVAILABLE" });

        await database.booking.deleteMany({ where: { slotStartAt } });
      }
    } finally {
      watch.mockRestore();
    }
  });

  /**
   * DV-055 acceptance criterion 3 -- "dropping the constraint makes the test fail,
   * proving the constraint, not the application logic, is what holds".
   *
   * Rather than leave that as a manual experiment someone has to remember to
   * re-run, the drop happens here. If this test ever starts finding one booking
   * with the constraint gone, something above the database has quietly taken over
   * the exclusivity guarantee -- and that something cannot be correct, because it
   * would be racing in application memory. The constraint is restored afterwards.
   */
  it("double-books once the exclusion constraint is dropped", async () => {
    const slotStartAt = firstSlotStartAt();

    const users = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => createUser()),
    );

    await database.$executeRawUnsafe(
      `ALTER TABLE "Booking" DROP CONSTRAINT "${HELD_SLOT_CONSTRAINT}"`,
    );

    try {
      const results = await Promise.all(
        users.map((id) => reserve({ userId: id, slotStartAt })),
      );

      expect(results.filter((result) => result.ok).length).toBeGreaterThan(1);
      expect(await heldBookingsAt(slotStartAt)).toBeGreaterThan(1);
    } finally {
      await database.booking.deleteMany({ where: { slotStartAt } });
      await database.$executeRawUnsafe(HELD_SLOT_CONSTRAINT_SQL);
    }
  });

  it("restores the constraint the previous test dropped", async () => {
    const rows = (await database.$queryRaw`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = '"Booking"'::regclass AND conname = ${HELD_SLOT_CONSTRAINT}
    `) as { def: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].def).toContain("EXCLUDE USING gist");
    expect(rows[0].def).toContain("PENDING_PAYMENT");
    expect(rows[0].def).toContain("CONFIRMED");
  });
});

/**
 * DV-066 -- the defect ADR-015 identified, closed.
 *
 * These go through Prisma rather than through `reserveSlot`, because the generator
 * sells one length and so cannot produce a mixed pair. That is the point: the
 * blind spot is not reachable from the application *today*, and the constraint has
 * to be in place before it becomes reachable. What is under test is the database
 * rule, which is where DV-055 put the guarantee and where it stays.
 */
describe("mixed slot lengths", () => {
  /** A held booking, written directly. Everything the row needs and nothing else. */
  async function hold(startAt: Date, durationMinutes: number) {
    return database.booking.create({
      data: {
        userId: await createUser(),
        targetId,
        observatoryId,
        telescopeId,
        slotStartAt: startAt,
        durationMinutes,
        status: "PENDING_PAYMENT",
        holdExpiresAt: new Date(NOW.getTime() + 60 * 60_000),
        priceMinor: PROVISIONAL_SLOT_PRICE_MINOR,
        currency: "GEL",
      },
    });
  }

  const at = (iso: string) => new Date(`2026-12-15T${iso}:00.000Z`);

  /**
   * The exact pair ADR-015 names: "a sixty-minute booking at 21:00 and a
   * twenty-minute one at 21:20 have different start instants, so both inserts
   * succeed and two customers hold one telescope at the same time." Under the old
   * start-instant index this test passed twice; the second insert must now fail.
   */
  it("refuses a short booking that starts inside a long one", async () => {
    await hold(at("21:00"), 60);

    await expect(hold(at("21:20"), 20)).rejects.toThrow();
    expect(await database.booking.count()).toBe(1);
  });

  it("refuses a long booking that swallows a short one already held", async () => {
    await hold(at("21:20"), 20);

    await expect(hold(at("21:00"), 60)).rejects.toThrow();
    expect(await database.booking.count()).toBe(1);
  });

  /**
   * '[)' bounds, and why they are the right ones. A stride of adjacent slots is
   * the ordinary case -- if touching counted as overlapping, the constraint would
   * refuse the night's second slot.
   */
  it("allows a booking that begins exactly when another ends", async () => {
    await hold(at("21:00"), 20);
    await hold(at("21:20"), 20);

    expect(await database.booking.count()).toBe(2);
  });

  /**
   * The constraint is scoped per observatory, the same way the index it replaced
   * was. Two telescopes are two telescopes, and DV-066 exists so that they can be.
   */
  it("allows the same interval at a different observatory", async () => {
    const other = await database.observatory.create({
      data: {
        slug: `test-other-${randomUUID()}`,
        nameEn: "Second Observatory",
        nameKa: "მეორე ობსერვატორია",
        city: "Tbilisi",
        countryCode: "GE",
        latitude: SITE.latitude,
        longitude: SITE.longitude,
        timezone: SITE.timezone,
        status: "ONLINE",
      },
    });

    const otherTelescope = await database.telescope.create({
      data: {
        observatoryId: other.id,
        name: "NexStar 8SE",
        manufacturer: "Celestron",
        model: "NexStar 8SE",
        apertureMm: 203,
        focalLengthMm: 2032,
        status: "ONLINE",
      },
    });

    await hold(at("21:00"), 60);

    await database.booking.create({
      data: {
        userId: await createUser(),
        targetId,
        observatoryId: other.id,
        telescopeId: otherTelescope.id,
        slotStartAt: at("21:00"),
        durationMinutes: 60,
        status: "PENDING_PAYMENT",
        holdExpiresAt: new Date(NOW.getTime() + 60 * 60_000),
        priceMinor: PROVISIONAL_SLOT_PRICE_MINOR,
        currency: "GEL",
      },
    });

    expect(await database.booking.count()).toBe(2);
  });

  /**
   * A released booking gives its interval back. The WHERE clause is DV-055's and
   * this is what it is for: CANCELLED, EXPIRED and REFUNDED hold nothing.
   */
  it("frees the interval once the booking is no longer held", async () => {
    const first = await hold(at("21:00"), 60);
    await database.booking.update({
      where: { id: first.id },
      data: { status: "CANCELLED", holdExpiresAt: null },
    });

    await hold(at("21:20"), 20);
    expect(await heldBookingsAt(at("21:20"))).toBe(1);
  });

  /**
   * A zero-minute booking would be an empty range, and an empty range overlaps
   * nothing -- not even itself. Without `booking_duration_is_positive` such a row
   * would sit outside the exclusivity rule while still holding a telescope, which
   * is the one failure mode of this constraint that is silent.
   */
  it("refuses a booking with no duration at all", async () => {
    await expect(hold(at("21:00"), 0)).rejects.toThrow();
    expect(await database.booking.count()).toBe(0);
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
