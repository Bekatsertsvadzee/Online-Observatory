import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { listSlotTargets } = vi.hoisted(() => ({ listSlotTargets: vi.fn() }));

vi.mock("@/features/targets/slot", () => ({ listSlotTargets }));

import { GET } from "./route";

const OBSERVATORY_ID = "00000000-0000-4000-8000-000000000010";
const START_AT = "2026-12-15T16:00:00.000Z";

function get(query: Record<string, string>) {
  const url = new URL("https://api.darkview.test/targets/visibility");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return GET(new Request(url));
}

const valid = { observatoryId: OBSERVATORY_ID, startAt: START_AT, durationMinutes: "30" };

beforeEach(() => {
  listSlotTargets.mockReset();
});

describe("GET /targets/visibility", () => {
  it("judges the named slot at the named observatory", async () => {
    const list = { observatoryId: OBSERVATORY_ID, startAt: START_AT, durationMinutes: 30, items: [] };
    listSlotTargets.mockResolvedValueOnce(list);

    const response = await get(valid);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(list);
    expect(listSlotTargets).toHaveBeenCalledWith(OBSERVATORY_ID, new Date(START_AT), 30);
  });

  it("answers 404 for an observatory that is not bookable", async () => {
    listSlotTargets.mockResolvedValueOnce(null);

    const response = await get(valid);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each([
    ["no observatory", { startAt: START_AT, durationMinutes: "30" }],
    ["an observatory that is not a uuid", { ...valid, observatoryId: "tbilisi" }],
    ["no start", { observatoryId: OBSERVATORY_ID, durationMinutes: "30" }],
    ["a start that is not a timestamp", { ...valid, startAt: "tonight" }],
    ["no length", { observatoryId: OBSERVATORY_ID, startAt: START_AT }],
    ["a length of zero", { ...valid, durationMinutes: "0" }],
    ["a fractional length", { ...valid, durationMinutes: "30.5" }],
    ["a length past the bound", { ...valid, durationMinutes: "241" }],
  ])("refuses %s with 422 and computes nothing", async (_, query) => {
    const response = await get(query);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(listSlotTargets).not.toHaveBeenCalled();
  });
});
