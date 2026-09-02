import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function createOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function tokenMatchesHash(token: string, expectedHash: string) {
  const actual = Buffer.from(hashToken(token));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
