import { PrismaPg } from "@prisma/adapter-pg";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase, requestHeaders, trustedProxyHops } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
  requestHeaders: { forwardedFor: null as string | null },
  trustedProxyHops: { value: 0 },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(
      requestHeaders.forwardedFor
        ? { "x-forwarded-for": requestHeaders.forwardedFor }
        : {},
    ),
}));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({
    AUTH_SECRET: "rate-limit-test-secret-value-0123456789",
    TRUSTED_PROXY_HOPS: trustedProxyHops.value,
  }),
}));

const { consumeAuthenticationLimit, requestActor } =
  await import("@/lib/auth/rate-limit");

/**
 * The authentication limiter is only worth anything under concurrency, and
 * concurrency is exactly what a mock cannot show. An earlier implementation read
 * the bucket, added one in JavaScript and wrote it back; against a real database
 * that admitted twenty of twenty parallel attempts on a limit of five and
 * recorded two of them. These tests exist so that cannot come back.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const LIMIT = 5;
const WINDOW_MS = 15 * 60 * 1000;
const PARALLEL_ATTEMPTS = 20;

/** Fixed instant: nothing here may depend on when the suite runs. */
const NOW = new Date("2026-12-15T12:00:00.000Z");

let database: PrismaClient;

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING, max: 32 }),
  });
  testDatabase.current = database;
  await database.$queryRaw`SELECT 1`;
});

beforeEach(async () => {
  await database.rateLimitBucket.deleteMany();
  requestHeaders.forwardedFor = null;
  trustedProxyHops.value = 0;
});

describe("the authentication limiter counts every attempt", () => {
  it("allows exactly the limit when attempts arrive one at a time", async () => {
    const results: boolean[] = [];
    for (let attempt = 0; attempt < PARALLEL_ATTEMPTS; attempt += 1) {
      results.push(await consumeAuthenticationLimit("sign-in", "victim", NOW));
    }

    expect(results.filter(Boolean)).toHaveLength(LIMIT);
    expect(results.slice(0, LIMIT).every(Boolean)).toBe(true);
  });

  it("allows the same number in parallel as it does in series", async () => {
    // This is the whole property. The previous implementation read the row, added
    // one in JavaScript and wrote it back, so concurrent attempts overwrote each
    // other: twenty parallel attempts were all admitted and the counter recorded
    // two. Arriving together must not buy an attacker a single extra attempt.
    const results = await Promise.all(
      Array.from({ length: PARALLEL_ATTEMPTS }, () =>
        consumeAuthenticationLimit("sign-in", "victim", NOW),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(LIMIT);

    const bucket = await database.rateLimitBucket.findFirstOrThrow();
    expect(bucket.blockedUntil).not.toBeNull();
    // Counting stops once the block is on: knocking does not extend it.
    expect(bucket.count).toBe(LIMIT + 1);
  });

  it("keeps refusing while the block stands, without extending it", async () => {
    for (let attempt = 0; attempt <= LIMIT; attempt += 1) {
      await consumeAuthenticationLimit("sign-in", "victim", NOW);
    }

    const blocked = await database.rateLimitBucket.findFirstOrThrow();

    const later = new Date(NOW.getTime() + 60_000);
    expect(await consumeAuthenticationLimit("sign-in", "victim", later)).toBe(false);

    const after = await database.rateLimitBucket.findFirstOrThrow();
    expect(after.blockedUntil).toEqual(blocked.blockedUntil);
  });

  it("gives a fresh window the moment a block lapses", async () => {
    for (let attempt = 0; attempt <= LIMIT; attempt += 1) {
      await consumeAuthenticationLimit("sign-in", "victim", NOW);
    }

    const blocked = await database.rateLimitBucket.findFirstOrThrow();
    const afterBlock = new Date(blocked.blockedUntil!.getTime() + 1);

    // Guards against a lockout loop: if the block is ever configured shorter than
    // the window, a lapsed block must still hand back a full allowance rather
    // than land on count+1 > limit and re-block on the very next attempt.
    expect(await consumeAuthenticationLimit("sign-in", "victim", afterBlock)).toBe(true);

    const bucket = await database.rateLimitBucket.findFirstOrThrow();
    expect(bucket.count).toBe(1);
    expect(bucket.blockedUntil).toBeNull();
  });

  it("starts a fresh window once the old one has passed", async () => {
    for (let attempt = 0; attempt <= LIMIT; attempt += 1) {
      await consumeAuthenticationLimit("sign-in", "victim", NOW);
    }

    const afterWindow = new Date(NOW.getTime() + WINDOW_MS + 1);
    expect(await consumeAuthenticationLimit("sign-in", "victim", afterWindow)).toBe(true);

    const bucket = await database.rateLimitBucket.findFirstOrThrow();
    expect(bucket.count).toBe(1);
    expect(bucket.blockedUntil).toBeNull();
  });

  it("separates scopes and identities", async () => {
    for (let attempt = 0; attempt <= LIMIT; attempt += 1) {
      await consumeAuthenticationLimit("sign-in", "victim", NOW);
    }

    expect(await consumeAuthenticationLimit("sign-in", "someone-else", NOW)).toBe(true);
    expect(await consumeAuthenticationLimit("register", "victim", NOW)).toBe(true);
  });
});

describe("who the limiter thinks is asking", () => {
  it("ignores X-Forwarded-For when no proxy is configured", async () => {
    // The left of that header is written by the caller. Reading it would let one
    // client mint a fresh bucket per request and never be limited at all.
    requestHeaders.forwardedFor = "203.0.113.9";
    expect(await requestActor()).toBe("unattributed");
  });

  it("does not let a spoofed chain buy extra attempts", async () => {
    const attempts: boolean[] = [];

    for (let attempt = 0; attempt <= LIMIT; attempt += 1) {
      requestHeaders.forwardedFor = `198.51.100.${attempt}`;
      const actor = await requestActor();
      attempts.push(await consumeAuthenticationLimit("sign-in", `${actor}:victim`, NOW));
    }

    expect(attempts.filter(Boolean)).toHaveLength(LIMIT);
    expect(attempts[LIMIT]).toBe(false);
  });

  it("reads the client from the right when a proxy is configured", async () => {
    trustedProxyHops.value = 1;
    requestHeaders.forwardedFor = "10.0.0.1, 203.0.113.9";

    // One proxy in front: it appended what it saw, which is the last entry.
    expect(await requestActor()).toBe("203.0.113.9");
  });

  it("refuses to attribute a chain shorter than the configured hops", async () => {
    trustedProxyHops.value = 2;
    requestHeaders.forwardedFor = "203.0.113.9";

    // Fewer hops than promised means the request did not arrive the way we were
    // told, so nothing in the header is trusted.
    expect(await requestActor()).toBe("unattributed");
  });
});
