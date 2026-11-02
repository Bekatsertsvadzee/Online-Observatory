import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getCurrentSession, listMissionTargets } = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  listMissionTargets: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentSession }));
vi.mock("@/features/missions/targets", () => ({ listMissionTargets }));

import { zMissionTargetList } from "@darkview/contracts/zod";

import { GET } from "./route";

const USER_ID = "6f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const MISSION_ID = "22222222-2222-4222-8222-222222222222";
const OBSERVATORY_ID = "33333333-3333-4333-8333-333333333333";

const session = {
  id: "session-1",
  expiresAt: new Date("2026-12-20T00:00:00.000Z"),
  csrfToken: "csrf-token-value",
  user: {
    id: USER_ID,
    email: "owner@example.com",
    name: "Owner",
    role: "USER" as const,
    locale: "en" as const,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  },
};

function call(missionId: string) {
  return GET(new Request(`https://darkview.test/missions/${missionId}/targets`), {
    params: Promise.resolve({ missionId }),
  });
}

describe("GET /missions/{missionId}/targets", () => {
  beforeEach(() => {
    getCurrentSession.mockReset();
    listMissionTargets.mockReset();
  });

  it("answers 401 without a session", async () => {
    getCurrentSession.mockResolvedValue(null);
    expect((await call(MISSION_ID)).status).toBe(401);
    expect(listMissionTargets).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed id without reading anything", async () => {
    getCurrentSession.mockResolvedValue(session);
    expect((await call("not-a-uuid")).status).toBe(404);
    expect(listMissionTargets).not.toHaveBeenCalled();
  });

  it("asks for the caller's own mission and passes a refusal through", async () => {
    getCurrentSession.mockResolvedValue(session);
    listMissionTargets.mockResolvedValue({
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: "No such mission.",
    });

    const response = await call(MISSION_ID);

    expect(response.status).toBe(404);
    expect(listMissionTargets).toHaveBeenCalledWith(
      expect.objectContaining({ missionId: MISSION_ID, userId: USER_ID }),
    );
  });

  it("answers the list in the contract's shape", async () => {
    getCurrentSession.mockResolvedValue(session);
    const list = {
      missionId: MISSION_ID,
      observatoryId: OBSERVATORY_ID,
      evaluatedAt: "2026-12-15T20:00:00.000Z",
      windowEndsAt: "2026-12-15T20:10:00.000Z",
      sessionEndsAt: "2026-12-15T21:00:00.000Z",
      currentTargetId: null,
      retargetAllowedAt: null,
      items: [],
    };
    listMissionTargets.mockResolvedValue({ ok: true, list });

    const response = await call(MISSION_ID);

    expect(response.status).toBe(200);
    expect(zMissionTargetList.parse(await response.json())).toEqual(list);
  });
});
