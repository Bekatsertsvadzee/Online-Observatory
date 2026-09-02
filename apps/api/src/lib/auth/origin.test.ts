import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isSameOrigin } from "@/lib/auth/origin";

describe("same-origin policy", () => {
  it("accepts the configured application origin", () => {
    expect(isSameOrigin("https://darkview.ge", "https://darkview.ge/path")).toBe(true);
  });

  it.each([null, "https://attacker.example", "not a URL"])("rejects %s", (origin) => {
    expect(isSameOrigin(origin, "https://darkview.ge")).toBe(false);
  });
});
