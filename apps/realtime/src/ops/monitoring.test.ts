import { describe, expect, it } from "vitest";

import { monitoringOptions } from "@darkview/monitoring/options";
import { SCRUBBED, scrubEvent, scrubText } from "@darkview/monitoring/scrub";

/** ADR-064: nothing is sent unless configured, and nothing personal is ever sent. */
describe("error reporting", () => {
  it("is off when SENTRY_DSN is unset or blank", () => {
    expect(monitoringOptions({})).toBeNull();
    expect(monitoringOptions({ SENTRY_DSN: "  " })).toBeNull();
  });

  it("sends no default PII, no traces, and names the deployment", () => {
    const options = monitoringOptions({
      SENTRY_DSN: "http://public@127.0.0.1:8999/1",
      DARKVIEW_DEPLOYMENT: "demo",
    });
    expect(options).toMatchObject({
      dsn: "http://public@127.0.0.1:8999/1",
      environment: "demo",
      sendDefaultPii: false,
      tracesSampleRate: 0,
    });
    expect(
      monitoringOptions({ SENTRY_DSN: "x", SENTRY_ENVIRONMENT: "production" })
        ?.environment,
    ).toBe("production");
  });

  it.each([
    ["an email address", "no account for nika@example.com", "nika@example.com"],
    ["a bearer value", "Authorization: Bearer abc.def-ghi", "abc.def-ghi"],
    ["a token in a query", "GET /verify?token=s3cr3tvalue&x=1", "s3cr3tvalue"],
    ["a password field", '{"password":"hunter2"}', "hunter2"],
    [
      "a device token",
      "token 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "9f86d0",
    ],
    ["a JSON web token", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123", "eyJhbGci"],
    // Security review 2026-11-07, SR-19: a client address quoted in a message.
    ["an IPv4 address", "x-forwarded-for: 203.0.113.7, 10.0.0.2", "203.0.113.7"],
    ["a full IPv6 address", "from 2001:0db8:85a3:0000:0000:8a2e:0370:7334", "8a2e:0370"],
    ["a compressed IPv6 address", "client 2001:db8::1 refused", "2001:db8::1"],
  ])("removes %s from text", (_label, text, secret) => {
    const scrubbed = scrubText(text);
    expect(scrubbed).not.toContain(secret);
    expect(scrubbed).toContain(SCRUBBED);
  });

  it("keeps file paths, which a stack needs", () => {
    const path =
      "/Users/nika/Desktop/Stellar Observatory/part-1-worktrees/idle-db/apps/realtime/src/conditions/forecast.ts:89";
    expect(scrubText(path)).toBe(path);
  });

  it("keeps times of day, versions and timestamps, which are not addresses", () => {
    const text = "next 16.4.2 at 2026-11-07T20:11:50.110Z (00:12:25) took 1.2.3s";
    expect(scrubText(text)).toBe(text);
  });

  it("keeps what is needed to find the fault", () => {
    expect(
      scrubText("mission 3f1c2a9e-5b6d-4c7e-8f90-a1b2c3d4e5f6 failed: SLEW_TIMEOUT"),
    ).toBe("mission 3f1c2a9e-5b6d-4c7e-8f90-a1b2c3d4e5f6 failed: SLEW_TIMEOUT");
  });

  it("strips the user, cookies, body, query and every header but the user agent", () => {
    const event = scrubEvent({
      message: "sign-in failed for a@b.co",
      user: { email: "a@b.co", ip_address: "1.2.3.4" },
      server_name: "nika-mbp",
      request: {
        url: "https://stellar.astroman.ge/api/auth/verify-email?token=abc#x",
        method: "POST",
        headers: {
          "user-agent": "Mozilla/5.0",
          cookie: "__Host-dv=1",
          authorization: "Bearer x",
        },
        cookies: { "__Host-dv": "1" },
        data: '{"password":"p"}',
        query_string: "token=abc",
      },
      exception: { values: [{ type: "Error", value: "payment for a@b.co refused" }] },
      breadcrumbs: [
        { message: "fetch", data: { url: "https://x.test/pay?code=1234", status: 500 } },
      ],
      extra: { payload: { cardNumber: "4111", sessionId: "s", note: "ok" } },
    });

    expect(event).toEqual({
      message: `sign-in failed for ${SCRUBBED}`,
      request: {
        url: "https://stellar.astroman.ge/api/auth/verify-email",
        method: "POST",
        headers: { "user-agent": "Mozilla/5.0" },
      },
      exception: {
        values: [{ type: "Error", value: `payment for ${SCRUBBED} refused` }],
      },
      breadcrumbs: [
        { message: "fetch", data: { url: "https://x.test/pay", status: 500 } },
      ],
      extra: { payload: { cardNumber: "4111", sessionId: SCRUBBED, note: "ok" } },
    });
  });
});
