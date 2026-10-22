import "server-only";

import { headers } from "next/headers";

/**
 * The bearer token on this request: `undefined` when there is no Authorization header,
 * `null` when there is one that is not a well-formed bearer credential. ADR-061 §3: a
 * request with the header is judged by it alone, so a malformed one is no session at
 * all rather than a reason to fall back to the cookies.
 */
export async function requestBearerToken(): Promise<string | null | undefined> {
  const value = (await headers()).get("authorization");
  if (value === null) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(value.trim());
  return match ? match[1] : null;
}
