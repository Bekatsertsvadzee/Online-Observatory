import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getCurrentSession, requestHeaders, readWeekVote, castVote } = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  requestHeaders: { origin: "https://darkview.test" as string | null },
  readWeekVote: vi.fn(),
  castVote: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentSession }));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(requestHeaders.origin ? { origin: requestHeaders.origin } : {}),
}));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({ APP_URL: "https://darkview.test" }),
}));
vi.mock("@/features/votes/week", () => ({ readWeekVote, castVote }));

import { zWeekVote } from "@darkview/contracts/zod";

import { GET, POST } from "./route";

const OBSERVATORY_ID = "00000000-0000-4000-8000-000000000010";
const TARGET_ID = "00000000-0000-4000-8000-000000000101";
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

const vote = {
  observatoryId: OBSERVATORY_ID,
  week: "2026-10-12",
  locksAt: "2026-10-18T13:00:00.000Z",
  candidates: [{ targetId: TARGET_ID, votes: 1 }],
  mine: TARGET_ID,
};

const get = (query: string) => GET(new Request(`https://darkview.test/votes?${query}`));
const post = (body: unknown) =>
  POST(
    new Request("https://darkview.test/votes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  requestHeaders.origin = "https://darkview.test";
  getCurrentSession.mockResolvedValue(null);
  readWeekVote.mockResolvedValue({ ok: true, vote });
  castVote.mockResolvedValue({ ok: true, vote });
});

describe("GET /votes", () => {
  it("answers the ballot to anyone, with no caller when there is no session", async () => {
    const response = await get(`observatoryId=${OBSERVATORY_ID}`);
    expect(response.status).toBe(200);
    expect(zWeekVote.parse(await response.json())).toEqual(vote);
    expect(readWeekVote).toHaveBeenCalledWith(
      expect.objectContaining({ observatoryId: OBSERVATORY_ID, week: undefined, callerId: null }),
    );
  });

  it("passes the caller through when the request carries a session", async () => {
    getCurrentSession.mockResolvedValue(session);
    await get(`observatoryId=${OBSERVATORY_ID}&week=2026-10-12`);
    expect(readWeekVote).toHaveBeenCalledWith(
      expect.objectContaining({ week: "2026-10-12", callerId: USER_ID }),
    );
  });

  it("refuses a malformed query, an unknown observatory and a week that is not a Monday", async () => {
    expect((await get("observatoryId=nope")).status).toBe(422);
    readWeekVote.mockResolvedValue({ ok: false, refusal: { kind: "not-found" } });
    expect((await get(`observatoryId=${OBSERVATORY_ID}`)).status).toBe(404);
    readWeekVote.mockResolvedValue({ ok: false, refusal: { kind: "not-monday" } });
    expect((await get(`observatoryId=${OBSERVATORY_ID}&week=2026-10-13`)).status).toBe(422);
  });
});

describe("POST /votes", () => {
  const body = { observatoryId: OBSERVATORY_ID, week: "2026-10-12", targetId: TARGET_ID };

  it("needs a session and the web client's origin", async () => {
    expect((await post(body)).status).toBe(401);
    getCurrentSession.mockResolvedValue(session);
    requestHeaders.origin = "https://elsewhere.test";
    expect((await post(body)).status).toBe(403);
    expect(castVote).not.toHaveBeenCalled();
  });

  it("casts the caller's vote and answers 201 with the ballot", async () => {
    getCurrentSession.mockResolvedValue(session);
    const response = await post(body);
    expect(response.status).toBe(201);
    expect(zWeekVote.parse(await response.json())).toEqual(vote);
    expect(castVote).toHaveBeenCalledWith(expect.objectContaining({ ...body, userId: USER_ID }));
  });

  it("names each refusal", async () => {
    getCurrentSession.mockResolvedValue(session);
    expect((await post({ ...body, targetId: "nope" })).status).toBe(422);
    for (const [kind, status, code] of [
      ["locked", 409, "VOTE_LOCKED"],
      ["not-a-candidate", 422, "TARGET_NOT_A_CANDIDATE"],
      ["not-found", 404, "NOT_FOUND"],
    ] as const) {
      castVote.mockResolvedValue({ ok: false, refusal: { kind } });
      const response = await post(body);
      expect(response.status).toBe(status);
      expect((await response.json()).code).toBe(code);
    }
  });
});
