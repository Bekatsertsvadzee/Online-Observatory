import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { count } = vi.hoisted(() => ({ count: vi.fn(async () => 0) }));

vi.mock("@darkview/storage/config", () => ({ getStorageConfiguration: () => ({}) }));
vi.mock("@/lib/db/client", () => ({
  getDatabase: () => ({ observatory: { count } }),
}));

import { register } from "./instrumentation";

beforeEach(() => {
  count.mockReset();
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("API startup (ADR-035)", () => {
  it("does not query the database outside a demo", async () => {
    vi.stubEnv("DARKVIEW_DEPLOYMENT", undefined);
    await expect(register()).resolves.toBeUndefined();
    expect(count).not.toHaveBeenCalled();
  });

  it("starts a demo whose observatories are all simulated", async () => {
    vi.stubEnv("DARKVIEW_DEPLOYMENT", "demo");
    count.mockResolvedValueOnce(0);
    await expect(register()).resolves.toBeUndefined();
    expect(count).toHaveBeenCalledWith({ where: { mode: "REAL" } });
  });

  it("leaves the hardware test observatory out of the count (ADR-074)", async () => {
    vi.stubEnv("DARKVIEW_DEPLOYMENT", "demo");
    vi.stubEnv("DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID", "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e09");
    count.mockResolvedValueOnce(0);
    await expect(register()).resolves.toBeUndefined();
    expect(count).toHaveBeenCalledWith({
      where: { mode: "REAL", id: { not: "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e09" } },
    });
  });

  it("refuses to start a demo with an observatory in REAL mode", async () => {
    vi.stubEnv("DARKVIEW_DEPLOYMENT", "demo");
    count.mockResolvedValueOnce(1);
    await expect(register()).rejects.toThrow(/REAL mode/);
  });
});
