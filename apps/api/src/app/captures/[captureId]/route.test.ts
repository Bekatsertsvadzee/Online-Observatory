import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requestHeaders: { origin: "https://darkview.test" as string | null },
  getCurrentSession: vi.fn(),
  meterRequest: vi.fn(),
  getCapture: vi.fn(),
  setCaptureVisibility: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(
      mocks.requestHeaders.origin ? { origin: mocks.requestHeaders.origin } : {},
    ),
}));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({ APP_URL: "https://darkview.test" }),
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/lib/security/rate-limit", () => ({
  meterRequest: mocks.meterRequest,
  CAPTURE_VISIBILITY_POLICY: {},
}));
vi.mock("@/features/captures/collection", () => ({
  getCapture: mocks.getCapture,
  setCaptureVisibility: mocks.setCaptureVisibility,
}));

import { PATCH } from "./route";

const USER_ID = "6f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const CAPTURE_ID = "7a1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";

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

const patch = (body: unknown, captureId = CAPTURE_ID) =>
  PATCH(
    new Request(`https://darkview.test/api/captures/${captureId}`, {
      method: "PATCH",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ captureId }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestHeaders.origin = "https://darkview.test";
  mocks.getCurrentSession.mockResolvedValue(session);
  mocks.meterRequest.mockResolvedValue(null);
});

describe("PATCH /captures/{captureId}", () => {
  it("answers 401 without a session", async () => {
    mocks.getCurrentSession.mockResolvedValue(null);

    expect((await patch({ visibility: "GALLERY" })).status).toBe(401);
    expect(mocks.setCaptureVisibility).not.toHaveBeenCalled();
  });

  it("refuses another origin before metering", async () => {
    mocks.requestHeaders.origin = "https://evil.test";

    expect((await patch({ visibility: "GALLERY" })).status).toBe(403);
    expect(mocks.meterRequest).not.toHaveBeenCalled();
    expect(mocks.setCaptureVisibility).not.toHaveBeenCalled();
  });

  it("refuses a missing Origin", async () => {
    mocks.requestHeaders.origin = null;

    expect((await patch({ visibility: "GALLERY" })).status).toBe(403);
    expect(mocks.setCaptureVisibility).not.toHaveBeenCalled();
  });

  it("is metered before anything is written", async () => {
    mocks.meterRequest.mockResolvedValue(new Response(null, { status: 429 }));

    expect((await patch({ visibility: "GALLERY" })).status).toBe(429);
    expect(mocks.meterRequest).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "capture-visibility", identity: USER_ID }),
    );
    expect(mocks.setCaptureVisibility).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that is not a capture id", async () => {
    expect((await patch({ visibility: "PRIVATE" }, "not-a-uuid")).status).toBe(404);
    expect(mocks.setCaptureVisibility).not.toHaveBeenCalled();
  });

  it("refuses a body that is not a SetCaptureVisibilityRequest", async () => {
    expect((await patch("not json")).status).toBe(400);
    expect((await patch({ visibility: "PUBLIC" })).status).toBe(422);
    expect((await patch({})).status).toBe(422);
    expect((await patch({ visibility: "GALLERY", mode: "REAL" })).status).toBe(422);
    expect(mocks.setCaptureVisibility).not.toHaveBeenCalled();
  });

  it("sets the visibility for the signed-in user and answers the capture", async () => {
    const capture = { id: CAPTURE_ID, visibility: "GALLERY" };
    mocks.setCaptureVisibility.mockResolvedValue({ ok: true, capture });

    const response = await patch({ visibility: "GALLERY" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(capture);
    expect(mocks.setCaptureVisibility).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        captureId: CAPTURE_ID,
        visibility: "GALLERY",
      }),
    );
  });

  it("passes the feature's refusal through as an ApiError", async () => {
    mocks.setCaptureVisibility.mockResolvedValue({
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "A simulated capture cannot be published to the gallery.",
    });

    const response = await patch({ visibility: "GALLERY" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "CONFLICT" });
  });
});
