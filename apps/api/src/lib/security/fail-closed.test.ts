import { describe, expect, it } from "vitest";

import { consumeRateLimit, type RateLimitClient, type RateLimitPolicy } from "@darkview/db/rate-limit";

const POLICY: RateLimitPolicy = { limit: 5, windowMs: 60_000, blockMs: 60_000 };

/**
 * A client whose `$queryRaw` returns exactly these rows.
 *
 * The cast is narrow and unavoidable. `$queryRaw` is generic in its row type --
 * `<T>(...) => PrismaPromise<T>` -- and a stub that answers with fixed rows
 * cannot honestly claim to produce an arbitrary `T`, so no implementation
 * satisfies that signature without one. It is confined to this one expression
 * rather than applied to the whole client, which keeps the argument to
 * `consumeRateLimit` type-checked.
 */
function clientReturning(rows: unknown[]): RateLimitClient {
  return {
    $queryRaw: (() => Promise.resolve(rows)) as unknown as RateLimitClient["$queryRaw"],
  };
}

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
    expect(await consumeRateLimit({ key: "k", policy: POLICY }, clientReturning([]))).toBe(
      false,
    );
  });

  it("is allowed when the database does decide, so the refusal above is not just a default", async () => {
    // Guards the guard: a `consumeRateLimit` that returned false unconditionally
    // would pass the assertion above while metering nothing correctly.
    const decided = clientReturning([{ blockedUntil: null }]);

    expect(await consumeRateLimit({ key: "k", policy: POLICY }, decided)).toBe(true);
  });
});
