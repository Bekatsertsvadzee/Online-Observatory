import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * How long a minted stream URL stays usable.
 *
 * ADR-011 calls for a "short-expiry signed URL". Short enough that a `src`
 * attribute copied out of the page stops working in minutes, long enough that a
 * customer is not reconnecting every few seconds. The mission channel renews the
 * offer well before this elapses -- see STREAM_RENEWAL_LEAD_SECONDS -- so the
 * expiry is invisible to a client that is still subscribed, and final to one that
 * is not.
 */
export const STREAM_TOKEN_TTL_SECONDS = 300;

/**
 * How long before expiry the mission channel mints a replacement.
 *
 * Comfortably longer than a frame interval, so the renewed URL arrives many
 * frames before the current response is closed and the client can swap `src`
 * without a visible gap.
 */
export const STREAM_RENEWAL_LEAD_SECONDS = 60;

export type StreamGrant = {
  missionId: string;
  userId: string;
  expiresAt: Date;
};

/**
 * Mint a token naming exactly one viewer, one mission and one deadline.
 *
 * Signed rather than stored, so a token costs no row and no lookup -- there is
 * nothing to clean up when it lapses, and a service restart does not strand a
 * customer's open stream in a table.
 *
 * All three fields are inside the signature. `userId` in particular: without it
 * the token would prove only that *somebody* was granted this mission, and one
 * customer's URL would serve any other signed-in customer who obtained it.
 */
export function signStreamToken(grant: StreamGrant, secret: string): string {
  const payload = encodePayload(grant);
  return `${base64url(Buffer.from(payload, "utf8"))}.${sign(payload, secret)}`;
}

export type TokenVerdict =
  | { ok: true; grant: StreamGrant }
  | { ok: false; reason: string };

/**
 * Read a token back, or refuse it.
 *
 * The signature is compared with `timingSafeEqual`, not `===`. A byte-at-a-time
 * comparison leaks where the first difference is, and a signature is exactly the
 * kind of value an attacker can submit repeatedly while watching how long the
 * answer takes.
 *
 * The reason is for tests and logs and never reaches the client: the HTTP surface
 * answers 404 to every refusal alike, so nobody learns from the outside whether a
 * token was expired, forged, or for a different person.
 */
export function verifyStreamToken(
  token: string,
  secret: string,
  now: Date,
): TokenVerdict {
  const separator = token.indexOf(".");
  if (separator === -1) return { ok: false, reason: "malformed" };

  const encoded = token.slice(0, separator);
  const presented = token.slice(separator + 1);

  let payload: string;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const expected = sign(payload, secret);
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Length is checked first because timingSafeEqual throws on a mismatch. The
  // length of a base64url SHA-256 is a constant, so this reveals nothing.
  if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad signature" };
  }

  const parts = payload.split(":");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [missionId, userId, expiry] = parts;

  const expiresAt = new Date(Number(expiry) * 1000);
  if (Number.isNaN(expiresAt.getTime())) return { ok: false, reason: "malformed" };
  if (expiresAt <= now) return { ok: false, reason: "expired" };

  return { ok: true, grant: { missionId, userId, expiresAt } };
}

/**
 * `missionId:userId:expiry`.
 *
 * Unambiguous without escaping because both ids are UUIDs and the expiry is
 * digits: none of the three can contain a colon, so no pair of distinct grants
 * can encode to the same string. If either ever stops being a UUID this needs a
 * length prefix, which is why the assertion is stated rather than assumed.
 */
function encodePayload(grant: StreamGrant): string {
  const expiry = Math.floor(grant.expiresAt.getTime() / 1000);
  return `${grant.missionId}:${grant.userId}:${expiry}`;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}
