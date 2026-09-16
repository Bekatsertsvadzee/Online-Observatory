import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ readViewingConditions: vi.fn() }));

vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({ VIEWING_CONDITIONS_MAX_AGE_MINUTES: 180 }),
}));
vi.mock("@/features/observatory/conditions", () => ({
  readViewingConditions: mocks.readViewingConditions,
}));

import { GET } from "./route";

const OBSERVATORY_ID = "00000000-0000-4000-8000-000000000010";

const read = (observatoryId: string) =>
  GET(new Request("https://darkview.test"), { params: Promise.resolve({ observatoryId }) });

beforeEach(() => {
  mocks.readViewingConditions.mockReset();
});

describe("GET /observatories/{observatoryId}/conditions", () => {
  it("answers a malformed id with 404 without reading anything", async () => {
    expect((await read("first-party")).status).toBe(404);
    expect(mocks.readViewingConditions).not.toHaveBeenCalled();
  });

  it("answers an observatory that is not bookable with 404", async () => {
    mocks.readViewingConditions.mockResolvedValueOnce(null);
    expect((await read(OBSERVATORY_ID)).status).toBe(404);
  });

  it("reads with the configured maximum age, and needs no session", async () => {
    const body = { observatoryId: OBSERVATORY_ID, date: "2026-12-15", items: [] };
    mocks.readViewingConditions.mockResolvedValueOnce(body);

    const response = await read(OBSERVATORY_ID);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body);
    expect(mocks.readViewingConditions).toHaveBeenCalledWith(OBSERVATORY_ID, expect.any(Date), 180);
  });
});
