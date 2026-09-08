import { describe, expect, it } from "vitest";

import { consumeRateLimit, type RateLimitPolicy } from "@darkview/db/rate-limit";

const POLICY: RateLimitPolicy = { limit: 5, windowMs: 60_000, blockMs: 60_000 };

/**
 * What the limiter does when the database does not answer the way it must.
 *
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` always returns a row, so this
 * branch is unreachable in normal operation -- which is exactly why it is worth
 * a test. An unreachable branch nobody exercises is an assumption, not a
 * guarantee, and the assumption here is the one that decides whether an
 * unexplained database result admits an attempt or refuses it.
 */
describe("an attempt the database did not decide", () => {
  it("is refused", async () => {
    const noRows = { $queryRaw: async () => [] };

    expect(await consumeRateLimit({ key: "k", policy: POLICY }, noRows)).toBe(false);
  });

  it("is allowed when the database does decide, so the refusal above is not just a default", async () => {
    // Guards the guard: a `consumeRateLimit` that returned false unconditionally
    // would pass the assertion above while metering nothing correctly.
    const allowed = { $queryRaw: async () => [{ blockedUntil: null }] };

    expect(await consumeRateLimit({ key: "k", policy: POLICY }, allowed)).toBe(true);
  });
});
