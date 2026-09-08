import type { Prisma } from "./generated/prisma/client.ts";

/**
 * The one way anything in this repository decides that something has been asked
 * too often.
 *
 * It lives in `packages/db` for the reason `audit.ts` does: both services need
 * it. The API meters routes, the realtime service meters handshakes, and the
 * alternative is two implementations of a decision that is only correct when it
 * is made in one statement. Nothing here is Next-specific -- the caller supplies
 * the key, the policy and the clock.
 *
 * What is *not* here is who is asking. Deriving an actor from a request is a
 * transport question and the two services answer it differently, so each keeps
 * its own; this module never sees a header.
 */

/**
 * How much of something is allowed, and what happens when it is not.
 *
 * `blockMs` is deliberately separate from `windowMs`. A limiter that only counts
 * lets an attacker spend the full allowance every window forever; a block makes
 * exceeding the limit cost more than the attempt did.
 */
export type RateLimitPolicy = {
  limit: number;
  windowMs: number;
  blockMs: number;
};

/**
 * Anything that can run the statement below.
 *
 * Not a transaction client, and the type does not stop that -- nothing in Prisma
 * distinguishes them at this level -- so it is said here instead: a limiter
 * enrolled in a transaction forgets every attempt the transaction rolls back,
 * which is precisely the attempts an attacker is making. Pass the base client.
 */
export type RateLimitClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Count one attempt against `key` and say whether it may proceed.
 *
 * One statement. Reading the row, deciding in JavaScript and writing the answer
 * back loses attempts that arrive together: two requests both read count = 4,
 * both write 5, and the fifth and sixth attempts cost the attacker one. Twenty
 * parallel attempts against a limit of five were all admitted that way, with the
 * counter recording two of them. An attacker does not send passwords in series.
 *
 * So the read, the window roll, the increment and the block decision all happen
 * inside a single `INSERT ... ON CONFLICT DO UPDATE`, and the row Postgres
 * returns is the answer. Concurrent callers serialise on the row lock the upsert
 * already takes, so every attempt is counted exactly once.
 */
export async function consumeRateLimit(
  {
    key,
    policy,
    now = new Date(),
  }: { key: string; policy: RateLimitPolicy; now?: Date },
  client: RateLimitClient,
): Promise<boolean> {
  const windowStart = new Date(now.getTime() - policy.windowMs);
  const blockUntil = new Date(now.getTime() + policy.blockMs);
  const { limit } = policy;

  // Three cases, in this order, and the same order in all three assignments:
  //
  //   still blocked      nothing changes; the block is not extended by knocking
  //   window rolled      a fresh window, which a lapsed block also earns -- so a
  //                      block that ends before its window cannot re-block on the
  //                      very next attempt
  //   otherwise          count one attempt, and block if that passes the limit
  const [decided] = await client.$queryRaw<{ blockedUntil: Date | null }[]>`
    INSERT INTO "RateLimitBucket" ("key", "count", "windowStartedAt", "blockedUntil", "updatedAt")
    VALUES (${key}, 1, ${now}, NULL, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "RateLimitBucket"."blockedUntil" > ${now} THEN "RateLimitBucket"."count"
        WHEN "RateLimitBucket"."blockedUntil" IS NOT NULL THEN 1
        WHEN "RateLimitBucket"."windowStartedAt" <= ${windowStart} THEN 1
        ELSE "RateLimitBucket"."count" + 1
      END,
      "windowStartedAt" = CASE
        WHEN "RateLimitBucket"."blockedUntil" > ${now} THEN "RateLimitBucket"."windowStartedAt"
        WHEN "RateLimitBucket"."blockedUntil" IS NOT NULL THEN ${now}
        WHEN "RateLimitBucket"."windowStartedAt" <= ${windowStart} THEN ${now}
        ELSE "RateLimitBucket"."windowStartedAt"
      END,
      "blockedUntil" = CASE
        WHEN "RateLimitBucket"."blockedUntil" > ${now} THEN "RateLimitBucket"."blockedUntil"
        WHEN "RateLimitBucket"."blockedUntil" IS NOT NULL THEN NULL
        WHEN "RateLimitBucket"."windowStartedAt" <= ${windowStart} THEN NULL
        WHEN "RateLimitBucket"."count" + 1 > ${limit} THEN ${blockUntil}
        ELSE NULL
      END,
      "updatedAt" = ${now}
    RETURNING "blockedUntil"
  `;

  // Fail closed: no returned row means the statement did not do what it claims,
  // and an unproven attempt is not an allowed one.
  if (!decided) return false;

  return decided.blockedUntil === null || decided.blockedUntil <= now;
}
