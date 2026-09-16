import { createHash, createHmac } from "node:crypto";

/**
 * Gift voucher codes (DV-112).
 *
 * Shared because the API hashes a code when the voucher is ordered and when one is
 * redeemed, and the realtime service derives the code again to write the email.
 *
 * **The code is never stored.** It is an HMAC of the voucher id under
 * VOUCHER_CODE_SECRET, so a copy of the database yields no usable code, and the
 * email can still be written when the outbox is delivered. Rotating the secret
 * changes every code not yet emailed, so it is not rotated while vouchers are
 * outstanding.
 *
 * Sixteen Crockford base32 characters -- 80 bits, with no I, L, O or U to misread
 * -- written in groups of four. Unguessable at any rate a limiter allows, which is
 * why the stored hash can be a plain SHA-256.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 16;

export function deriveVoucherCode(secret: string, voucherId: string): string {
  const digest = createHmac("sha256", secret)
    .update(`gift-voucher:${voucherId}`)
    .digest();
  let code = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of digest) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && code.length < CODE_LENGTH) {
      bits -= 5;
      code += ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
    if (code.length === CODE_LENGTH) break;
  }
  return code.match(/.{4}/g)!.join("-");
}

/**
 * A code as a customer typed it, reduced to its sixteen characters, or null when it
 * cannot be one. Case and separators are ignored, and the letters Crockford base32
 * reads as digits are read as digits.
 */
export function normaliseVoucherCode(input: string): string | null {
  const code = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (code.length !== CODE_LENGTH || code.includes("U")) return null;
  return code;
}

/** What `GiftVoucher.codeHash` holds, from a normalised or a derived code. */
export function hashVoucherCode(code: string): string {
  return createHash("sha256").update(code.replace(/-/g, "")).digest("hex");
}

export function voucherCodeLast4(code: string): string {
  return code.replace(/-/g, "").slice(-4);
}

/**
 * A voucher restored after a refund is usable for at least this long, however little
 * of its twelve months was left. A slot lost to weather in the voucher's last week
 * should not return a voucher that expires before the next clear night.
 */
export const RESTORED_VOUCHER_MIN_DAYS = 30;

/** Twelve calendar months after `from`: the life of a paid voucher. */
export function voucherExpiry(from: Date): Date {
  const expiry = new Date(from);
  expiry.setUTCMonth(expiry.getUTCMonth() + 12);
  return expiry;
}
