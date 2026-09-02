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

  const storedKey = Buffer.from(rawKey, "base64url");
  const derivedKey = await deriveKey(
    password,
    Buffer.from(rawSalt, "base64url"),
    storedKey.length,
    Number(rawCost),
    Number(rawBlockSize),
    Number(rawParallelization),
  );

  return storedKey.length === derivedKey.length && timingSafeEqual(storedKey, derivedKey);
}
