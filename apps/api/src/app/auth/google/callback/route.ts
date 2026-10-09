import { cookies } from "next/headers";

import { completeGoogleSignIn, googleStateCookieName } from "@/features/auth/google";

/**
 * GET /auth/google/callback?code=&state= -- ADR-048. The browser is back from
 * Google. The state cookie is spent either way, and the visitor lands in the app
 * or on the sign-in page with `error=google`.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const cookieStore = await cookies();
  const stateCookie = cookieStore.get(googleStateCookieName)?.value ?? null;
  cookieStore.set(googleStateCookieName, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  const { location } = await completeGoogleSignIn({
    code: query.get("code"),
    state: query.get("state"),
    stateCookie,
  });
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store" },
  });
}
