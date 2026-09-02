import { describe, expect, it } from "vitest";

import { authenticationCookieOptions } from "@/lib/auth/cookies";

describe("authentication cookie policy", () => {
  it("makes session cookies HTTP-only and same-site", () => {
    expect(authenticationCookieOptions(true)).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      priority: "high",
    });
  });

  it("keeps only the CSRF cookie readable by the browser", () => {
    expect(authenticationCookieOptions(false).httpOnly).toBe(false);
  });
});
