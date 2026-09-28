import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getCurrentSession, getMissionWatchView } = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  getMissionWatchView: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentSession }));
vi.mock("@/features/missions/watch", () => ({ getMissionWatchView }));

import { GET } from "./route";

const USER_ID = "6f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const MISSION_ID = "22222222-2222-4222-8222-222222222222";

const session = {
  id: "session-1",
  expiresAt: new Date("2026-12-20T00:00:00.000Z"),
  csrfToken: "csrf-token-value",
  user: {
    id: USER_ID,
    email: "viewer@example.com",
    name: "Viewer",
    role: "USER" as const,
    locale: "en" as const,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  },
};

function call(missionId: string) {
  return GET(new Request(`https://darkview.test/missions/${missionId}/watch`), {
    params: Promise.resolve({ missionId }),
  });
}

describe("GET /missions/{missionId}/watch", () => {
  beforeEach(() => {
    getCurrentSession.mockReset();
    getMissionWatchView.mockReset();
  });

  it("answers 401 without a session", async () => {
    getCurrentSession.mockResolvedValue(null);
    const response = await call(MISSION_ID);
    expect(response.status).toBe(401);
    expect(getMissionWatchView).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed id without reading anything", async () => {
    getCurrentSession.mockResolvedValue(session);
    const response = await call("not-a-uuid");
    expect(response.status).toBe(404);
    expect(getMissionWatchView).not.toHaveBeenCalled();
  });

  it("answers 404 when the caller may not watch, as for a mission that does not exist", async () => {
    getCurrentSession.mockResolvedValue(session);
    getMissionWatchView.mockResolvedValue(null);
    const response = await call(MISSION_ID);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(getMissionWatchView).toHaveBeenCalledWith({
      missionId: MISSION_ID,
      actorId: USER_ID,
    });
  });

  it("returns the view to somebody allowed it", async () => {
    getCurrentSession.mockResolvedValue(session);
    const view = { mission: { id: MISSION_ID }, observerCount: 2, myObserverSeat: null };
    getMissionWatchView.mockResolvedValue(view);
    const response = await call(MISSION_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(view);
  });
});
