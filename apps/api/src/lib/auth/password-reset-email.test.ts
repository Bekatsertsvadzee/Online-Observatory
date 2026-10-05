import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { environment } = vi.hoisted(() => ({
  environment: {
    current: {
      EMAIL_VERIFICATION_WEBHOOK_URL: "https://mail.darkview.test/hook" as
        string | undefined,
      EMAIL_VERIFICATION_WEBHOOK_SECRET: "unit-test-webhook-secret-0000000000",
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
