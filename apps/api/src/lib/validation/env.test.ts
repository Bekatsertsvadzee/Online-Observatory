import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getServerEnvironment } from "./env";

function stubRequired() {
  vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/stellar");
  vi.stubEnv("APP_URL", "https://stellar.test");
  vi.stubEnv("AUTH_SECRET", "auth-secret-that-is-at-least-32-characters");
  vi.stubEnv("RESEND_API_KEY", undefined);
  vi.stubEnv("EMAIL_FROM", undefined);
  vi.stubEnv("DARKVIEW_DEPLOYMENT", undefined);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the API environment (ADR-035)", () => {
  it("defaults DARKVIEW_DEPLOYMENT to production", () => {
    stubRequired();
    expect(getServerEnvironment().DARKVIEW_DEPLOYMENT).toBe("production");
  });

  it("accepts demo and refuses anything else", () => {
    stubRequired();
    vi.stubEnv("DARKVIEW_DEPLOYMENT", "demo");
    expect(getServerEnvironment().DARKVIEW_DEPLOYMENT).toBe("demo");
    vi.stubEnv("DARKVIEW_DEPLOYMENT", "staging");
    expect(() => getServerEnvironment()).toThrow(/DARKVIEW_DEPLOYMENT/);
  });

  it("takes RESEND_API_KEY and EMAIL_FROM together or not at all", () => {
    stubRequired();
    expect(() => getServerEnvironment()).not.toThrow();

    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    expect(() => getServerEnvironment()).toThrow(/set together/);

    vi.stubEnv("RESEND_API_KEY", undefined);
    vi.stubEnv("EMAIL_FROM", "Stellar <hello@stellar.test>");
    expect(() => getServerEnvironment()).toThrow(/set together/);

    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    expect(getServerEnvironment()).toMatchObject({
      RESEND_API_KEY: "re_test_key",
      EMAIL_FROM: "Stellar <hello@stellar.test>",
    });
  });

  it("refuses a sender that is not an address", () => {
    stubRequired();
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("EMAIL_FROM", "Stellar");
    expect(() => getServerEnvironment()).toThrow(/EMAIL_FROM/);
  });
});
