import { cookies } from "next/headers";

import {
  googleStateCookieName,
  startGoogleSignIn,
  stateLifetimeSeconds,
} from "@/features/auth/google";

/**
 * GET /auth/google/start?locale=ka -- ADR-048. Sends the browser to Google and
 * remembers the state it must come back with. A navigation, not a mutation: no
 * Origin check, because a browser following a link sends none, and nothing here
 * changes until the callback proves the state.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("locale");
  const locale = requested === "ka" ? "ka" : "en";

  const result = await startGoogleSignIn(locale);
  if (result.ok) {
    const cookieStore = await cookies();
    cookieStore.set(googleStateCookieName, result.stateCookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: stateLifetimeSeconds,
    });
  }
  return new Response(null, {
    status: 303,
    headers: { location: result.location, "cache-control": "no-store" },
  });
}
