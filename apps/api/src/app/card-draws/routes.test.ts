import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  getCurrentSession,
  requestHeaders,
  readCurrentCardDraw,
  pickCard,
  readCardDrawOdds,
} = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  requestHeaders: { origin: "https://darkview.test" as string | null },
  readCurrentCardDraw: vi.fn(),
  pickCard: vi.fn(),
  readCardDrawOdds: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentSession }));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(requestHeaders.origin ? { origin: requestHeaders.origin } : {}),
}));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({ APP_URL: "https://darkview.test" }),
}));
vi.mock("@/features/cards/draw", () => ({
  readCurrentCardDraw,
  pickCard,
  readCardDrawOdds,
}));

import { zCardDraw, zCardDrawOdds } from "@darkview/contracts/zod";

import { GET as getCurrent } from "./current/route";
import { GET as getOdds } from "./odds/route";
import { POST as postPick } from "./[drawId]/pick/route";

const OBSERVATORY_ID = "00000000-0000-4000-8000-000000000010";
const DRAW_ID = "00000000-0000-4000-8000-000000000020";
const USER_ID = "6f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";

const session = {
  id: "session-1",
  expiresAt: new Date("2026-12-20T00:00:00.000Z"),
  csrfToken: "csrf",
  user: {
    id: USER_ID,
    email: "observer@example.com",
    name: "Observer",
    role: "USER" as const,
    locale: "en" as const,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  },
};

const odds = {
  cards: [
    { rarity: "LEGENDARY", prizeKind: "FREE_SLOT", chance: 0.01 },
    { rarity: "EPIC", prizeKind: "OBSERVER_SEAT", chance: 0.1 },
    { rarity: "RARE", prizeKind: "DISCOUNT", chance: 0.25 },
    { rarity: "COMMON", prizeKind: null, chance: 0.64 },
  ],
  freeSlotsPerWeek: 2,
  freeSlotDurationMinutes: 30,
  discountPercentOff: 20,
  prizeValidDays: 30,
};

const draw = {
  id: DRAW_ID,
  observatoryId: OBSERVATORY_ID,
  week: "2026-12-14",
  dealtAt: "2026-12-15T12:00:00.000Z",
  opensNextAt: "2026-12-20T20:00:00.000Z",
  picked: null,
  pickedAt: null,
  cards: [0, 1, 2].map((position) => ({
    position,
    turned: false,
    rarity: null,
    targetSlug: null,
    prize: null,
  })),
  odds,
};

const current = (query: string) =>
  getCurrent(new Request(`https://darkview.test/card-draws/current?${query}`));
const pick = (body: unknown, headers: Record<string, string> = {}, drawId = DRAW_ID) =>
  postPick(
    new Request(`https://darkview.test/card-draws/${drawId}/pick`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ drawId }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  requestHeaders.origin = "https://darkview.test";
  getCurrentSession.mockResolvedValue(null);
  readCurrentCardDraw.mockResolvedValue({ ok: true, draw });
  pickCard.mockResolvedValue({ ok: true, draw });
  readCardDrawOdds.mockResolvedValue(odds);
});

describe("GET /card-draws/odds", () => {
  it("publishes the odds to anyone", async () => {
    const response = await getOdds();
    expect(response.status).toBe(200);
    expect(zCardDrawOdds.parse(await response.json())).toEqual(odds);
  });
});

describe("GET /card-draws/current", () => {
  it("needs a session, and so a verified account", async () => {
    expect((await current(`observatoryId=${OBSERVATORY_ID}`)).status).toBe(401);
    expect(readCurrentCardDraw).not.toHaveBeenCalled();
  });

  it("answers the caller's deal", async () => {
    getCurrentSession.mockResolvedValue(session);
    const response = await current(`observatoryId=${OBSERVATORY_ID}`);
    expect(response.status).toBe(200);
    expect(zCardDraw.parse(await response.json())).toEqual(draw);
    expect(readCurrentCardDraw).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, observatoryId: OBSERVATORY_ID }),
    );
  });

  it("refuses a malformed query, an observatory that deals no cards, and a deployment without codes", async () => {
    getCurrentSession.mockResolvedValue(session);
    expect((await current("observatoryId=nope")).status).toBe(422);
    readCurrentCardDraw.mockResolvedValue({ ok: false, refusal: { kind: "not-found" } });
    expect((await current(`observatoryId=${OBSERVATORY_ID}`)).status).toBe(404);
    readCurrentCardDraw.mockResolvedValue({
      ok: false,
      refusal: { kind: "not-configured" },
    });
    expect((await current(`observatoryId=${OBSERVATORY_ID}`)).status).toBe(503);
  });
});

describe("POST /card-draws/{drawId}/pick", () => {
  it("needs a session and the web client's origin", async () => {
    expect((await pick({ position: 0 })).status).toBe(401);
    getCurrentSession.mockResolvedValue(session);
    requestHeaders.origin = "https://elsewhere.test";
    expect((await pick({ position: 0 })).status).toBe(403);
    expect(pickCard).not.toHaveBeenCalled();
  });

  it("turns the caller's card and passes the Idempotency-Key through", async () => {
    getCurrentSession.mockResolvedValue(session);
    const response = await pick({ position: 2 }, { "idempotency-key": "pick-key-0001" });
    expect(response.status).toBe(200);
    expect(zCardDraw.parse(await response.json())).toEqual(draw);
    expect(pickCard).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        drawId: DRAW_ID,
        position: 2,
        idempotencyKey: "pick-key-0001",
      }),
    );
  });

  it("refuses a malformed request before it reaches the deal", async () => {
    getCurrentSession.mockResolvedValue(session);
    expect((await pick({ position: 0 }, {}, "nope")).status).toBe(404);
    expect((await pick({ position: 3 })).status).toBe(422);
    expect((await pick({})).status).toBe(422);
    expect((await pick({ position: 0 }, { "idempotency-key": "bad key" })).status).toBe(
      422,
    );
    expect(pickCard).not.toHaveBeenCalled();
  });

  it("names each refusal", async () => {
    getCurrentSession.mockResolvedValue(session);
    for (const [kind, status, code] of [
      ["already-picked", 409, "CARD_ALREADY_PICKED"],
      ["closed", 409, "CARD_DRAW_CLOSED"],
      ["not-found", 404, "NOT_FOUND"],
      ["not-configured", 503, "INTERNAL"],
    ] as const) {
      pickCard.mockResolvedValue({ ok: false, refusal: { kind } });
      const response = await pick({ position: 0 });
      expect(response.status).toBe(status);
      expect((await response.json()).code).toBe(code);
    }
  });
});
