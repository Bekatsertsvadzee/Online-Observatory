import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getCurrentSession, requestHeaders, reserveSlot } = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  requestHeaders: { origin: "https://darkview.test" as string | null },
  reserveSlot: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentSession }));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(requestHeaders.origin ? { origin: requestHeaders.origin } : {}),
}));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({ APP_URL: "https://darkview.test" }),
}));
vi.mock("@/features/booking/reserve", () => ({ reserveSlot }));

import { zBookingWithPaymentIntent } from "@darkview/contracts/zod";

import { POST } from "./route";

const USER_ID = "6f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const TARGET_ID = "00000000-0000-4000-8000-000000000101";
const SLOT_START_AT = "2026-12-15T18:00:00.000Z";

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

const reserved = {
  booking: {
    id: "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e01",
    userId: USER_ID,
    targetId: TARGET_ID,
    slotStartAt: SLOT_START_AT,
    durationMinutes: 30,
    status: "PENDING_PAYMENT" as const,
    priceMinor: 4500,
    currency: "GEL" as const,
    paymentId: "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e02",
    missionId: null,
    createdAt: "2026-12-15T12:00:00.000Z",
  },
  paymentIntent: {
    paymentId: "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e02",
    provider: "SANDBOX" as const,
    status: "PENDING" as const,
    redirectUrl: null,
    expiresAt: "2026-12-15T12:15:00.000Z",
  },
};

function request(options: {
  body?: unknown;
  raw?: string;
  idempotencyKey?: string;
  origin?: string | null;
}) {
  requestHeaders.origin =
    options.origin === undefined ? "https://darkview.test" : options.origin;

  const headers = new Headers({ "content-type": "application/json" });
  if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);

  return new Request("https://darkview.test/bookings", {
    method: "POST",
    headers,
    body: options.raw ?? JSON.stringify(options.body ?? {}),
  });
}

const validBody = {
  targetId: TARGET_ID,
  slotStartAt: SLOT_START_AT,
  durationMinutes: 30,
};

describe("POST /bookings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses an anonymous caller with 401", async () => {
    getCurrentSession.mockResolvedValueOnce(null);

    const response = await POST(request({ body: validBody }));

    expect(response.status).toBe(401);
    expect(reserveSlot).not.toHaveBeenCalled();
  });

  it("refuses a cross-site POST before it looks at the session", async () => {
    // The session cookie would be attached by the browser regardless, so Origin is
    // the only thing separating a customer clicking Book from a page that is not us.
    const response = await POST(
      request({ body: validBody, origin: "https://evil.test" }),
    );

    expect(response.status).toBe(403);
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(reserveSlot).not.toHaveBeenCalled();
  });

  it("refuses a POST with no Origin header at all", async () => {
    const response = await POST(request({ body: validBody, origin: null }));

    expect(response.status).toBe(403);
    expect(reserveSlot).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    getCurrentSession.mockResolvedValueOnce(session);

    const response = await POST(request({ raw: "not json" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a body the contract's own schema refuses", async () => {
    getCurrentSession.mockResolvedValueOnce(session);

    const response = await POST(request({ body: { targetId: "not-a-uuid" } }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(reserveSlot).not.toHaveBeenCalled();
  });

  it("rejects a malformed idempotency key rather than ignoring it", async () => {
    getCurrentSession.mockResolvedValueOnce(session);

    // Too short for the contract's minLength. Dropping it silently would turn a
    // retry into a second booking, which is the whole point of the header.
    const response = await POST(request({ body: validBody, idempotencyKey: "short" }));

    expect(response.status).toBe(422);
    expect(reserveSlot).not.toHaveBeenCalled();
  });

  it("passes a well-formed idempotency key through to the domain", async () => {
    getCurrentSession.mockResolvedValueOnce(session);
    reserveSlot.mockResolvedValueOnce({ ok: true, replayed: false, body: reserved });

    await POST(request({ body: validBody, idempotencyKey: "booking-attempt-0001" }));

    expect(reserveSlot).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        idempotencyKey: "booking-attempt-0001",
      }),
    );
  });

  it("returns 201 and a body the contract accepts", async () => {
    getCurrentSession.mockResolvedValueOnce(session);
    reserveSlot.mockResolvedValueOnce({ ok: true, replayed: false, body: reserved });

    const response = await POST(request({ body: validBody }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(() => zBookingWithPaymentIntent.parse(body)).not.toThrow();
  });

  it("turns a lost race into a contract ApiError with the domain's status", async () => {
    getCurrentSession.mockResolvedValueOnce(session);
    reserveSlot.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "SLOT_UNAVAILABLE",
      message: "That slot has just been taken.",
    });

    const response = await POST(request({ body: validBody }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "SLOT_UNAVAILABLE",
      message: "That slot has just been taken.",
    });
  });

  it("never lets the caller name its own price", async () => {
    getCurrentSession.mockResolvedValueOnce(session);
    reserveSlot.mockResolvedValueOnce({ ok: true, replayed: false, body: reserved });

    const response = await POST(request({ body: { ...validBody, priceMinor: 1 } }));
    const body = (await response.json()) as typeof reserved;

    // The contract declares additionalProperties: false, but the generated Zod
    // strips unknown keys rather than rejecting them, so the guarantee has to be
    // asserted where it actually holds: nothing but the declared fields reaches
    // the domain, and the price on the way out is the server's.
    expect(reserveSlot).toHaveBeenCalledWith(
      expect.objectContaining({ request: validBody }),
    );
    expect(body.booking.priceMinor).toBe(reserved.booking.priceMinor);
  });
});
