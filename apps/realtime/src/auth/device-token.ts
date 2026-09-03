import { createHash, timingSafeEqual } from "node:crypto";

import type { LinkStore, ObservatoryRecord } from "@/link/store";

/**
 * The device token is presented as `Authorization: Bearer <token>` on the
 * outbound WSS handshake. It is issued per observatory and lives only on the
 * observatory mini-PC and in cloud secret storage.
 *
 * Only its SHA-256 is stored or compared here, and the token is never returned,
 * logged or attached to an error. An observatory with no stored hash admits no
 * agent -- fail closed.
 */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function bearerTokenFrom(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer (.+)$/.exec(authorization.trim());
  return match ? match[1] : null;
}

export async function authenticateAgent(
  store: LinkStore,
  authorization: string | undefined,
): Promise<ObservatoryRecord | null> {
  const token = bearerTokenFrom(authorization);
  if (!token) return null;

  const presented = hashDeviceToken(token);
  const observatory = await store.findObservatoryByTokenHash(presented);
  if (!observatory) return null;

  return observatory;
}

/**
 * Constant-time comparison of two hashes. Used where a candidate hash is checked
 * against a known one rather than looked up, so that a rejection takes the same
 * time regardless of how much of the value matched.
 */
export function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
