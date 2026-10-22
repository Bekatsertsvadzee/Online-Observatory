import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { zCardPrize } from "@darkview/contracts/zod";
import { deriveCardPrizeCode, deriveVoucherCode } from "@darkview/db/vouchers";

import { rarityOfRoll, toContractOdds, toContractPrize } from "./draw";

const SCHEME = {
  freeSlotChanceBp: 100,
  observerSeatChanceBp: 1000,
  discountChanceBp: 2500,
  freeSlotsPerWeek: 2,
  discountPercentOff: 20,
  prizeValidDays: 30,
};

const SECRET = "s".repeat(32);
const PRIZE_ID = "00000000-0000-4000-8000-000000000030";
const NOW = new Date("2026-12-15T12:00:00.000Z");

describe("a card's rarity (ADR-060)", () => {
  it("follows the configured odds over every roll", () => {
    const counts = { LEGENDARY: 0, EPIC: 0, RARE: 0, COMMON: 0 };
    for (let roll = 0; roll < 10_000; roll += 1) counts[rarityOfRoll(SCHEME, roll)] += 1;
    expect(counts).toEqual({ LEGENDARY: 100, EPIC: 1000, RARE: 2500, COMMON: 6400 });
  });

  it("holds nothing rarer when a chance is zero", () => {
    const none = {
      ...SCHEME,
      freeSlotChanceBp: 0,
      observerSeatChanceBp: 0,
      discountChanceBp: 0,
    };
    expect(rarityOfRoll(none, 0)).toBe("COMMON");
  });

  it("publishes chances that add up to one", () => {
    const odds = toContractOdds(SCHEME);
    expect(odds.cards.reduce((sum, entry) => sum + entry.chance, 0)).toBeCloseTo(1, 10);
    expect(odds.freeSlotDurationMinutes).toBe(30);
  });
});

describe("a prize as the contract shows it", () => {
  const row = {
    id: PRIZE_ID,
    kind: "DISCOUNT",
    status: "ACTIVE",
    observatoryId: "00000000-0000-4000-8000-000000000010",
    codeLast4: "ABCD",
    durationMinutes: null,
    percentOff: 20,
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    redeemedBookingId: null,
    redeemedObserverPackId: null,
    createdAt: NOW,
  };

  it("carries its code while it is spendable", () => {
    const prize = toContractPrize(row, SECRET, NOW);
    expect(zCardPrize.parse(prize)).toEqual(prize);
    expect(prize.voucherCode).toBe(deriveCardPrizeCode(SECRET, PRIZE_ID));
  });

  it("is EXPIRED past its expiry, and spent or expired shows no code", () => {
    expect(toContractPrize(row, SECRET, row.expiresAt)).toMatchObject({
      status: "EXPIRED",
      voucherCode: null,
    });
    expect(
      toContractPrize({ ...row, status: "REDEEMED" }, SECRET, NOW).voucherCode,
    ).toBeNull();
  });

  it("never shares a code with a gift voucher of the same id", () => {
    expect(deriveCardPrizeCode(SECRET, PRIZE_ID)).not.toBe(
      deriveVoucherCode(SECRET, PRIZE_ID),
    );
  });
});
