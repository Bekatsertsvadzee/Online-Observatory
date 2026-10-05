import { describe, expect, it, vi } from "vitest";

import { refuseRealHardwareInDemo, sandboxMoneyAllowed } from "./deployment";

describe("sandboxMoneyAllowed (ADR-035)", () => {
  it("allows the sandbox outside production, whatever the deployment", () => {
    expect(sandboxMoneyAllowed({ NODE_ENV: "development" })).toBe(true);
    expect(sandboxMoneyAllowed({ NODE_ENV: "test", DARKVIEW_DEPLOYMENT: "production" })).toBe(true);
    expect(sandboxMoneyAllowed({ NODE_ENV: "test", DARKVIEW_DEPLOYMENT: "demo" })).toBe(true);
  });

  it("refuses the sandbox in production", () => {
    expect(sandboxMoneyAllowed({ NODE_ENV: "production", DARKVIEW_DEPLOYMENT: "production" })).toBe(
      false,
    );
    // Unset is production: the schema's default, and the cautious reading.
    expect(sandboxMoneyAllowed({ NODE_ENV: "production" })).toBe(false);
  });

  it("allows the sandbox in a production build deployed as a demo", () => {
    expect(sandboxMoneyAllowed({ NODE_ENV: "production", DARKVIEW_DEPLOYMENT: "demo" })).toBe(true);
  });
});

describe("refuseRealHardwareInDemo (ADR-035)", () => {
  it("does not look at the database outside a demo", async () => {
    const count = vi.fn(async () => 1);
    await expect(refuseRealHardwareInDemo("production", count)).resolves.toBeUndefined();
    await expect(refuseRealHardwareInDemo(undefined, count)).resolves.toBeUndefined();
    expect(count).not.toHaveBeenCalled();
  });

  it("starts a demo with every observatory simulated", async () => {
    await expect(refuseRealHardwareInDemo("demo", async () => 0)).resolves.toBeUndefined();
  });

  it("refuses to start a demo while any observatory is in REAL mode", async () => {
    await expect(refuseRealHardwareInDemo("demo", async () => 2)).rejects.toThrow(
      /demo.*2 observatory\(ies\) are in REAL mode/,
    );
  });
});
