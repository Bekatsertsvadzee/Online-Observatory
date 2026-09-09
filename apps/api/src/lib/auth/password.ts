import "server-only";

import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
const cost = 65_536;
const blockSize = 8;
const parallelization = 1;
const keyLength = 64;
const maxMemory = 128 * 1024 * 1024;

function deriveKey(
  password: string,
  salt: Buffer,
  length: number,
  N: number,
  r: number,
  p: number,
) {
  return new Promise<Buffer>((resolve, reject) => {
    nodeScrypt(password, salt, length, { N, r, p, maxmem: maxMemory }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(32);
  const key = await deriveKey(
    password,
    salt,
    keyLength,
    cost,
    blockSize,
    parallelization,
  );

  return [
    "scrypt",
    cost,
    blockSize,
    parallelization,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

/**
 * A stored scrypt parameter, or null if it is not one.
 *
 * `Number("x")` is `NaN` and `Number("")` is `0`, and both were previously handed
 * straight to the KDF, which rejects them -- so a single corrupt row turned every
 * sign-in attempt for that account into a 500 and a stack trace rather than the
 * ordinary wrong-password answer. An unusable stored hash is a failed
 * verification, not an outage.
 */
function storedInteger(raw: string) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Whether node's scrypt will accept these parameters.
 *
 * Checked here rather than caught around the derivation, so that each constraint
 * is a decision this file makes and a test can hold it to. A catch would cover
 * all four at once and prove none of them.
 *
 * The constraints are node's own: N a power of two above one, and two ceilings
 * that exist because scrypt's cost is memory. `128 * N * r` is the working set it
 * allocates, and `maxmem` is the ceiling this module sets on that.
 */
function parametersAreUsable(N: number, r: number, p: number) {
  const isPowerOfTwo = N > 1 && (N & (N - 1)) === 0;

  return (
    isPowerOfTwo &&
    128 * N * r <= maxMemory &&
    p <= ((2 ** 32 - 1) * 32) / (128 * r)
  );
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, rawCost, rawBlockSize, rawParallelization, rawSalt, rawKey] =
    encoded.split("$");

  if (
    algorithm !== "scrypt" ||
    !rawCost ||
    !rawBlockSize ||
    !rawParallelization ||
    !rawSalt ||
    !rawKey
  ) {
    return false;
  }

  const N = storedInteger(rawCost);
  const r = storedInteger(rawBlockSize);
  const p = storedInteger(rawParallelization);

  if (N === null || r === null || p === null) return false;
  if (!parametersAreUsable(N, r, p)) return false;

  // The parameters come from the stored hash rather than from the constants
  // above, so raising `cost` for new passwords leaves existing ones verifiable.
  const storedKey = Buffer.from(rawKey, "base64url");
  const derivedKey = await deriveKey(
    password,
    Buffer.from(rawSalt, "base64url"),
    storedKey.length,
    N,
    r,
    p,
  );

  return storedKey.length === derivedKey.length && timingSafeEqual(storedKey, derivedKey);
}
