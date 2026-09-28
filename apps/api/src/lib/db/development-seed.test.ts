import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  DEMO_ACCOUNT_PASSWORD,
  DEMO_ACCOUNT_PASSWORD_HASH,
  DEMO_AGENT_DEVICE_TOKEN,
  DEMO_CAPTURES,
  DEMO_IDS,
  DEMO_MISSIONS,
  DEMO_NIGHT_AGENT_DEVICE_TOKEN,
  assertDevelopmentSeedData,
} from "@darkview/db/development-seed";
import { verifyPassword } from "@/lib/auth/password";

describe("development seed data", () => {
  it("marks every seeded observation as demo and simulated", () => {
    expect(assertDevelopmentSeedData).not.toThrow();
    expect(
      DEMO_MISSIONS.every((mission) => mission.isDemo && mission.mode === "SIMULATED"),
    ).toBe(true);
    expect(
      DEMO_CAPTURES.every((capture) => capture.isDemo && capture.mode === "SIMULATED"),
    ).toBe(true);
  });

  it("uses unmistakable demo identifiers", () => {
    expect(DEMO_CAPTURES.every((capture) => capture.id.startsWith("CAP-DEMO-"))).toBe(
      true,
    );
  });
});

describe("the demo accounts' password (#145)", () => {
  it("is the plaintext of the hash the seed stores, by the API's own verifier", async () => {
    expect(await verifyPassword(DEMO_ACCOUNT_PASSWORD, DEMO_ACCOUNT_PASSWORD_HASH)).toBe(
      true,
    );
  });

  it("is long enough for the sign-up rule and says what it is", () => {
    expect(DEMO_ACCOUNT_PASSWORD.length).toBeGreaterThanOrEqual(12);
    expect(DEMO_ACCOUNT_PASSWORD).toContain("demo");
  });
});

describe("the night-side demo observatory (#146)", () => {
  it("has ids of its own", () => {
    const flat = Object.values(DEMO_IDS).flatMap((value) =>
      typeof value === "string" ? [value] : Object.values(value),
    );
    expect(new Set(flat).size).toBe(flat.length);
  });

  it("has its own unmistakably fake device token", () => {
    expect(DEMO_NIGHT_AGENT_DEVICE_TOKEN).not.toBe(DEMO_AGENT_DEVICE_TOKEN);
    expect(DEMO_NIGHT_AGENT_DEVICE_TOKEN).toContain("NOT-FOR-ANY-REAL-OBSERVATORY");
  });
});
