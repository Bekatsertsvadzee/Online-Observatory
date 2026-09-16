import { describe, expect, it } from "vitest";

import {
  deriveVoucherCode,
  hashVoucherCode,
  normaliseVoucherCode,
  voucherCodeLast4,
  voucherExpiry,
} from "@darkview/db/vouchers";

const SECRET = "s".repeat(32);
const ID = "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e01";

describe("gift voucher codes (DV-112)", () => {
  it("derives sixteen Crockford base32 characters in groups of four, the same every time", () => {
    const code = deriveVoucherCode(SECRET, ID);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(deriveVoucherCode(SECRET, ID)).toBe(code);
  });

  it("gives a different code for another voucher, or under another secret", () => {
    const code = deriveVoucherCode(SECRET, ID);
    expect(deriveVoucherCode(SECRET, "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e02")).not.toBe(
      code,
    );
    expect(deriveVoucherCode("t".repeat(32), ID)).not.toBe(code);
  });

  it("reads a code however it was typed, and hashes it to what was stored", () => {
    const code = deriveVoucherCode(SECRET, ID);
    const typed = ` ${code.toLowerCase().replace(/-/g, " ")} `;
    const normalised = normaliseVoucherCode(typed);
    expect(normalised).toBe(code.replace(/-/g, ""));
    expect(hashVoucherCode(normalised!)).toBe(hashVoucherCode(code));
    expect(voucherCodeLast4(code)).toBe(code.slice(-4));
  });

  it("reads the letters Crockford base32 confuses with digits as those digits", () => {
    expect(normaliseVoucherCode("OIL0-0000-0000-0000")).toBe("0110000000000000");
  });

  it("refuses input that cannot be a code", () => {
    expect(normaliseVoucherCode("ABCD-EFGH")).toBeNull();
    expect(normaliseVoucherCode("ABCD-EFGH-JKMN-PQRU")).toBeNull();
    expect(normaliseVoucherCode("ABCD-EFGH-JKMN-PQRST")).toBeNull();
  });

  it("expires twelve calendar months after payment", () => {
    expect(voucherExpiry(new Date("2026-09-16T10:00:00.000Z"))).toEqual(
      new Date("2027-09-16T10:00:00.000Z"),
    );
  });
});
