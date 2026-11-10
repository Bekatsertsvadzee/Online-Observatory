import { createHash } from "node:crypto";

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
 * Whether a link admitted with this token hash may keep its observatory.
 *
 * A token is checked at the handshake; a revoke or rotate reaches an open link as a
 * NOTIFY, which a reconnecting listener can miss. The periodic sweep asks this, so a
 * revoked agent is closed within one sweep however the notification fared (SR-03).
 */
export async function stillAdmitted(
  store: LinkStore,
  tokenHash: string,
  observatoryId: string,
): Promise<boolean> {
  const observatory = await store.findObservatoryByTokenHash(tokenHash);
  return observatory?.id === observatoryId;
}
