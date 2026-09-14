import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requestHeaders: { origin: "https://darkview.test" as string | null },
  getCurrentSession: vi.fn(),
  meterRequest: vi.fn(),
  getMyBooking: vi.fn(),
  cancelMyBooking: vi.fn(),
  getMyMission: vi.fn(),
  listMyMissions: vi.fn(),
  getTargetBySlug: vi.fn(),
  currentObservatoryId: vi.fn(),
  readPublicObservatoryStatus: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(mocks.requestHeaders.origin ? { origin: mocks.requestHeaders.origin } : {}),
}));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({ APP_URL: "https://darkview.test" }),
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/lib/security/rate-limit", () => ({
  meterRequest: mocks.meterRequest,
  BOOKING_POLICY: {},
}));
vi.mock("@/features/booking/manage", () => ({
  getMyBooking: mocks.getMyBooking,
  cancelMyBooking: mocks.cancelMyBooking,
}));
vi.mock("@/features/missions/mine", () => ({
  getMyMission: mocks.getMyMission,
  listMyMissions: mocks.listMyMissions,
}));
vi.mock("@/features/targets/catalogue", () => ({ getTargetBySlug: mocks.getTargetBySlug }));
vi.mock("@/lib/http/current-observatory", () => ({
  currentObservatoryId: mocks.currentObservatoryId,
}));
vi.mock("@/features/observatory/status", () => ({
  readPublicObservatoryStatus: mocks.readPublicObservatoryStatus,
}));

import { zPublicObservatoryStatus } from "@darkview/contracts/zod";

import { POST as cancelBooking } from "./bookings/[bookingId]/cancel/route";
import { GET as getBooking } from "./bookings/[bookingId]/route";
import { GET as getMission } from "./missions/[missionId]/route";
import { GET as getObservatoryState } from "./observatory/state/route";
import { GET as getTarget } from "./targets/[slug]/route";

const USER_ID = "6f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const BOOKING_ID = "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e01";
const OBSERVATORY_ID = "00000000-0000-4000-8000-000000000010";

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

const params = <T extends Record<string, string>>(value: T) => ({
  params: Promise.resolve(value),
});

const cancelRequest = (body?: string) =>
  new Request(`https://darkview.test/api/bookings/${BOOKING_ID}/cancel`, {
    method: "POST",
    ...(body === undefined ? {} : { body }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestHeaders.origin = "https://darkview.test";
  mocks.getCurrentSession.mockResolvedValue(session);
  mocks.meterRequest.mockResolvedValue(null);
});

describe("GET /bookings/{bookingId}", () => {
  it("answers 401 without a session", async () => {
    mocks.getCurrentSession.mockResolvedValueOnce(null);
    const response = await getBooking(new Request("https://darkview.test"), params({ bookingId: BOOKING_ID }));
    expect(response.status).toBe(401);
  });

  it("answers a malformed id with 404 without reading anything", async () => {
    const response = await getBooking(new Request("https://darkview.test"), params({ bookingId: "nope" }));
    expect(response.status).toBe(404);
    expect(mocks.getMyBooking).not.toHaveBeenCalled();
  });

  it("asks only for the caller's own booking, and answers someone else's with 404", async () => {
    mocks.getMyBooking.mockResolvedValueOnce(null);
    const response = await getBooking(new Request("https://darkview.test"), params({ bookingId: BOOKING_ID }));
    expect(mocks.getMyBooking).toHaveBeenCalledWith({ userId: USER_ID, bookingId: BOOKING_ID });
    expect(response.status).toBe(404);
  });
});

describe("POST /bookings/{bookingId}/cancel", () => {
  it("refuses a foreign Origin with 403", async () => {
    mocks.requestHeaders.origin = "https://attacker.test";
    const response = await cancelBooking(cancelRequest(), params({ bookingId: BOOKING_ID }));
    expect(response.status).toBe(403);
    expect(mocks.cancelMyBooking).not.toHaveBeenCalled();
  });

  it("accepts an absent body as a cancellation with no reason", async () => {
    mocks.cancelMyBooking.mockResolvedValueOnce({ ok: true, booking: { id: BOOKING_ID } });
    const response = await cancelBooking(cancelRequest(), params({ bookingId: BOOKING_ID }));
    expect(response.status).toBe(200);
    expect(mocks.cancelMyBooking).toHaveBeenCalledWith({
      userId: USER_ID,
      bookingId: BOOKING_ID,
      reason: undefined,
    });
  });

  it("passes a reason through", async () => {
    mocks.cancelMyBooking.mockResolvedValueOnce({ ok: true, booking: { id: BOOKING_ID } });
    await cancelBooking(cancelRequest('{"reason":"clouds"}'), params({ bookingId: BOOKING_ID }));
    expect(mocks.cancelMyBooking).toHaveBeenCalledWith(expect.objectContaining({ reason: "clouds" }));
  });

  it("answers 400 to a body that is not JSON", async () => {
    const response = await cancelBooking(cancelRequest("{not json"), params({ bookingId: BOOKING_ID }));
    expect(response.status).toBe(400);
  });

  it("passes the refusal of a paid booking through as 409", async () => {
    mocks.cancelMyBooking.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "A paid booking cannot be cancelled until refunds are available.",
    });
    const response = await cancelBooking(cancelRequest(), params({ bookingId: BOOKING_ID }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "CONFLICT" });
  });

  it("returns the meter's refusal before doing any work", async () => {
    mocks.meterRequest.mockResolvedValueOnce(new Response(null, { status: 429 }));
    const response = await cancelBooking(cancelRequest(), params({ bookingId: BOOKING_ID }));
    expect(response.status).toBe(429);
    expect(mocks.cancelMyBooking).not.toHaveBeenCalled();
  });
});

describe("GET /missions/{missionId}", () => {
  it("answers a malformed id with 404 without reading anything", async () => {
    const response = await getMission(new Request("https://darkview.test"), params({ missionId: "1" }));
    expect(response.status).toBe(404);
    expect(mocks.getMyMission).not.toHaveBeenCalled();
  });
});

describe("GET /targets/{slug}", () => {
  it("answers a slug the contract's pattern rejects with 404 without reading anything", async () => {
    const response = await getTarget(new Request("https://darkview.test"), params({ slug: "M 13" }));
    expect(response.status).toBe(404);
    expect(mocks.getTargetBySlug).not.toHaveBeenCalled();
  });
});

describe("GET /observatory/state", () => {
  it("answers 404 when no observatory is configured", async () => {
    mocks.currentObservatoryId.mockResolvedValueOnce(null);
    expect((await getObservatoryState()).status).toBe(404);
  });

  it("returns a body the contract's own schema accepts", async () => {
    mocks.currentObservatoryId.mockResolvedValueOnce(OBSERVATORY_ID);
    mocks.readPublicObservatoryStatus.mockResolvedValueOnce({
      observatoryId: OBSERVATORY_ID,
      mode: "SIMULATED",
      link: "OFFLINE",
      weather: {
        status: "UNKNOWN",
        source: "OPERATOR",
        holdActive: false,
        note: null,
        updatedAt: "2026-09-14T09:00:00.000Z",
      },
      missionInProgress: false,
      currentTargetName: null,
      lastSuccessfulMissionAt: null,
      updatedAt: "2026-09-14T09:00:00.000Z",
    });

    const response = await getObservatoryState();

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(() => zPublicObservatoryStatus.parse(body)).not.toThrow();
  });
});
