import "server-only";

import { createHmac } from "node:crypto";
import { headers } from "next/headers";

import { getDatabase } from "@/lib/db/client";
import { getServerEnvironment } from "@/lib/validation/env";

type RateLimitPolicy = {
  limit: number;
  windowMs: number;
  blockMs: number;
};

const authenticationPolicy: RateLimitPolicy = {
  limit: 5,
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
};

function rateLimitKey(scope: string, identity: string) {
  return `${scope}:${createHmac("sha256", getServerEnvironment().AUTH_SECRET)
    .update(identity)
    .digest("base64url")}`;
}

/**
 * Who is asking, for rate-limiting purposes.
 *
 * `X-Forwarded-For` is a list the client starts and each proxy appends to, so the
 * leftmost entry is whatever the caller typed. Reading from that end lets anyone
 * mint a fresh rate-limit bucket per request by varying one header, which is the
 * same as having no limit at all.
 *
 * So the header is read from the right, and only as far as `TRUSTED_PROXY_HOPS`
 * says we actually have proxies. The default is zero: an unconfigured deployment
 * trusts nothing and falls back to a constant, which limits by account rather
 * than by address. That is deliberately the cautious direction -- it throttles a
 * real attack, at the cost of being able to throttle one abusive client
 * separately from everyone else. Set the variable once the proxy in front of this
 * is known.
 */
export async function requestActor() {
  const requestHeaders = await headers();
  const { TRUSTED_PROXY_HOPS } = getServerEnvironment();

  if (TRUSTED_PROXY_HOPS > 0) {
    const chain =
      requestHeaders
        .get("x-forwarded-for")
        ?.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean) ?? [];

    // The last hop is our own proxy; the one it saw is TRUSTED_PROXY_HOPS from
    // the end. A chain too short to contain it means the request did not arrive
    // the way we were told it would, so nothing in it is trusted.
    const client = chain[chain.length - TRUSTED_PROXY_HOPS];
    if (client) return client.slice(0, 128);
  }

  return "unattributed";
}

/**
 * Count one authentication attempt and say whether it may proceed.
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
export async function consumeAuthenticationLimit(
  scope: string,
  identity: string,
  now = new Date(),
) {
  const key = rateLimitKey(scope, identity);
  const windowStart = new Date(now.getTime() - authenticationPolicy.windowMs);
  const blockUntil = new Date(now.getTime() + authenticationPolicy.blockMs);
  const { limit } = authenticationPolicy;

  // Three cases, in this order, and the same order in all three assignments:
  //
  //   still blocked      nothing changes; the block is not extended by knocking
  //   window rolled      a fresh window, which a lapsed block also earns -- so a
  //                      block that ends before its window cannot re-block on the
  //                      very next attempt
  //   otherwise          count one attempt, and block if that passes the limit
  const [decided] = await getDatabase().$queryRaw<{ blockedUntil: Date | null }[]>`
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
