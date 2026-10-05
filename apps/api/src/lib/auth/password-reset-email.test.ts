import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { environment } = vi.hoisted(() => ({
  environment: {
    current: {
      EMAIL_VERIFICATION_WEBHOOK_URL: "https://mail.darkview.test/hook" as
        string | undefined,
      EMAIL_VERIFICATION_WEBHOOK_SECRET: "unit-test-webhook-secret-0000000000",
      RESEND_API_KEY: undefined as string | undefined,
      EMAIL_FROM: undefined as string | undefined,
    },
  },
}));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => environment.current,
}));

import { sendPasswordReset } from "./password-reset-email";

const message = {
  recipient: "observer@example.test",
  resetUrl: "https://darkview.test/ka/reset-password/token",
  locale: "ka" as const,
};

afterEach(() => {
  vi.unstubAllGlobals();
  environment.current.RESEND_API_KEY = undefined;
  environment.current.EMAIL_FROM = undefined;
  environment.current.EMAIL_VERIFICATION_WEBHOOK_URL = "https://mail.darkview.test/hook";
});

describe("sendPasswordReset", () => {
  it("posts a PASSWORD_RESET message signed over the exact body", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendPasswordReset(message);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://mail.darkview.test/hook");
    expect(JSON.parse(init.body as string)).toEqual({
      kind: "PASSWORD_RESET",
      ...message,
    });
    const expected = createHmac(
      "sha256",
      environment.current.EMAIL_VERIFICATION_WEBHOOK_SECRET,
    )
      .update(init.body as string)
      .digest("base64url");
    expect((init.headers as Record<string, string>)["x-darkview-signature"]).toBe(
      expected,
    );
  });

  it("throws when the mail service refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    await expect(sendPasswordReset(message)).rejects.toThrow("delivery failed");
  });

  it("throws, sending nothing, when no webhook is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    environment.current.EMAIL_VERIFICATION_WEBHOOK_URL = undefined;

    await expect(sendPasswordReset(message)).rejects.toThrow("not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sendPasswordReset through Resend (ADR-035)", () => {
  it("sends the reset link in the request's language, from EMAIL_FROM", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    environment.current.RESEND_API_KEY = "re_test_key";
    environment.current.EMAIL_FROM = "Stellar <hello@stellar.test>";

    await sendPasswordReset(message);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer re_test_key",
    );
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      from: "Stellar <hello@stellar.test>",
      to: ["observer@example.test"],
      subject: "პაროლის აღდგენა — სტელარი",
    });
    expect(body.text).toContain(message.resetUrl);
    expect(body.html).toContain(`href="${message.resetUrl}"`);
  });

  it("throws when Resend refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 422 })),
    );
    environment.current.RESEND_API_KEY = "re_test_key";
    environment.current.EMAIL_FROM = "Stellar <hello@stellar.test>";
    await expect(sendPasswordReset(message)).rejects.toThrow("delivery failed");
  });
});
