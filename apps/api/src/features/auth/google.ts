import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { Locale } from "@darkview/contracts";
import { ensureLoyaltyAccount } from "@darkview/db/loyalty";

import { normalizedEmail } from "@/features/auth/authenticate";
import { recordAuthEvent } from "@/lib/auth/audit";
import { createSession } from "@/lib/auth/session";
import { getDatabase } from "@/lib/db/client";
import {
  AUTHENTICATION_POLICY,
  consumeLimit,
  requestActor,
  UNATTRIBUTED,
} from "@/lib/security/rate-limit";
import { getServerEnvironment } from "@/lib/validation/env";

/**
 * ADR-048: a customer signs in with Google.
 *
 * The authorisation-code flow, on this API alone. The client renders a link to
 * `/auth/google/start`; Google sends the browser back to `/auth/google/callback`
 * with a code; this API exchanges the code for Google's ID token over TLS, reads
 * the verified address from it, finds or creates the customer, and issues the
 * same session cookie a password sign-in does (ADR-016). No Google script runs in
 * the browser and the client secret never leaves this API.
 *
 * The ID token's signature is not checked here on purpose: it arrives in the body
 * of this API's own HTTPS request to Google's token endpoint, not from the
 * browser, so its origin is the TLS session. Its claims are checked -- issuer,
 * audience, expiry, a verified address -- because a token that is Google's can
 * still be for another client or stale.
 */

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
/** How long the visitor has to come back from Google. */
export const stateLifetimeSeconds = 10 * 60;

export const googleStateCookieName =
  process.env.NODE_ENV === "production" ? "__Host-darkview_google" : "darkview_google";

export type GoogleIdentity = {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
};

/** Trades the code Google issued for the identity in its ID token. */
export type ExchangeCode = (input: {
  code: string;
  redirectUri: string;
}) => Promise<GoogleIdentity>;

export function redirectUri(appUrl: string) {
  // Through the website's /api path, as every call to this API is (ADR-016 §4):
  // the session cookie is __Host- prefixed, so it must be set on the host the
  // browser is on, and that is APP_URL's.
  return new URL("/api/auth/google/callback", appUrl).toString();
}

/**
 * Where to send the browser, and the state to remember until it comes back.
 *
 * `state` is random and bound to this browser by the cookie that carries it, so a
 * callback with somebody else's code is refused (CSRF). The locale rides in the
 * cookie too: it is where the visitor goes afterwards, and Google does not relay it.
 */
export async function startGoogleSignIn(locale: Locale) {
  const { APP_URL, GOOGLE_CLIENT_ID } = getServerEnvironment();
  if (!GOOGLE_CLIENT_ID) return { ok: false as const, location: failed(locale) };

  // Per address, and only where the address is trustworthy: keyed on the
  // unattributed fallback this would be one bucket shared by every visitor, and
  // the sixth person to press the button anywhere would be turned away.
  const actor = await requestActor();
  if (actor !== UNATTRIBUTED && !(await consumeLimit(AUTHENTICATION_POLICY, "google", actor))) {
    await recordAuthEvent("RATE_LIMITED", { actor });
    return { ok: false as const, location: failed(locale) };
  }

  const state = randomBytes(24).toString("base64url");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri(APP_URL));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return { ok: true as const, location: url.toString(), stateCookie: signState(state, locale) };
}

/**
 * The browser is back from Google. Either a session is issued and the customer
 * lands in the app, or they land on the sign-in page with `error=google` -- one
 * outcome for every failure, because none of them is the visitor's to fix and a
 * reason on the URL would only be guessed at.
 */
export async function completeGoogleSignIn(
  input: { code: string | null; state: string | null; stateCookie: string | null },
  exchange: ExchangeCode = exchangeCodeWithGoogle,
): Promise<{ location: string }> {
  const remembered = readState(input.stateCookie);
  const locale = remembered?.locale ?? "en";
  if (
    !remembered ||
    !input.code ||
    !input.state ||
    !sameString(input.state, remembered.state)
  ) {
    return { location: failed(locale) };
  }

  let identity: GoogleIdentity;
  try {
    identity = await exchange({
      code: input.code,
      redirectUri: redirectUri(getServerEnvironment().APP_URL),
    });
  } catch {
    return { location: failed(locale) };
  }
  if (!identity.emailVerified) return { location: failed(locale) };

  const actor = await requestActor();
  const database = getDatabase();
  const email = normalizedEmail(identity.email);

  const linked = await database.user.findUnique({ where: { googleSubject: identity.subject } });
  // A deleted account keeps its row under a replacement address (ADR-044), and its
  // Google link was cleared with the rest of the identity; it is never revived.
  const byEmail = linked ? null : await database.user.findUnique({ where: { email } });
  if ((linked ?? byEmail)?.deletedAt) return { location: failed(locale) };

  let user = linked;
  if (!user && byEmail) {
    // The address is Google's word that this is the same person: Google verified it,
    // and the password account under it either verified it too or never got that far.
    user = await database.user.update({
      where: { id: byEmail.id },
      data: {
        googleSubject: identity.subject,
        emailVerifiedAt: byEmail.emailVerifiedAt ?? new Date(),
      },
    });
  }
  const created = !user;
  if (!user) {
    user = await database.$transaction(async (tx) => {
      const row = await tx.user.create({
        data: {
          name: identity.name?.trim() || email.split("@")[0]!,
          email,
          locale,
          googleSubject: identity.subject,
          emailVerifiedAt: new Date(),
        },
      });
      await ensureLoyaltyAccount(tx, row.id);
      return row;
    });
  }

  await createSession(user.id);
  if (created) await recordAuthEvent("REGISTERED", { userId: user.id, actor });
  await recordAuthEvent("LOGIN_SUCCEEDED", { userId: user.id, actor });
  return { location: `/${locale}/app` };
}

function failed(locale: Locale) {
  return `/${locale}/sign-in?error=google`;
}

// The state cookie: `state.locale.expiresAt.signature`, signed with AUTH_SECRET so
// a forged cookie cannot pair a forged state with itself.
function signState(state: string, locale: Locale) {
  const expiresAt = Math.floor(Date.now() / 1000) + stateLifetimeSeconds;
  const body = `${state}.${locale}.${expiresAt}`;
  return `${body}.${signature(body)}`;
}

function readState(cookie: string | null): { state: string; locale: Locale } | null {
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 4) return null;
  const [state, locale, expiresAt, mac] = parts as [string, string, string, string];
  if (!sameString(mac, signature(`${state}.${locale}.${expiresAt}`))) return null;
  if (Number(expiresAt) < Math.floor(Date.now() / 1000)) return null;
  if (locale !== "en" && locale !== "ka") return null;
  return { state, locale };
}

function signature(body: string) {
  return createHmac("sha256", getServerEnvironment().AUTH_SECRET).update(body).digest("base64url");
}

function sameString(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The real exchange, against Google. */
export const exchangeCodeWithGoogle: ExchangeCode = async ({ code, redirectUri }) => {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = getServerEnvironment();
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new Error("Google is not configured.");

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Google token endpoint answered ${response.status}.`);
  const body = (await response.json()) as { id_token?: unknown };
  if (typeof body.id_token !== "string") throw new Error("Google issued no ID token.");
  return identityFromIdToken(body.id_token, GOOGLE_CLIENT_ID);
};

/** The claims this API relies on, checked. Exported for the tests. */
export function identityFromIdToken(idToken: string, clientId: string): GoogleIdentity {
  const segments = idToken.split(".");
  if (segments.length !== 3) throw new Error("Malformed ID token.");
  const claims = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8")) as {
    iss?: unknown;
    aud?: unknown;
    exp?: unknown;
    sub?: unknown;
    email?: unknown;
    email_verified?: unknown;
    name?: unknown;
  };
  if (typeof claims.iss !== "string" || !ISSUERS.has(claims.iss)) throw new Error("Wrong issuer.");
  if (claims.aud !== clientId) throw new Error("Wrong audience.");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) throw new Error("Expired.");
  if (typeof claims.sub !== "string" || typeof claims.email !== "string") {
    throw new Error("No subject or address.");
  }
  return {
    subject: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === "string" ? claims.name : null,
  };
}
