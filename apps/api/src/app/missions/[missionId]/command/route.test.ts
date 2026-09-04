import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getCurrentSession, requestHeaders, mintMissionCommand } = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  requestHeaders: { origin: "https://darkview.test" as string | null },
  mintMissionCommand: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentSession }));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(requestHeaders.origin ? { origin: requestHeaders.origin } : {}),
}));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({ APP_URL: "https://darkview.test" }),
}));
vi.mock("@/features/missions/command", async (importOriginal) => ({
  // The two refusals under test are pure functions and are exercised for real.
  // Only the part that needs a database is replaced.
  ...(await importOriginal<typeof import("@/features/missions/command")>()),
  mintMissionCommand,
}));

import { zMissionCommandAccepted } from "@darkview/contracts/zod";

import { POST } from "./route";

const USER_ID = "6f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const MISSION_ID = "22222222-2222-4222-8222-222222222222";

const session = {
  id: "session-1",
  expiresAt: new Date("2026-12-20T00:00:00.000Z"),
  csrfToken: "csrf-token-value",
  user: {
    id: USER_ID,
    email: "observer@example.com",
    name: "Observer",
    role: "USER" as const,
    locale: "en" as const,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  },
};

const accepted = {
  commandId: "33333333-3333-4333-8333-333333333333",
  missionId: MISSION_ID,
  type: "NUDGE" as const,
  issuedAt: "2026-12-15T20:00:00.000Z",
  expiresAt: "2026-12-15T20:00:30.000Z",
  status: "ACCEPTED" as const,
};

const nudge = {
  type: "NUDGE",
  nudge: {
    kind: "NUDGE",
    axis: "ALTITUDE",
    direction: "POSITIVE",
    stepArcminutes: 3,
  },
};

function request(body: unknown, origin: string | null = "https://darkview.test") {
  requestHeaders.origin = origin;
  return new Request(`https://darkview.test/missions/${MISSION_ID}/command`, {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ missionId: MISSION_ID }) };

describe("POST /missions/{missionId}/command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses an anonymous caller", async () => {
    getCurrentSession.mockResolvedValueOnce(null);
    const response = await POST(request(nudge), params);

    expect(response.status).toBe(401);
    expect(mintMissionCommand).not.toHaveBeenCalled();
  });

  it("refuses a cross-site POST before it looks at the session", async () => {
    const response = await POST(request(nudge, "https://evil.test"), params);

    expect(response.status).toBe(403);
    expect(getCurrentSession).not.toHaveBeenCalled();
  });

  /**
   * DV-058 acceptance criterion 1.
   *
   * Each of these is refused rather than stripped. The generated Zod drops unknown
   * keys (#15), so without this check a client sending someone else's sessionId
   * would be told its command succeeded -- having attempted to command as them.
   */
  it.each(["commandId", "sessionId", "userId", "issuedAt", "expiresAt"])(
    "refuses a body carrying %s",
    async (field) => {
      getCurrentSession.mockResolvedValueOnce(session);

      const response = await POST(request({ ...nudge, [field]: "anything" }), params);
      const body = (await response.json()) as { code: string; details: unknown };

      expect(response.status).toBe(422);
      expect(body.code).toBe("VALIDATION_FAILED");
      expect(body.details).toEqual({ rejectedFields: [field] });
      expect(mintMissionCommand).not.toHaveBeenCalled();
    },
  );

  it("names every envelope field the client tried to mint", async () => {
    getCurrentSession.mockResolvedValueOnce(session);

    const response = await POST(
      request({ ...nudge, commandId: "x", sessionId: "y", expiresAt: "z" }),
      params,
    );

    await expect(response.json()).resolves.toMatchObject({
      details: { rejectedFields: ["commandId", "sessionId", "expiresAt"] },
    });
  });

  /**
   * DV-058 acceptance criterion 2.
   */
  it.each(["GOTO", "FOCUS", "PARK", "SET_PROFILE"])(
    "refuses %s as not permitted for a client",
    async (type) => {
      getCurrentSession.mockResolvedValueOnce(session);

      const response = await POST(request({ type }), params);
      const body = (await response.json()) as { details: unknown };

      expect(response.status).toBe(403);
      expect(body.details).toEqual({
        rejectionReason: "COMMAND_NOT_PERMITTED_FOR_CLIENT",
      });
      expect(mintMissionCommand).not.toHaveBeenCalled();
    },
  );

  it("says not permitted rather than not a value", async () => {
    getCurrentSession.mockResolvedValueOnce(session);

    // The generated enum would call GOTO invalid. It is not invalid -- it is a real
    // command type that a customer may not ask for, and the answer should say so.
    const response = await POST(request({ type: "GOTO" }), params);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      message: "GOTO is never client-initiated.",
    });
  });

  it("still refuses a type that is not a command at all, as a schema error", async () => {
    getCurrentSession.mockResolvedValueOnce(session);

    const response = await POST(request({ type: "LAUNCH_ROCKET" }), params);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("accepts a well-formed nudge and answers 202 with a contract body", async () => {
    getCurrentSession.mockResolvedValueOnce(session);
    mintMissionCommand.mockResolvedValueOnce({ ok: true, accepted });

    const response = await POST(request(nudge), params);
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(() => zMissionCommandAccepted.parse(body)).not.toThrow();
  });

  it("passes the caller's identity, never the body's", async () => {
    getCurrentSession.mockResolvedValueOnce(session);
    mintMissionCommand.mockResolvedValueOnce({ ok: true, accepted });

    await POST(request(nudge), params);

    expect(mintMissionCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: MISSION_ID,
        actor: { id: USER_ID, role: "USER" },
      }),
    );
  });

  it("hides a mission id that is not a uuid behind a 404", async () => {
    getCurrentSession.mockResolvedValueOnce(session);

    const response = await POST(request(nudge), {
      params: Promise.resolve({ missionId: "not-a-uuid" }),
    });

    expect(response.status).toBe(404);
  });

  it("passes the domain's refusal through unchanged", async () => {
    getCurrentSession.mockResolvedValueOnce(session);
    mintMissionCommand.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "SESSION_NOT_OWNER",
      message: "Another session owns this mission.",
    });

    const response = await POST(request(nudge), params);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "SESSION_NOT_OWNER",
      message: "Another session owns this mission.",
    });
  });
});
