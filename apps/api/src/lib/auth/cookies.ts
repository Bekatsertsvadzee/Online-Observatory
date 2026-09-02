export const sessionCookieName =
  process.env.NODE_ENV === "production" ? "__Host-darkview_session" : "darkview_session";

export const csrfCookieName =
  process.env.NODE_ENV === "production" ? "__Host-darkview_csrf" : "darkview_csrf";

export const sessionDurationSeconds = 60 * 60 * 24 * 7;

export function authenticationCookieOptions(httpOnly: boolean) {
  return {
    httpOnly,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    priority: "high" as const,
    maxAge: sessionDurationSeconds,
  };
}
