import "server-only";

import { randomInt, randomUUID } from "node:crypto";

import type {
  CardDraw,
  CardDrawCard,
  CardDrawOdds,
  CardPrize,
  CardPrizeList,
  CardRarity,
} from "@darkview/contracts";
import type { Prisma } from "@darkview/db";
import { recordAuditEvent } from "@darkview/db/audit";
import {
  deriveCardPrizeCode,
  hashVoucherCode,
  voucherCodeLast4,
} from "@darkview/db/vouchers";

import { findBookableObservatory } from "@/features/booking/observatories";
import { addDays, localDateOf, weekOf } from "@/features/votes/week";
import { getDatabase } from "@/lib/db/client";
import { localWallClockToUtc } from "@/lib/slots/darkness";
import { SLOT_DURATION_MINUTES } from "@/lib/slots/generate";
import { getServerEnvironment } from "@/lib/validation/env";

/**
 * The weekly card draw (ADR-060; the clients' ADR-058).
 *
 * A verified account is dealt three face-down cards a week at a first-party
 * observatory. What each card holds is decided here, when the deal is made, and
 * written down; the pick only turns a card that was already decided. The odds and
 * the weekly free-slot cap are the `CardDrawScheme` row, not constants.
 */

/** A uniform integer in [0, bound). Injected by tests; crypto-random otherwise. */
export type DrawInteger = (bound: number) => number;

const cryptoInteger: DrawInteger = (bound) => randomInt(bound);

const BASIS_POINTS = 10_000;
const CARDS = 3;

export type CardDrawScheme = {
  freeSlotChanceBp: number;
  observerSeatChanceBp: number;
  discountChanceBp: number;
  freeSlotsPerWeek: number;
  discountPercentOff: number;
  prizeValidDays: number;
};

const PRIZE_OF: Record<CardRarity, CardPrize["kind"] | null> = {
  LEGENDARY: "FREE_SLOT",
  EPIC: "OBSERVER_SEAT",
  RARE: "DISCOUNT",
  COMMON: null,
};

/** One card's rarity from one roll in [0, 10000), before the weekly cap. */
export function rarityOfRoll(scheme: CardDrawScheme, roll: number): CardRarity {
  let edge = scheme.freeSlotChanceBp;
  if (roll < edge) return "LEGENDARY";
  edge += scheme.observerSeatChanceBp;
  if (roll < edge) return "EPIC";
  edge += scheme.discountChanceBp;
  if (roll < edge) return "RARE";
  return "COMMON";
}

export async function readCardDrawScheme(
  reader: Pick<Prisma.TransactionClient, "cardDrawScheme">,
): Promise<CardDrawScheme> {
  return reader.cardDrawScheme.findUniqueOrThrow({ where: { id: 1 } });
}

export function toContractOdds(scheme: CardDrawScheme): CardDrawOdds {
  const common =
    BASIS_POINTS -
    scheme.freeSlotChanceBp -
    scheme.observerSeatChanceBp -
    scheme.discountChanceBp;
  const chances: [CardRarity, number][] = [
    ["LEGENDARY", scheme.freeSlotChanceBp],
    ["EPIC", scheme.observerSeatChanceBp],
    ["RARE", scheme.discountChanceBp],
    ["COMMON", common],
  ];
  return {
    cards: chances.map(([rarity, bp]) => ({
      rarity,
      prizeKind: PRIZE_OF[rarity],
      chance: bp / BASIS_POINTS,
    })),
    freeSlotsPerWeek: scheme.freeSlotsPerWeek,
    freeSlotDurationMinutes: SLOT_DURATION_MINUTES,
    discountPercentOff: scheme.discountPercentOff,
    prizeValidDays: scheme.prizeValidDays,
  };
}

export async function readCardDrawOdds(): Promise<CardDrawOdds> {
  return toContractOdds(await readCardDrawScheme(getDatabase()));
}

type PrizeRow = {
  id: string;
  kind: string;
  status: string;
  observatoryId: string;
  codeLast4: string;
  durationMinutes: number | null;
  percentOff: number | null;
  expiresAt: Date;
  redeemedBookingId: string | null;
  redeemedObserverPackId: string | null;
  createdAt: Date;
};

export function toContractPrize(row: PrizeRow, secret: string, now: Date): CardPrize {
  const expired = row.status === "ACTIVE" && row.expiresAt <= now;
  const status = (expired ? "EXPIRED" : row.status) as CardPrize["status"];
  return {
    id: row.id,
    kind: row.kind as CardPrize["kind"],
    status,
    observatoryId: row.observatoryId,
    voucherCode: status === "ACTIVE" ? deriveCardPrizeCode(secret, row.id) : null,
    codeLast4: row.codeLast4,
    durationMinutes: row.durationMinutes,
    percentOff: row.percentOff,
    expiresAt: row.expiresAt.toISOString(),
    redeemedBookingId: row.redeemedBookingId,
    redeemedObserverPackId: row.redeemedObserverPackId,
    createdAt: row.createdAt.toISOString(),
  };
}

const DRAW_INCLUDE = {
  cards: {
    orderBy: { position: "asc" },
    include: { target: { select: { slug: true } } },
  },
  prize: true,
} as const satisfies Prisma.CardDrawInclude;

type DrawRow = Prisma.CardDrawGetPayload<{ include: typeof DRAW_INCLUDE }>;

function toContractDraw(
  row: DrawRow,
  scheme: CardDrawScheme,
  secret: string,
  now: Date,
): CardDraw {
  const turned = row.pickedPosition !== null;
  const cards: CardDrawCard[] = row.cards.map((card) => ({
    position: card.position,
    turned,
    rarity: turned ? card.rarity : null,
    targetSlug: turned ? (card.target?.slug ?? null) : null,
    prize:
      turned && card.position === row.pickedPosition && row.prize
        ? toContractPrize(row.prize, secret, now)
        : null,
  }));
  return {
    id: row.id,
    observatoryId: row.observatoryId,
    week: row.week.toISOString().slice(0, 10),
    dealtAt: row.createdAt.toISOString(),
    opensNextAt: row.closesAt.toISOString(),
    picked: row.pickedPosition,
    pickedAt: row.pickedAt?.toISOString() ?? null,
    // Three rows, written together with the deal and keyed by position 0-2.
    cards: cards as CardDraw["cards"],
    odds: toContractOdds(scheme),
  };
}

export type CardDrawRefusal =
  | { kind: "not-found" }
  | { kind: "not-configured" }
  | { kind: "already-picked" }
  | { kind: "closed" };

export type CardDrawResult =
  { ok: true; draw: CardDraw } | { ok: false; refusal: CardDrawRefusal };

/**
 * A first-party observatory that can be booked, or null. A partner's telescope time is
 * not Stellar's to give away, so a partner observatory deals no cards.
 */
async function findDrawObservatory(observatoryId: string) {
  const observatory = await findBookableObservatory(observatoryId);
  if (!observatory) return null;
  const node = await getDatabase().observatoryNetworkNode.findFirst({
    where: { observatoryId, kind: "FIRST_PARTY" },
    select: { id: true },
  });
  return node ? observatory : null;
}

/**
 * Take one of the week's free slots for a dealt card, if any is left.
 *
 * A conditional increment on the week's row: two deals racing for the last slot
 * both reach the UPDATE, the second waits on the first's row lock and re-reads the
 * count, and only one of them finds it below the cap.
 */
async function takeFreeSlot(
  tx: Prisma.TransactionClient,
  observatoryId: string,
  week: Date,
  cap: number,
): Promise<boolean> {
  await tx.$executeRaw`
    INSERT INTO "CardDrawWeek" ("observatoryId", "week", "freeSlotsHeld")
    VALUES (${observatoryId}::uuid, ${week}::date, 0)
    ON CONFLICT DO NOTHING
  `;
  const taken = await tx.$executeRaw`
    UPDATE "CardDrawWeek" SET "freeSlotsHeld" = "freeSlotsHeld" + 1
    WHERE "observatoryId" = ${observatoryId}::uuid AND "week" = ${week}::date
      AND "freeSlotsHeld" < ${cap}
  `;
  return taken === 1;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}

/**
 * GET /card-draws/current: the caller's deal for the observatory's current week,
 * dealt now if this is the week's first read.
 */
export async function readCurrentCardDraw(input: {
  userId: string;
  observatoryId: string;
  now: Date;
  drawInteger?: DrawInteger;
}): Promise<CardDrawResult> {
  const { userId, now } = input;
  const drawInteger = input.drawInteger ?? cryptoInteger;
  const secret = getServerEnvironment().VOUCHER_CODE_SECRET;
  if (!secret) return { ok: false, refusal: { kind: "not-configured" } };

  const observatory = await findDrawObservatory(input.observatoryId);
  if (!observatory) return { ok: false, refusal: { kind: "not-found" } };

  const database = getDatabase();
  const weekIso = weekOf(localDateOf(now, observatory.timezone));
  const week = new Date(`${weekIso}T00:00:00Z`);
  const where = {
    userId_observatoryId_week: { userId, observatoryId: observatory.id, week },
  };

  const scheme = await readCardDrawScheme(database);
  const existing = await database.cardDraw.findUnique({ where, include: DRAW_INCLUDE });
  if (existing) return { ok: true, draw: toContractDraw(existing, scheme, secret, now) };

  const targets = await database.target.findMany({
    where: { enabled: true },
    orderBy: { slug: "asc" },
    select: { id: true },
  });

  try {
    const dealt = await database.$transaction(async (tx) => {
      const rarities: CardRarity[] = [];
      let capped = 0;
      for (let position = 0; position < CARDS; position += 1) {
        let rarity = rarityOfRoll(scheme, drawInteger(BASIS_POINTS));
        if (rarity === "LEGENDARY") {
          const held = await takeFreeSlot(
            tx,
            observatory.id,
            week,
            scheme.freeSlotsPerWeek,
          );
          // ADR-058 §4: once the week's free slots are spent, that card holds a discount.
          if (!held) {
            rarity = "RARE";
            capped += 1;
          }
        }
        rarities.push(rarity);
      }

      // Three different faces while the catalogue has three to give.
      const pool = targets.map((target) => target.id);
      const faces = rarities.map(() => {
        if (pool.length === 0)
          return targets.length ? targets[drawInteger(targets.length)].id : null;
        return pool.splice(drawInteger(pool.length), 1)[0];
      });

      const draw = await tx.cardDraw.create({
        data: {
          userId,
          observatoryId: observatory.id,
          week,
          closesAt: localWallClockToUtc(addDays(weekIso, 7), 0, observatory.timezone),
          isDemo: observatory.isDemo,
          cards: {
            create: rarities.map((rarity, position) => ({
              position,
              rarity,
              targetId: faces[position],
            })),
          },
        },
        include: DRAW_INCLUDE,
      });

      await recordAuditEvent(
        {
          category: "CARD_DRAW",
          action: "CARD_DRAW_DEALT",
          actorUserId: userId,
          entityType: "CardDraw",
          entityId: draw.id,
          detail: {
            observatoryId: observatory.id,
            week: weekIso,
            card0: rarities[0],
            card1: rarities[1],
            card2: rarities[2],
            freeSlotsCapped: capped,
          },
          isDemo: observatory.isDemo,
        },
        tx,
      );
      return draw;
    });
    return { ok: true, draw: toContractDraw(dealt, scheme, secret, now) };
  } catch (error) {
    // Two first reads raced: the other one dealt, and this one's transaction --
    // free-slot count included -- rolled back. Its deal is the week's deal.
    if (!isUniqueViolation(error)) throw error;
    const raced = await database.cardDraw.findUniqueOrThrow({
      where,
      include: DRAW_INCLUDE,
    });
    return { ok: true, draw: toContractDraw(raced, scheme, secret, now) };
  }
}

/**
 * POST /card-draws/{drawId}/pick: turn the card at `position`, and issue its prize in
 * the same transaction. The deal's row is locked first, so two picks of one deal
 * queue, and the second finds it picked.
 */
export async function pickCard(input: {
  userId: string;
  drawId: string;
  position: number;
  idempotencyKey: string | null;
  now: Date;
}): Promise<CardDrawResult> {
  const { userId, drawId, position, idempotencyKey, now } = input;
  const secret = getServerEnvironment().VOUCHER_CODE_SECRET;
  if (!secret) return { ok: false, refusal: { kind: "not-configured" } };

  const database = getDatabase();
  const scheme = await readCardDrawScheme(database);

  return database.$transaction(async (tx): Promise<CardDrawResult> => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "CardDraw"
      WHERE "id" = ${drawId}::uuid AND "userId" = ${userId}::uuid
      FOR UPDATE
    `;
    if (locked.length === 0) return { ok: false, refusal: { kind: "not-found" } };

    const draw = await tx.cardDraw.findUniqueOrThrow({
      where: { id: drawId },
      include: DRAW_INCLUDE,
    });

    if (draw.pickedPosition !== null) {
      if (idempotencyKey !== null && idempotencyKey === draw.pickIdempotencyKey) {
        return { ok: true, draw: toContractDraw(draw, scheme, secret, now) };
      }
      return { ok: false, refusal: { kind: "already-picked" } };
    }
    if (now >= draw.closesAt) return { ok: false, refusal: { kind: "closed" } };

    await tx.cardDraw.update({
      where: { id: drawId },
      data: {
        pickedPosition: position,
        pickedAt: now,
        pickIdempotencyKey: idempotencyKey,
      },
    });

    const card = draw.cards.find((candidate) => candidate.position === position)!;
    const kind = PRIZE_OF[card.rarity];
    let prize: { id: string; kind: string; expiresAt: Date } | null = null;
    if (kind) {
      const id = randomUUID();
      const code = deriveCardPrizeCode(secret, id);
      prize = await tx.cardPrize.create({
        data: {
          id,
          drawId,
          userId,
          observatoryId: draw.observatoryId,
          kind,
          codeHash: hashVoucherCode(code),
          codeLast4: voucherCodeLast4(code),
          durationMinutes: kind === "FREE_SLOT" ? SLOT_DURATION_MINUTES : null,
          percentOff: kind === "DISCOUNT" ? scheme.discountPercentOff : null,
          expiresAt: new Date(now.getTime() + scheme.prizeValidDays * 86_400_000),
          isDemo: draw.isDemo,
        },
        select: { id: true, kind: true, expiresAt: true },
      });
    }

    // A free slot left on a card nobody chose is the week's again.
    const unchosenFreeSlots = draw.cards.filter(
      (candidate) => candidate.position !== position && candidate.rarity === "LEGENDARY",
    ).length;
    if (unchosenFreeSlots > 0) {
      await tx.$executeRaw`
        UPDATE "CardDrawWeek"
        SET "freeSlotsHeld" = GREATEST("freeSlotsHeld" - ${unchosenFreeSlots}, 0)
        WHERE "observatoryId" = ${draw.observatoryId}::uuid AND "week" = ${draw.week}::date
      `;
    }

    await recordAuditEvent(
      {
        category: "CARD_DRAW",
        action: "CARD_DRAW_PICKED",
        actorUserId: userId,
        entityType: "CardDraw",
        entityId: drawId,
        detail: {
          position,
          rarity: card.rarity,
          prizeId: prize?.id ?? null,
          prizeKind: prize?.kind ?? null,
          prizeExpiresAt: prize?.expiresAt.toISOString() ?? null,
          freeSlotsReturned: unchosenFreeSlots,
        },
        isDemo: draw.isDemo,
      },
      tx,
    );

    const picked = await tx.cardDraw.findUniqueOrThrow({
      where: { id: drawId },
      include: DRAW_INCLUDE,
    });
    return { ok: true, draw: toContractDraw(picked, scheme, secret, now) };
  });
}

/** GET /prizes: the caller's prizes, newest first. Null when codes are not configured. */
export async function listMyCardPrizes(
  userId: string,
  now: Date,
): Promise<CardPrizeList | null> {
  const secret = getServerEnvironment().VOUCHER_CODE_SECRET;
  if (!secret) return null;
  const rows = await getDatabase().cardPrize.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return { items: rows.map((row) => toContractPrize(row, secret, now)) };
}

/**
 * A prize as a spender sees it: usable only by its winner, while ACTIVE and unexpired,
 * at the observatory of its deal. Every other code -- unknown, another account's,
 * spent, expired -- is null, so the caller answers them all the same way.
 */
export async function findSpendablePrize(
  reader: Pick<Prisma.TransactionClient, "cardPrize">,
  input: { codeHash: string; userId: string; now: Date },
) {
  const prize = await reader.cardPrize.findUnique({
    where: { codeHash: input.codeHash },
    select: {
      id: true,
      userId: true,
      kind: true,
      status: true,
      observatoryId: true,
      durationMinutes: true,
      percentOff: true,
      expiresAt: true,
    },
  });
  if (!prize || prize.userId !== input.userId) return null;
  if (prize.status !== "ACTIVE" || prize.expiresAt <= input.now) return null;
  return prize;
}

/**
 * Spend a prize on a booking or a pack: a conditional update, so two spends racing on
 * one code both reach it and only one finds it ACTIVE. Returns whether this one did.
 */
export async function claimPrize(
  tx: Prisma.TransactionClient,
  input: {
    prizeId: string;
    userId: string;
    now: Date;
    bookingId?: string;
    observerPackId?: string;
  },
): Promise<boolean> {
  const { count } = await tx.cardPrize.updateMany({
    where: {
      id: input.prizeId,
      userId: input.userId,
      status: "ACTIVE",
      expiresAt: { gt: input.now },
    },
    data: {
      status: "REDEEMED",
      redeemedAt: input.now,
      redeemedBookingId: input.bookingId ?? null,
      redeemedObserverPackId: input.observerPackId ?? null,
    },
  });
  return count === 1;
}
