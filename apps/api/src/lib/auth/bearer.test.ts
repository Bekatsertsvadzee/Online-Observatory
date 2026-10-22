import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requestHeaders } = vi.hoisted(() => ({
  requestHeaders: new Map<string, string>(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(Object.fromEntries(requestHeaders)),
}));

import { requestBearerToken } from "@/lib/auth/bearer";

const token = "a".repeat(43);

beforeEach(() => requestHeaders.clear());

describe("requestBearerToken (ADR-061)", () => {
  it("is undefined without an Authorization header, so the cookies decide", async () => {
    await expect(requestBearerToken()).resolves.toBeUndefined();
  });

  it("reads a well-formed bearer token", async () => {
    requestHeaders.set("authorization", `Bearer ${token}`);
    await expect(requestBearerToken()).resolves.toBe(token);
  });

  it.each([
    ["another scheme", `Basic ${token}`],
    ["an empty bearer", "Bearer "],
    ["a token too short to be one we issued", "Bearer short"],
    ["a token with characters base64url never has", `Bearer ${token}==`],
    ["two tokens", `Bearer ${token} ${token}`],
  ])("is null, not a fallback to cookies, for %s", async (_name, value) => {
    requestHeaders.set("authorization", value);
    await expect(requestBearerToken()).resolves.toBeNull();
  });
});
