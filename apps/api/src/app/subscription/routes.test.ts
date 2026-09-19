import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requestHeaders: { origin: "https://darkview.test" as string | null },
  getCurrentSession: vi.fn(),
  meterRequest: vi.fn(),
  readSubscriptionPlans: vi.fn(),
  readMySubscription: vi.fn(),
  subscribe: vi.fn(),
  pauseMySubscription: vi.fn(),
  resumeMySubscription: vi.fn(),
  cancelMySubscription: vi.fn(),
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
  SUBSCRIPTION_POLICY: {},
}));
vi.mock("@/features/subscriptions/subscriptions", () => ({
  readSubscriptionPlans: mocks.readSubscriptionPlans,
  readMySubscription: mocks.readMySubscription,
  subscribe: mocks.subscribe,
  pauseMySubscription: mocks.pauseMySubscription,
  resumeMySubscription: mocks.resumeMySubscription,
  cancelMySubscription: mocks.cancelMySubscription,
}));

import { POST as cancel } from "./cancel/route";
import { POST as pause } from "./pause/route";
import { GET as listPlans } from "./plans/route";
import { POST as resume } from "./resume/route";
import { GET as getSubscription, POST as subscribeRoute } from "./route";

const USER_ID = "6f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";

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

const subscription = {
  subscriptionId: "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e01",
  plan: "OBSERVER",
  status: "ACTIVE",
  currentPeriodStart: "2026-12-15T12:00:00.000Z",
  currentPeriodEnd: "2027-01-15T12:00:00.000Z",
  cancelAtPeriodEnd: false,
  minuteBalance: 120,
  isDemo: false,
};

const subscribeRequest = (body: unknown) =>
  new Request("https://darkview.test/api/subscription", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestHeaders.origin = "https://darkview.test";
  mocks.getCurrentSession.mockResolvedValue(session);
  mocks.meterRequest.mockResolvedValue(null);
});

describe("the subscription surface", () => {
  it("serves the plan catalogue without a session", async () => {
    mocks.getCurrentSession.mockResolvedValue(null);
    mocks.readSubscriptionPlans.mockResolvedValue([]);

    const response = await listPlans();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });

  it("refuses every other route without a session", async () => {
    mocks.getCurrentSession.mockResolvedValue(null);

    for (const call of [
      getSubscription(),
      subscribeRoute(subscribeRequest({ plan: "OBSERVER" })),
      pause(),
      resume(),
      cancel(),
    ]) {
      expect((await call).status).toBe(401);
    }
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(mocks.cancelMySubscription).not.toHaveBeenCalled();
  });

  it("answers null for a customer who has never subscribed", async () => {
    mocks.readMySubscription.mockResolvedValue(null);

    const response = await getSubscription();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBeNull();
  });

  it("refuses a mutation from another origin, before metering it", async () => {
    mocks.requestHeaders.origin = "https://evil.test";

    const response = await subscribeRoute(subscribeRequest({ plan: "OBSERVER" }));

    expect(response.status).toBe(403);
    expect(mocks.meterRequest).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("is metered before anything is written", async () => {
    mocks.meterRequest.mockResolvedValue(new Response(null, { status: 429 }));

    expect((await subscribeRoute(subscribeRequest({ plan: "OBSERVER" }))).status).toBe(429);
    expect((await cancel()).status).toBe(429);
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(mocks.cancelMySubscription).not.toHaveBeenCalled();
  });

  it("refuses a body that is not a SubscribeRequest, including an unknown field", async () => {
    expect((await subscribeRoute(subscribeRequest("not json"))).status).toBe(400);
    expect((await subscribeRoute(subscribeRequest({ plan: "GOLD" }))).status).toBe(422);
    expect(
      (await subscribeRoute(subscribeRequest({ plan: "OBSERVER", priceMinor: 1 }))).status,
    ).toBe(422);
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("creates a subscription for the signed-in user and answers 201", async () => {
    mocks.subscribe.mockResolvedValue({
      ok: true,
      body: { subscription, paymentIntent: { paymentId: "p", provider: "SANDBOX", status: "PENDING" } },
    });

    const response = await subscribeRoute(subscribeRequest({ plan: "OBSERVER" }));

    expect(response.status).toBe(201);
    expect(mocks.subscribe).toHaveBeenCalledWith({
      userId: USER_ID,
      request: { plan: "OBSERVER" },
      now: expect.any(Date),
    });
  });

  it("passes a refusal through with the status the feature chose", async () => {
    mocks.pauseMySubscription.mockResolvedValue({
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "Only an active subscription can be paused.",
    });

    const response = await pause();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "CONFLICT" });
  });

  it("answers the changed subscription on pause, resume and cancel", async () => {
    for (const [route, feature] of [
      [pause, mocks.pauseMySubscription],
      [resume, mocks.resumeMySubscription],
      [cancel, mocks.cancelMySubscription],
    ] as const) {
      feature.mockResolvedValue({ ok: true, body: subscription });
      const response = await route();
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(subscription);
    }
  });
});
