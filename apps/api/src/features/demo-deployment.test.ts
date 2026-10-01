import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * ADR-035: the money guards and the REAL switch under DARKVIEW_DEPLOYMENT.
 *
 * No database. Each guard runs before any query, so a refusal is answered here; a
 * guard that lets the call through reaches the database, which throws a sentinel.
 */
const { environment } = vi.hoisted(() => ({
  environment: {
    NODE_ENV: "production" as string,
    DARKVIEW_DEPLOYMENT: "production" as "production" | "demo",
    APP_URL: "https://stellar.test",
    VOUCHER_CODE_SECRET: undefined as string | undefined,
  },
}));

const REACHED_DATABASE = "reached the database";

vi.mock("@/lib/validation/env", () => ({ getServerEnvironment: () => environment }));
vi.mock("@/lib/db/client", () => ({
  getDatabase: () =>
    new Proxy(
      {},
      {
        get: () => {
          throw new Error(REACHED_DATABASE);
        },
      },
    ),
}));

import { setObservatoryMode } from "@/features/admin/observatory";
import { reserveSlot } from "@/features/booking/reserve";
import { purchaseObserverPack } from "@/features/missions/observer-pack";
import { subscribe } from "@/features/subscriptions/subscriptions";
import { purchaseGiftVoucher } from "@/features/vouchers/vouchers";

const USER_ID = "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e01";
const OBSERVATORY_ID = "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e02";
const now = new Date("2026-10-01T20:00:00Z");

const guarded = {
  reserveSlot: () =>
    reserveSlot({
      userId: USER_ID,
      request: {} as Parameters<typeof reserveSlot>[0]["request"],
      idempotencyKey: null,
      now,
    }),
  subscribe: () =>
    subscribe({ userId: USER_ID, request: {} as Parameters<typeof subscribe>[0]["request"], now }),
  purchaseGiftVoucher: () =>
    purchaseGiftVoucher({
      userId: USER_ID,
      request: {} as Parameters<typeof purchaseGiftVoucher>[0]["request"],
      now,
    }),
  purchaseObserverPack: () =>
    purchaseObserverPack({ missionId: OBSERVATORY_ID, userId: USER_ID, now }),
};

afterEach(() => {
  environment.NODE_ENV = "production";
  environment.DARKVIEW_DEPLOYMENT = "production";
});

describe.each(Object.entries(guarded))("%s", (_name, call) => {
  it("refuses in production: no payment provider", async () => {
    await expect(call()).resolves.toMatchObject({
      ok: false,
      status: 500,
      code: "INTERNAL",
      message: expect.stringContaining("no payment provider is configured"),
    });
  });

  it("lets a demo through to the sandbox", async () => {
    environment.DARKVIEW_DEPLOYMENT = "demo";
    const outcome = await call().catch((error: Error) => error.message);
    // Past the guard: either the database was reached, or the next check (the
    // voucher secret) answered. Never the production refusal.
    expect(JSON.stringify(outcome)).not.toContain("no payment provider is configured");
    if (typeof outcome === "string") expect(outcome).toBe(REACHED_DATABASE);
  });
});

describe("setObservatoryMode on a demo", () => {
  const request = (mode: "REAL" | "SIMULATED") => ({
    observatoryId: OBSERVATORY_ID,
    actorUserId: USER_ID,
    request: { mode, reason: "first light", attendedOperatorPresent: true },
  });

  it("refuses REAL before anything else, even when attended", async () => {
    environment.DARKVIEW_DEPLOYMENT = "demo";
    await expect(setObservatoryMode(request("REAL"))).resolves.toEqual({
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: expect.stringContaining("demo"),
    });
  });

  it("still allows going back to SIMULATED", async () => {
    environment.DARKVIEW_DEPLOYMENT = "demo";
    await expect(setObservatoryMode(request("SIMULATED"))).rejects.toThrow(REACHED_DATABASE);
  });

  it("is not a demo refusal in production", async () => {
    await expect(setObservatoryMode(request("REAL"))).rejects.toThrow(REACHED_DATABASE);
  });
});
