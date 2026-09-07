import { createHash } from "node:crypto";

import type { ChannelUser, MissionChannelStore } from "@/mission/store";

/**
 * The browser session cookie's name, chosen the way the API chooses it.
 *
 * Duplicated from `apps/api/src/lib/auth/cookies.ts` rather than imported, for the
 * same reason `LIVE_MISSION_STATES` is duplicated: this service does not depend on
 * the Next.js app. If one changes the other must.
 *
 * **Exactly one name, never both.** The `__Host-` prefix is not decoration: it is
 * the browser's guarantee that the cookie was set by this exact host, over HTTPS,
 * with no `Domain` attribute -- so no sibling subdomain can forge one. Accepting
 * the unprefixed development name in production as well would hand that guarantee
 * back, because a subdomain may set `darkview_session` for `.darkview.ge` and the
 * browser would attach it to this handshake.
 *
 * It is also why the realtime service must be served from the same host as the web
 * app: a `__Host-` cookie set for `darkview.ge` never reaches `realtime.darkview.ge`.
 */
export function sessionCookieName(nodeEnv: string | undefined): string {
  return nodeEnv === "production" ? "__Host-darkview_session" : "darkview_session";
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

/**
 * Read one cookie out of a raw `Cookie` header.
 *
 * Hand-parsed because the alternative is a dependency for eleven lines, and
 * because the header is a fixed, simple grammar. Only the first occurrence of a
 * name is honoured: a request carrying the cookie twice is ambiguous, and taking
 * the last one would let an attacker-set duplicate override the real one.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }

  return null;
}

/**
 * Is this upgrade request coming from our own page?
 *
 * WebSocket handshakes are not subject to the same-origin policy and carry no
 * preflight, so a page on any origin can open a socket to this service and the
 * browser will attach the user's cookies to it. The `Origin` header is the only
 * thing that distinguishes our app from someone else's page, and checking it is
 * what stops cross-site WebSocket hijacking -- the socket equivalent of the CSRF
 * check `assertSameOrigin` performs on the API's mutations.
 *
 * A missing Origin is refused. Browsers always send one on a WebSocket handshake;
 * a request without one is not a browser, and this channel serves browsers.
 */
export function isAllowedOrigin(origin: string | undefined, appUrl: string): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Who is on the other end of this upgrade request, if anyone.
 *
 * Deliberately does not check the CSRF cookie the API's `getCurrentSession`
 * checks. That cookie defends form posts, where the browser attaches credentials
 * to a request another site composed; here the same defence is the Origin check
 * above, performed before this runs. Requiring the CSRF cookie as well would not
 * add a check -- it is readable by our own page's script and so by anything that
 * has already defeated the origin rule.
 */
export async function authenticateClient(
  store: MissionChannelStore,
  cookieHeader: string | undefined,
  now: Date,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): Promise<ChannelUser | null> {
  const token = readCookie(cookieHeader, sessionCookieName(nodeEnv));
  if (!token) return null;

  return store.findUserBySessionTokenHash(hashSessionToken(token), now);
}
