import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  zBookingWithPaymentIntent,
  zCardDraw,
  zCardPrizeList,
  zObserverPackWithPaymentIntent,
} from "@darkview/contracts/zod";
import { PrismaClient } from "@darkview/db";
import { refundEntitledBooking } from "@darkview/db/refunds";
import { deriveCardPrizeCode } from "@darkview/db/vouchers";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

const SECRET = "c".repeat(32);

vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({
    NODE_ENV: process.env.NODE_ENV ?? "test",
    APP_URL: "https://darkview.test",
    VOUCHER_CODE_SECRET: process.env.TEST_NO_VOUCHER_SECRET ? undefined : "c".repeat(32),
  }),
}));

const { listMyCardPrizes, pickCard, readCardDrawOdds, readCurrentCardDraw } =
  await import("@/features/cards/draw");
const { reserveSlot } = await import("@/features/booking/reserve");
const { cancelMyBooking } = await import("@/features/booking/manage");
const { purchaseObserverPack } = await import("@/features/missions/observer-pack");
const { settlePayment } = await import("@/features/payments/settle");
const { nightWindow } = await import("@/lib/slots/darkness");
const { generateSlots, PROVISIONAL_SLOT_PRICE_MINOR, SLOT_DURATION_MINUTES } =
  await import("@/lib/slots/generate");

/**
 * ADR-060 -- the weekly card draw, against a real PostgreSQL instance. What only a
 * database can show: that the week's free-slot cap holds while deals race, that a
 * deal is picked once, and that a prize is spent in the transaction of the booking
 * or seat it pays for, and comes back when that booking does not happen.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const SITE = { latitude: 41.7151, longitude: 44.8271, timezone: "Asia/Tbilisi" };
/** A Tuesday afternoon in Tbilisi, in the week of Monday 14 December. */
const NOW = new Date("2026-12-15T12:00:00.000Z");
const NIGHT = "2026-12-15";
const WEEK = "2026-12-14";
/** Monday 21 December, 00:00 in Tbilisi (UTC+4). */
const NEXT_WEEK_OPENS = "2026-12-20T20:00:00.000Z";
const DAY_MS = 86_400_000;

let database: PrismaClient;
let observatoryId: string;
let telescopeId: string;
let targetId: string;
let customerId: string;

/**
 * A scripted deal: each card's roll in [0, 10000) in turn, and the first remaining
 * target for every face. With the approved odds, a roll below 100 is a free slot,
 * below 1100 a seat, below 3600 a discount, and the rest nothing.
 */
function rolls(...values: number[]) {
  const queue = [...values];
  return (bound: number) => {
    if (bound !== 10_000) return 0;
    const next = queue.shift();
    if (next === undefined)
      throw new Error("the deal rolled more than it was scripted for");
    return next;
  };
}

const always = (value: number) => (bound: number) => (bound === 10_000 ? value : 0);

const FREE_SLOT = 0;
const SEAT = 500;
const DISCOUNT = 2_000;
const NOTHING = 9_000;

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
    bookedStartAt: new Set(),
  }).filter((slot) => slot.available);
  return new Date(slots[index].startAt);
}

async function createUser(name: string) {
  const user = await database.user.create({
    data: { email: `${randomUUID()}@example.test`, name, emailVerifiedAt: NOW },
  });
  return user.id;
}

async function deal(userId: string, drawInteger: (bound: number) => number, now = NOW) {
  const result = await readCurrentCardDraw({ userId, observatoryId, now, drawInteger });
  if (!result.ok) throw new Error(`deal refused: ${result.refusal.kind}`);
  return result.draw;
}

async function pick(
  userId: string,
  drawId: string,
  position: number,
  options: { idempotencyKey?: string; now?: Date } = {},
) {
  return pickCard({
    userId,
    drawId,
    position,
    idempotencyKey: options.idempotencyKey ?? null,
    now: options.now ?? NOW,
  });
}

/** A prize of the given kind, won by `userId`, and its code. */
async function win(userId: string, roll: number) {
  const draw = await deal(userId, rolls(roll, NOTHING, NOTHING));
  const picked = await pick(userId, draw.id, 0);
  if (!picked.ok) throw new Error(`pick refused: ${picked.refusal.kind}`);
  const prize = picked.draw.cards[0].prize!;
  return { prize, code: prize.voucherCode! };
}

function book(
  code: string | undefined,
  options: { userId?: string; slot?: number; now?: Date } = {},
) {
  return reserveSlot({
    userId: options.userId ?? customerId,
    request: {
      observatoryId,
      targetId,
      slotStartAt: slotStartAt(options.slot ?? 0).toISOString(),
      durationMinutes: SLOT_DURATION_MINUTES,
      ...(code === undefined ? {} : { voucherCode: code }),
    },
    idempotencyKey: null,
    now: options.now ?? NOW,
  });
}

const prizeRow = (id: string) => database.cardPrize.findUniqueOrThrow({ where: { id } });

async function heldThisWeek() {
  const row = await database.cardDrawWeek.findUnique({
    where: { observatoryId_week: { observatoryId, week: new Date(`${WEEK}T00:00:00Z`) } },
  });
  return row?.freeSlotsHeld ?? 0;
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING, max: 24 }),
  });
  testDatabase.current = database;
  await database.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(async () => {
  await database.bookingEntitlement.deleteMany();
  await database.emailNotification.deleteMany();
  await database.auditLog.deleteMany();
  await database.cardPrize.deleteMany();
  await database.cardDraw.deleteMany();
  await database.cardDrawWeek.deleteMany();
  await database.networkAvailabilityWindow.deleteMany();
  await database.observatoryNetworkNode.deleteMany();
  await database.capture.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionParticipant.deleteMany();
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
  // The approved starting values (ADR-058 §4), whatever an earlier test set.
  await database.cardDrawScheme.update({
    where: { id: 1 },
    data: {
      freeSlotChanceBp: 100,
      observerSeatChanceBp: 1000,
      discountChanceBp: 2500,
      freeSlotsPerWeek: 2,
      discountPercentOff: 20,
      prizeValidDays: 30,
    },
  });

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
  telescopeId = telescope.id;
  const owner = await createUser("Owner");
  customerId = await createUser("Customer");
  await database.observatoryNetworkNode.create({
    data: {
      ownerId: owner,
      observatoryId,
      primaryTelescopeId: telescope.id,
      kind: "FIRST_PARTY",
      approvalStatus: "APPROVED",
      capabilities: [],
      approvedAt: NOW,
    },
  });
  // Polaris stands over Tbilisi all night, so every slot can deliver it.
  const target = await database.target.create({
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
  targetId = target.id;
});

describe("the deal", () => {
  it("deals three face-down cards on the week's first read, and the same three after", async () => {
    const first = await deal(customerId, rolls(FREE_SLOT, SEAT, NOTHING));

    expect(zCardDraw.parse(first)).toEqual(first);
    expect(first).toMatchObject({
      observatoryId,
      week: WEEK,
      opensNextAt: NEXT_WEEK_OPENS,
      picked: null,
      pickedAt: null,
    });
    // Unturned cards give nothing away.
    expect(first.cards).toEqual(
      [0, 1, 2].map((position) => ({
        position,
        turned: false,
        rarity: null,
        targetSlug: null,
        prize: null,
      })),
    );
    expect(JSON.stringify(first.cards)).not.toMatch(/LEGENDARY|EPIC|polaris/);

    const again = await deal(customerId, () => {
      throw new Error("a second read must not deal again");
    });
    expect(again).toEqual(first);
    expect(await database.cardDraw.count()).toBe(1);

    const dealt = await database.auditLog.findMany({
      where: { action: "CARD_DRAW_DEALT" },
    });
    expect(dealt).toHaveLength(1);
    expect(dealt[0]).toMatchObject({ category: "CARD_DRAW", actorUserId: customerId });
    expect(dealt[0].metadata).toMatchObject({
      week: WEEK,
      card0: "LEGENDARY",
      card1: "EPIC",
      card2: "COMMON",
    });
  });

  it("deals once per account per week, and a new deal the next week", async () => {
    const thisWeek = await deal(customerId, always(NOTHING));
    const sunday = new Date("2026-12-20T19:59:00.000Z");
    expect((await deal(customerId, always(NOTHING), sunday)).id).toBe(thisWeek.id);

    const monday = new Date(NEXT_WEEK_OPENS);
    const nextWeek = await deal(customerId, always(NOTHING), monday);
    expect(nextWeek.id).not.toBe(thisWeek.id);
    expect(nextWeek.week).toBe("2026-12-21");

    // Another account has its own deal.
    const other = await createUser("Other");
    expect((await deal(other, always(NOTHING))).id).not.toBe(thisWeek.id);
  });

  it("deals one deal when an account's first reads race", async () => {
    const draws = await Promise.all(
      Array.from({ length: 6 }, () => deal(customerId, always(FREE_SLOT))),
    );
    expect(new Set(draws.map((draw) => draw.id)).size).toBe(1);
    expect(await database.cardDraw.count()).toBe(1);
    // The losers' free slots rolled back with their deals.
    expect(await heldThisWeek()).toBe(2);
  });

  it("draws each card's rarity from the configured odds, at their edges", async () => {
    const edges = [99, 100, 1099, 1100, 3599, 3600];
    const expected = ["LEGENDARY", "EPIC", "EPIC", "RARE", "RARE", "COMMON"];
    for (let index = 0; index < edges.length; index += 1) {
      const user = await createUser(`edge-${index}`);
      const draw = await deal(user, rolls(edges[index], NOTHING, NOTHING));
      const turned = await pick(user, draw.id, 0);
      expect(turned.ok && turned.draw.cards[0].rarity).toBe(expected[index]);
    }
  });

  it("reads the odds from configuration, not code", async () => {
    await database.cardDrawScheme.update({
      where: { id: 1 },
      data: { freeSlotChanceBp: 0, observerSeatChanceBp: 5000 },
    });
    const draw = await deal(customerId, rolls(0, 4999, 5000));
    const turned = await pick(customerId, draw.id, 0);
    expect(turned.ok).toBe(true);
    if (!turned.ok) return;
    expect(turned.draw.cards.map((card) => card.rarity)).toEqual([
      "EPIC",
      "EPIC",
      "RARE",
    ]);

    const odds = await readCardDrawOdds();
    expect(odds.cards).toEqual([
      { rarity: "LEGENDARY", prizeKind: "FREE_SLOT", chance: 0 },
      { rarity: "EPIC", prizeKind: "OBSERVER_SEAT", chance: 0.5 },
      { rarity: "RARE", prizeKind: "DISCOUNT", chance: 0.25 },
      { rarity: "COMMON", prizeKind: null, chance: 0.25 },
    ]);
  });

  it("publishes the approved odds and rules", async () => {
    expect(await readCardDrawOdds()).toEqual({
      cards: [
        { rarity: "LEGENDARY", prizeKind: "FREE_SLOT", chance: 0.01 },
        { rarity: "EPIC", prizeKind: "OBSERVER_SEAT", chance: 0.1 },
        { rarity: "RARE", prizeKind: "DISCOUNT", chance: 0.25 },
        { rarity: "COMMON", prizeKind: null, chance: 0.64 },
      ],
      freeSlotsPerWeek: 2,
      freeSlotDurationMinutes: SLOT_DURATION_MINUTES,
      discountPercentOff: 20,
      prizeValidDays: 30,
    });
  });

  it("deals nothing at a partner observatory, or at one that is not bookable", async () => {
    await database.observatoryNetworkNode.updateMany({
      where: { observatoryId },
      data: { kind: "PARTNER" },
    });
    const partner = await readCurrentCardDraw({
      userId: customerId,
      observatoryId,
      now: NOW,
      drawInteger: always(NOTHING),
    });
    expect(partner).toEqual({ ok: false, refusal: { kind: "not-found" } });

    const unknown = await readCurrentCardDraw({
      userId: customerId,
      observatoryId: randomUUID(),
      now: NOW,
    });
    expect(unknown).toEqual({ ok: false, refusal: { kind: "not-found" } });
    expect(await database.cardDraw.count()).toBe(0);
  });

  it("refuses to deal on a deployment with no code secret", async () => {
    process.env.TEST_NO_VOUCHER_SECRET = "1";
    try {
      const result = await readCurrentCardDraw({
        userId: customerId,
        observatoryId,
        now: NOW,
      });
      expect(result).toEqual({ ok: false, refusal: { kind: "not-configured" } });
    } finally {
      delete process.env.TEST_NO_VOUCHER_SECRET;
    }
  });
});

describe("the week's free-slot cap", () => {
  it("holds across many simultaneous deals, and turns the excess into discounts", async () => {
    const users = await Promise.all(
      Array.from({ length: 10 }, (_, index) => createUser(`racer-${index}`)),
    );
    await Promise.all(users.map((user) => deal(user, always(FREE_SLOT))));

    const cards = await database.cardDrawCard.findMany();
    expect(cards).toHaveLength(30);
    expect(cards.filter((card) => card.rarity === "LEGENDARY")).toHaveLength(2);
    expect(cards.filter((card) => card.rarity === "RARE")).toHaveLength(28);
    expect(await heldThisWeek()).toBe(2);
  });

  it("gives back a free slot the pick left on an unchosen card", async () => {
    const first = await deal(customerId, rolls(FREE_SLOT, FREE_SLOT, NOTHING));
    expect(await heldThisWeek()).toBe(2);

    const blocked = await createUser("Blocked");
    await deal(blocked, rolls(FREE_SLOT, NOTHING, NOTHING));
    const blockedCards = await database.cardDrawCard.findMany({
      where: { draw: { userId: blocked } },
      orderBy: { position: "asc" },
    });
    expect(blockedCards[0].rarity).toBe("RARE");

    const picked = await pick(customerId, first.id, 2);
    expect(picked.ok && picked.draw.cards.map((card) => card.rarity)).toEqual([
      "LEGENDARY",
      "LEGENDARY",
      "COMMON",
    ]);
    expect(await heldThisWeek()).toBe(0);

    const later = await createUser("Later");
    const laterDraw = await deal(later, rolls(FREE_SLOT, NOTHING, NOTHING));
    const turned = await pick(later, laterDraw.id, 0);
    expect(turned.ok && turned.draw.cards[0].prize?.kind).toBe("FREE_SLOT");
    expect(await heldThisWeek()).toBe(1);
  });

  it("is per observatory week: a new week starts with the full cap", async () => {
    await deal(customerId, always(FREE_SLOT));
    const other = await createUser("Other");
    const nextWeek = await deal(other, always(FREE_SLOT), new Date(NEXT_WEEK_OPENS));
    const turned = await pick(other, nextWeek.id, 0, { now: new Date(NEXT_WEEK_OPENS) });
    expect(
      turned.ok && turned.draw.cards.filter((card) => card.rarity === "LEGENDARY"),
    ).toHaveLength(2);
  });
});

describe("the pick", () => {
  it("turns every card, issues the picked card's prize, and audits it", async () => {
    const draw = await deal(customerId, rolls(SEAT, DISCOUNT, NOTHING));
    const result = await pick(customerId, draw.id, 1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(zCardDraw.parse(result.draw)).toEqual(result.draw);
    expect(result.draw.picked).toBe(1);
    expect(result.draw.pickedAt).toBe(NOW.toISOString());
    expect(result.draw.cards.map((card) => [card.turned, card.rarity])).toEqual([
      [true, "EPIC"],
      [true, "RARE"],
      [true, "COMMON"],
    ]);
    // Every face names a catalogue target; only the picked card carries a prize.
    expect(
      result.draw.cards.every((card) => card.targetSlug?.startsWith("polaris-")),
    ).toBe(true);
    expect(result.draw.cards[0].prize).toBeNull();
    expect(result.draw.cards[2].prize).toBeNull();

    const prize = result.draw.cards[1].prize!;
    expect(prize).toMatchObject({
      kind: "DISCOUNT",
      status: "ACTIVE",
      observatoryId,
      percentOff: 20,
      durationMinutes: null,
      expiresAt: new Date(NOW.getTime() + 30 * DAY_MS).toISOString(),
      redeemedBookingId: null,
    });
    expect(prize.voucherCode).toBe(deriveCardPrizeCode(SECRET, prize.id));
    expect(prize.codeLast4).toBe(prize.voucherCode!.replace(/-/g, "").slice(-4));

    // The code is never stored.
    const stored = JSON.stringify(await prizeRow(prize.id));
    expect(stored).not.toContain(prize.voucherCode!.replace(/-/g, ""));

    const picked = await database.auditLog.findFirstOrThrow({
      where: { action: "CARD_DRAW_PICKED" },
    });
    expect(picked.metadata).toMatchObject({
      position: 1,
      rarity: "RARE",
      prizeKind: "DISCOUNT",
    });

    // ADR-062. The winner is emailed once, by id: the email carries no code.
    const emails = await database.emailNotification.findMany();
    expect(emails).toMatchObject([
      {
        userId: customerId,
        kind: "CARD_PRIZE_WON",
        dedupeKey: `card-prize-won:${prize.id}`,
        payload: { cardPrizeId: prize.id },
      },
    ]);
  });

  it("wins nothing on a common card", async () => {
    const draw = await deal(customerId, rolls(NOTHING, SEAT, SEAT));
    const result = await pick(customerId, draw.id, 0);
    expect(result.ok && result.draw.cards.every((card) => card.prize === null)).toBe(
      true,
    );
    expect(await database.cardPrize.count()).toBe(0);
    expect(await database.emailNotification.count()).toBe(0);
  });

  it("refuses a second pick with CARD_ALREADY_PICKED and changes nothing", async () => {
    const draw = await deal(customerId, rolls(SEAT, NOTHING, NOTHING));
    expect((await pick(customerId, draw.id, 0)).ok).toBe(true);

    expect(await pick(customerId, draw.id, 1)).toEqual({
      ok: false,
      refusal: { kind: "already-picked" },
    });
    expect(await pick(customerId, draw.id, 0)).toEqual({
      ok: false,
      refusal: { kind: "already-picked" },
    });
    expect(await database.cardPrize.count()).toBe(1);
  });

  it("answers a retried pick with its Idempotency-Key with the first pick's result", async () => {
    const draw = await deal(customerId, rolls(SEAT, NOTHING, NOTHING));
    const first = await pick(customerId, draw.id, 0, { idempotencyKey: "pick-key-0001" });
    const retried = await pick(customerId, draw.id, 2, {
      idempotencyKey: "pick-key-0001",
    });

    expect(retried).toEqual(first);
    expect(
      await pick(customerId, draw.id, 0, { idempotencyKey: "another-key-1" }),
    ).toEqual({
      ok: false,
      refusal: { kind: "already-picked" },
    });
    expect(await database.cardPrize.count()).toBe(1);
  });

  it("issues one prize when picks of one deal race", async () => {
    const draw = await deal(customerId, rolls(SEAT, DISCOUNT, FREE_SLOT));
    const results = await Promise.all(
      [0, 1, 2, 0, 1, 2].map((position) => pick(customerId, draw.id, position)),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(5);
    expect(await database.cardPrize.count()).toBe(1);
    expect(await database.auditLog.count({ where: { action: "CARD_DRAW_PICKED" } })).toBe(
      1,
    );
  });

  it("is the dealt account's alone", async () => {
    const draw = await deal(customerId, rolls(SEAT, NOTHING, NOTHING));
    const stranger = await createUser("Stranger");
    expect(await pick(stranger, draw.id, 0)).toEqual({
      ok: false,
      refusal: { kind: "not-found" },
    });
    expect(await pick(customerId, randomUUID(), 0)).toEqual({
      ok: false,
      refusal: { kind: "not-found" },
    });
  });

  it("closes when the next week opens", async () => {
    const draw = await deal(customerId, rolls(SEAT, NOTHING, NOTHING));
    expect(
      await pick(customerId, draw.id, 0, { now: new Date(NEXT_WEEK_OPENS) }),
    ).toEqual({
      ok: false,
      refusal: { kind: "closed" },
    });
    expect(await database.cardPrize.count()).toBe(0);
  });
});

describe("a prize", () => {
  it("expires thirty days after it is won, and is listed newest first", async () => {
    const { prize } = await win(customerId, SEAT);
    const later = new Date(prize.expiresAt);

    const listed = await listMyCardPrizes(customerId, NOW);
    expect(zCardPrizeList.parse(listed)).toEqual(listed);
    expect(listed!.items.map((item) => item.id)).toEqual([prize.id]);

    const expired = await listMyCardPrizes(customerId, later);
    expect(expired!.items[0]).toMatchObject({ status: "EXPIRED", voucherCode: null });
    expect(await listMyCardPrizes(await createUser("Nobody"), NOW)).toEqual({
      items: [],
    });
  });

  it("cannot be spent after it expires", async () => {
    const { prize, code } = await win(customerId, FREE_SLOT);
    await database.cardPrize.update({
      where: { id: prize.id },
      data: { expiresAt: NOW },
    });
    const result = await book(code);
    expect(result).toMatchObject({ ok: false, status: 422, code: "VALIDATION_FAILED" });
    expect((await prizeRow(prize.id)).status).toBe("ACTIVE");
  });

  it("is refused to every other account with the answer an unknown code gets", async () => {
    const { prize, code } = await win(customerId, FREE_SLOT);
    const stranger = await createUser("Stranger");

    const theirs = await book(code, { userId: stranger });
    const unknown = await book("ZZZZ-ZZZZ-ZZZZ-ZZZZ", { userId: stranger });
    expect(theirs).toEqual(unknown);
    expect(theirs).toMatchObject({
      ok: false,
      status: 422,
      message: "That voucher code cannot be used.",
    });
    expect((await prizeRow(prize.id)).status).toBe("ACTIVE");
  });

  it("is spent only at the observatory of its deal", async () => {
    const { code } = await win(customerId, FREE_SLOT);
    const elsewhere = await database.observatory.create({
      data: {
        slug: `elsewhere-${randomUUID()}`,
        nameEn: "Elsewhere",
        nameKa: "Elsewhere",
        city: "Tbilisi",
        countryCode: "GE",
        ...SITE,
        status: "ONLINE",
      },
    });
    const telescope = await database.telescope.create({
      data: {
        observatoryId: elsewhere.id,
        name: "NexStar 8SE",
        manufacturer: "Celestron",
        model: "NexStar 8SE",
        apertureMm: 203,
        focalLengthMm: 2032,
        status: "ONLINE",
      },
    });
    await database.observatoryNetworkNode.create({
      data: {
        ownerId: customerId,
        observatoryId: elsewhere.id,
        primaryTelescopeId: telescope.id,
        kind: "FIRST_PARTY",
        approvalStatus: "APPROVED",
        capabilities: [],
        approvedAt: NOW,
      },
    });
    const result = await reserveSlot({
      userId: customerId,
      request: {
        observatoryId: elsewhere.id,
        targetId,
        slotStartAt: slotStartAt(0).toISOString(),
        durationMinutes: SLOT_DURATION_MINUTES,
        voucherCode: code,
      },
      idempotencyKey: null,
      now: NOW,
    });
    expect(result).toMatchObject({
      ok: false,
      status: 422,
      message: "This prize is for another observatory.",
    });
  });
});

describe("a free-slot prize on POST /bookings", () => {
  it("confirms the booking at no charge and spends the prize, once", async () => {
    const { prize, code } = await win(customerId, FREE_SLOT);
    expect(prize).toMatchObject({
      kind: "FREE_SLOT",
      durationMinutes: SLOT_DURATION_MINUTES,
    });

    const result = await book(code);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(zBookingWithPaymentIntent.parse(result.body)).toEqual(result.body);
    expect(result.body.paymentIntent).toBeNull();
    expect(result.body.booking).toMatchObject({
      status: "CONFIRMED",
      priceMinor: 0,
      paymentId: null,
    });
    expect(result.body.booking.missionId).not.toBeNull();

    expect(await prizeRow(prize.id)).toMatchObject({
      status: "REDEEMED",
      redeemedBookingId: result.body.booking.id,
    });
    expect(
      await database.auditLog.count({ where: { action: "CARD_PRIZE_REDEEMED" } }),
    ).toBe(1);

    expect(await book(code, { slot: 3 })).toMatchObject({ ok: false, status: 422 });
    const listed = await listMyCardPrizes(customerId, NOW);
    expect(listed!.items[0]).toMatchObject({ status: "REDEEMED", voucherCode: null });
  });

  it("is spent by exactly one of many simultaneous bookings", async () => {
    const { prize, code } = await win(customerId, FREE_SLOT);
    const results = await Promise.all([0, 3, 6, 9].map((slot) => book(code, { slot })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await database.booking.count({ where: { status: "CONFIRMED" } })).toBe(1);
    expect((await prizeRow(prize.id)).status).toBe("REDEEMED");
  });

  it("comes back when the booking is refunded, and can be spent again", async () => {
    const { prize, code } = await win(customerId, FREE_SLOT);
    const booked = await book(code);
    if (!booked.ok) throw new Error(booked.message);
    await database.bookingEntitlement.create({
      data: {
        bookingId: booked.body.booking.id,
        userId: customerId,
        outcome: "OPEN",
        cause: "WEATHER",
        minutesLost: 30,
        evaluatedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
      },
    });

    const refundedAt = new Date(NOW.getTime() + 29 * DAY_MS);
    const refunded = await database.$transaction((tx) =>
      refundEntitledBooking(tx, {
        bookingId: booked.body.booking.id,
        actorUserId: customerId,
        automatic: false,
        now: refundedAt,
      }),
    );
    expect(refunded).toEqual({
      ok: true,
      paymentId: null,
      voucherId: null,
      prizeId: prize.id,
      minutesReturned: 0,
    });
    const restored = await prizeRow(prize.id);
    expect(restored).toMatchObject({ status: "ACTIVE", redeemedBookingId: null });
    // At least thirty days of life, as DV-111 restores a gift voucher.
    expect(restored.expiresAt.toISOString()).toBe(
      new Date(refundedAt.getTime() + 30 * DAY_MS).toISOString(),
    );
    expect(
      (
        await database.booking.findUniqueOrThrow({
          where: { id: booked.body.booking.id },
        })
      ).status,
    ).toBe("REFUNDED");

    expect((await book(code, { slot: 3 })).ok).toBe(true);
  });
});

describe("a discount prize on POST /bookings", () => {
  // A new account is a MEMBER, whose tier takes 10% off first; the prize's 20% comes
  // off what is left.
  const AFTER_TIER =
    PROVISIONAL_SLOT_PRICE_MINOR - Math.floor(PROVISIONAL_SLOT_PRICE_MINOR * 0.1);
  const DISCOUNTED = AFTER_TIER - Math.floor(AFTER_TIER * 0.2);

  it("takes its percentage off and the booking still pays", async () => {
    const { prize, code } = await win(customerId, DISCOUNT);
    const result = await book(code);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.booking).toMatchObject({
      status: "PENDING_PAYMENT",
      priceMinor: DISCOUNTED,
    });
    expect(result.body.paymentIntent).not.toBeNull();
    const payment = await database.payment.findUniqueOrThrow({
      where: { id: result.body.paymentIntent!.paymentId },
    });
    expect(payment.amountMinor).toBe(DISCOUNTED);
    expect(await prizeRow(prize.id)).toMatchObject({
      status: "REDEEMED",
      redeemedBookingId: result.body.booking.id,
    });
  });

  it("is refused together with loyalty points: a booking uses one reduction", async () => {
    const { code } = await win(customerId, DISCOUNT);
    const result = await reserveSlot({
      userId: customerId,
      request: {
        observatoryId,
        targetId,
        slotStartAt: slotStartAt(0).toISOString(),
        durationMinutes: SLOT_DURATION_MINUTES,
        voucherCode: code,
        loyaltyPoints: 100,
      },
      idempotencyKey: null,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, status: 422 });
  });

  it("comes back when the hold lapses", async () => {
    const { prize, code } = await win(customerId, DISCOUNT);
    const held = await book(code);
    if (!held.ok) throw new Error(held.message);

    // Another reservation at the observatory after the hold ran out expires it.
    const later = new Date(NOW.getTime() + 60 * 60_000);
    await book(undefined, { slot: 6, now: later });
    expect(await prizeRow(prize.id)).toMatchObject({
      status: "ACTIVE",
      redeemedBookingId: null,
    });
    expect((await prizeRow(prize.id)).expiresAt.toISOString()).toBe(prize.expiresAt);
  });

  it("comes back when the customer cancels the held booking", async () => {
    const { prize, code } = await win(customerId, DISCOUNT);
    const held = await book(code);
    if (!held.ok) throw new Error(held.message);
    const cancelled = await cancelMyBooking({
      userId: customerId,
      bookingId: held.body.booking.id,
      now: NOW,
    });
    expect(cancelled.ok).toBe(true);
    expect((await prizeRow(prize.id)).status).toBe("ACTIVE");
  });

  it("comes back when the payment fails", async () => {
    const { prize, code } = await win(customerId, DISCOUNT);
    const held = await book(code);
    if (!held.ok) throw new Error(held.message);
    const paymentId = held.body.paymentIntent!.paymentId;
    const settled = await settlePayment({
      provider: "SANDBOX",
      outcome: {
        paymentId,
        providerRef: `sbx_${paymentId.slice(0, 8)}`,
        result: "FAILED",
        amountMinor: DISCOUNTED,
        currency: "GEL",
        failureReason: "DECLINED",
      },
      now: NOW,
    });
    expect(settled.ok).toBe(true);
    expect((await prizeRow(prize.id)).status).toBe("ACTIVE");
  });

  it("comes back beside the money when the paid booking is refunded", async () => {
    const { prize, code } = await win(customerId, DISCOUNT);
    const held = await book(code);
    if (!held.ok) throw new Error(held.message);
    const paymentId = held.body.paymentIntent!.paymentId;
    const settled = await settlePayment({
      provider: "SANDBOX",
      outcome: {
        paymentId,
        providerRef: `sbx_${paymentId.slice(0, 8)}`,
        result: "CAPTURED",
        amountMinor: DISCOUNTED,
        currency: "GEL",
        failureReason: null,
      },
      now: NOW,
    });
    expect(settled.ok).toBe(true);
    expect((await prizeRow(prize.id)).status).toBe("REDEEMED");

    await database.bookingEntitlement.create({
      data: {
        bookingId: held.body.booking.id,
        userId: customerId,
        outcome: "OPEN",
        cause: "WEATHER",
        minutesLost: 30,
        evaluatedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
      },
    });
    const refunded = await database.$transaction((tx) =>
      refundEntitledBooking(tx, {
        bookingId: held.body.booking.id,
        actorUserId: customerId,
        automatic: false,
        now: NOW,
      }),
    );
    expect(refunded).toMatchObject({ ok: true, paymentId, prizeId: prize.id });
    expect(
      (await database.payment.findUniqueOrThrow({ where: { id: paymentId } })).status,
    ).toBe("REFUNDED");
    expect((await prizeRow(prize.id)).status).toBe("ACTIVE");
  });
});

describe("an observer-seat prize on POST /missions/{id}/observer-pack", () => {
  let missionId: string;
  let controllerId: string;

  beforeEach(async () => {
    controllerId = await createUser("Controller");
    const mission = await database.mission.create({
      data: {
        userId: controllerId,
        targetId,
        observatoryId,
        telescopeId,
        state: "OBSERVING",
        joinPolicy: "OPEN",
        observerCapacity: 10,
      },
    });
    missionId = mission.id;
  });

  const seat = (userId: string, voucherCode?: string) =>
    purchaseObserverPack({ missionId, userId, voucherCode, now: NOW });

  it("pays for the seat at no charge, with no payment, and spends the prize", async () => {
    const { prize, code } = await win(customerId, SEAT);
    const result = await seat(customerId, code);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(zObserverPackWithPaymentIntent.parse(result.value)).toEqual(result.value);
    expect(result.value.paymentIntent).toBeNull();
    expect(result.value.observerPack).toMatchObject({
      status: "PAID",
      priceMinor: 0,
      paymentId: null,
      holdExpiresAt: null,
    });
    expect(await prizeRow(prize.id)).toMatchObject({
      status: "REDEEMED",
      redeemedObserverPackId: result.value.observerPack.id,
    });
    expect(await database.payment.count()).toBe(0);

    // Asking again answers the same seat and spends nothing more.
    const again = await seat(customerId, code);
    expect(again.ok && again.value.observerPack.id).toBe(result.value.observerPack.id);
    expect(await database.observerPack.count()).toBe(1);
  });

  it("keeps the ten-seat cap, and a full session spends nothing", async () => {
    await database.mission.update({
      where: { id: missionId },
      data: { observerCapacity: 1 },
    });
    const buyer = await createUser("Buyer");
    expect((await seat(buyer)).ok).toBe(true);

    const { prize, code } = await win(customerId, SEAT);
    expect(await seat(customerId, code)).toMatchObject({
      ok: false,
      code: "OBSERVER_CAPACITY_REACHED",
    });
    expect((await prizeRow(prize.id)).status).toBe("ACTIVE");
  });

  it("fills exactly the seats left when prizes and sales race", async () => {
    await database.mission.update({
      where: { id: missionId },
      data: { observerCapacity: 3 },
    });
    const winners = await Promise.all(
      Array.from({ length: 4 }, (_, index) => createUser(`winner-${index}`)),
    );
    const prizes = [];
    for (const winner of winners) prizes.push({ winner, ...(await win(winner, SEAT)) });
    const buyers = await Promise.all(
      Array.from({ length: 4 }, (_, index) => createUser(`buyer-${index}`)),
    );

    const results = await Promise.all([
      ...prizes.map(({ winner, code }) => seat(winner, code)),
      ...buyers.map((buyer) => seat(buyer)),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(
      await database.observerPack.count({
        where: { missionId, status: { in: ["PAID", "PENDING_PAYMENT"] } },
      }),
    ).toBe(3);
    const spent = await database.cardPrize.count({ where: { status: "REDEEMED" } });
    expect(spent).toBe(results.slice(0, 4).filter((result) => result.ok).length);
  });

  it("refuses a prize of another kind, and a seat prize on POST /bookings", async () => {
    const { code: discount } = await win(customerId, DISCOUNT);
    expect(await seat(customerId, discount)).toMatchObject({ ok: false, status: 422 });

    const other = await createUser("Other");
    const { prize, code } = await win(other, SEAT);
    expect(await book(code, { userId: other })).toMatchObject({
      ok: false,
      status: 422,
      message: "This prize is an observer seat: spend it on a live session.",
    });
    // Nor can anybody else spend it on a seat.
    expect(await seat(customerId, code)).toMatchObject({ ok: false, status: 422 });
    expect((await prizeRow(prize.id)).status).toBe("ACTIVE");
  });

  it("refuses a prize for a seat already held awaiting payment", async () => {
    expect((await seat(customerId)).ok).toBe(true);
    const { prize, code } = await win(customerId, SEAT);
    expect(await seat(customerId, code)).toMatchObject({
      ok: false,
      status: 409,
      code: "CONFLICT",
    });
    expect((await prizeRow(prize.id)).status).toBe("ACTIVE");
  });
});
