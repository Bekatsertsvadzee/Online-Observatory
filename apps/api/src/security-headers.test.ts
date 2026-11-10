import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

/**
 * Security review 2026-11-07, SR-12. `docs/security.md` asks for HSTS beside the
 * headers this API already sends; nothing in the stack sent it.
 */
describe("the API's response headers", () => {
  it("send HSTS, nosniff and frame protection on every path", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const everyPath = rules.find((rule) => rule.source === "/:path*");
    const headers = Object.fromEntries(
      (everyPath?.headers ?? []).map(({ key, value }) => [key.toLowerCase(), value]),
    );

    expect(headers["strict-transport-security"]).toMatch(/^max-age=\d{8,}/);
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
});
