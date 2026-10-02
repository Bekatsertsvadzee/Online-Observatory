import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { closeRefundMinor } = await import("@/features/missions/close-refund");

const PAID_AT = new Date("2026-07-15T20:00:00.000Z");
const EXPIRES_AT = new Date("2026-07-15T20:30:00.000Z");
const MINUTE = 60_000;

function at(minutesAfterPaid: number): Date {
  return new Date(PAID_AT.getTime() + minutesAfterPaid * MINUTE);
}

describe("closeRefundMinor (ADR-036)", () => {
  it("returns the share of the price matching the time still to come", () => {
    // Thirty minutes bought, closed after ten: twenty of thirty come back.
    expect(
      closeRefundMinor({
        priceMinor: 1500,
        paidAt: PAID_AT,
        closedAt: at(10),
        expiresAt: EXPIRES_AT,
      }),
    ).toBe(1000);
  });

  it("returns the whole price for a close at the moment of payment", () => {
    expect(
      closeRefundMinor({
        priceMinor: 1500,
        paidAt: PAID_AT,
        closedAt: PAID_AT,
        expiresAt: EXPIRES_AT,
      }),
    ).toBe(1500);
  });

  it("rounds up to the whole tetri", () => {
    // 1000 × 20 ÷ 30 = 666.67, so 667 -- never rounded down against the observer.
    expect(
      closeRefundMinor({
        priceMinor: 1000,
        paidAt: PAID_AT,
        closedAt: at(10),
        expiresAt: EXPIRES_AT,
      }),
    ).toBe(667);
    // One millisecond left of thirty minutes still returns a tetri.
    expect(
      closeRefundMinor({
        priceMinor: 1500,
        paidAt: PAID_AT,
        closedAt: new Date(EXPIRES_AT.getTime() - 1),
        expiresAt: EXPIRES_AT,
      }),
    ).toBe(1);
  });

  it("does not round up a share that is already whole", () => {
    expect(
      closeRefundMinor({
        priceMinor: 1500,
        paidAt: PAID_AT,
        closedAt: at(20),
        expiresAt: EXPIRES_AT,
      }),
    ).toBe(500);
  });

  it("returns nothing when the close comes at the session's end", () => {
    expect(
      closeRefundMinor({
        priceMinor: 1500,
        paidAt: PAID_AT,
        closedAt: EXPIRES_AT,
        expiresAt: EXPIRES_AT,
      }),
    ).toBe(0);
  });

  it("returns nothing when the close comes after the session's end", () => {
    expect(
      closeRefundMinor({
        priceMinor: 1500,
        paidAt: PAID_AT,
        closedAt: at(45),
        expiresAt: EXPIRES_AT,
      }),
    ).toBe(0);
  });

  it("returns nothing for a seat paid at the session's end, without dividing by zero", () => {
    expect(
      closeRefundMinor({
        priceMinor: 1500,
        paidAt: EXPIRES_AT,
        closedAt: EXPIRES_AT,
        expiresAt: EXPIRES_AT,
      }),
    ).toBe(0);
    expect(
      closeRefundMinor({
        priceMinor: 1500,
        paidAt: EXPIRES_AT,
        closedAt: at(10),
        expiresAt: EXPIRES_AT,
      }),
    ).toBe(0);
  });

  it("never returns more than was paid, even for a close stamped before the payment", () => {
    expect(
      closeRefundMinor({
        priceMinor: 1500,
        paidAt: PAID_AT,
        closedAt: at(-5),
        expiresAt: EXPIRES_AT,
      }),
    ).toBe(1500);
  });

  it("returns nothing for a free seat", () => {
    expect(
      closeRefundMinor({
        priceMinor: 0,
        paidAt: PAID_AT,
        closedAt: at(10),
        expiresAt: EXPIRES_AT,
      }),
    ).toBe(0);
  });

  it("stays exact where a float would not", () => {
    // A price and a window large enough that price × remaining exceeds 2^53 ms·tetri.
    const paidAt = new Date(0);
    const expiresAt = new Date(9_000_000_000_007);
    const closedAt = new Date(3_000_000_000_000);
    const priceMinor = 2_000_003;
    const remaining = BigInt(expiresAt.getTime() - closedAt.getTime());
    const bought = BigInt(expiresAt.getTime() - paidAt.getTime());
    const expected = (BigInt(priceMinor) * remaining + bought - BigInt(1)) / bought;
    expect(closeRefundMinor({ priceMinor, paidAt, closedAt, expiresAt })).toBe(
      Number(expected),
    );
  });

  it("is never above the price and never negative, across a sweep of closes", () => {
    for (let ms = -MINUTE; ms <= 31 * MINUTE; ms += 7_919) {
      const refund = closeRefundMinor({
        priceMinor: 1500,
        paidAt: PAID_AT,
        closedAt: new Date(PAID_AT.getTime() + ms),
        expiresAt: EXPIRES_AT,
      });
      expect(Number.isInteger(refund)).toBe(true);
      expect(refund).toBeGreaterThanOrEqual(0);
      expect(refund).toBeLessThanOrEqual(1500);
    }
  });
});
