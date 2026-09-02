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

export async function requestActor() {
  const requestHeaders = await headers();
  const forwarded = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (forwarded || requestHeaders.get("x-real-ip") || "unknown").slice(0, 128);
}

export async function consumeAuthenticationLimit(
  scope: string,
  identity: string,
  now = new Date(),
) {
  const key = rateLimitKey(scope, identity);
  const database = getDatabase();
  const bucket = await database.rateLimitBucket.findUnique({ where: { key } });

  if (bucket?.blockedUntil && bucket.blockedUntil > now) return false;

  if (
    !bucket ||
    now.getTime() - bucket.windowStartedAt.getTime() >= authenticationPolicy.windowMs
  ) {
    await database.rateLimitBucket.upsert({
      where: { key },
      create: { key, count: 1, windowStartedAt: now },
      update: { count: 1, windowStartedAt: now, blockedUntil: null },
    });
    return true;
  }

  const nextCount = bucket.count + 1;
  const blockedUntil =
    nextCount > authenticationPolicy.limit
      ? new Date(now.getTime() + authenticationPolicy.blockMs)
      : null;

  await database.rateLimitBucket.update({
    where: { key },
    data: { count: nextCount, blockedUntil },
  });

  return blockedUntil === null;
}
