import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { environment } = vi.hoisted(() => ({
  environment: {
    RESEND_API_KEY: undefined as string | undefined,
    EMAIL_FROM: undefined as string | undefined,
    EMAIL_VERIFICATION_WEBHOOK_URL: undefined as string | undefined,
    EMAIL_VERIFICATION_WEBHOOK_SECRET: undefined as string | undefined,
  },
}));

vi.mock("@/lib/validation/env", () => ({ getServerEnvironment: () => environment }));

import { sendEmailVerification } from "./email-verification";

const KEY = "re_test_key";
const FROM = "Stellar <hello@stellar.test>";
const URL_EN = "https://stellar.test/en/verify-email/token-abc";
const URL_KA = "https://stellar.test/ka/verify-email/token-abc";

const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(
  async () => new Response(null, { status: 200 }),
);

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  environment.RESEND_API_KEY = undefined;
  environment.EMAIL_FROM = undefined;
  environment.EMAIL_VERIFICATION_WEBHOOK_URL = undefined;
  environment.EMAIL_VERIFICATION_WEBHOOK_SECRET = undefined;
});

function sent() {
  const [url, init] = fetchMock.mock.calls[0]!;
  return {
    url,
    headers: init.headers as Record<string, string>,
    method: init.method,
    body: JSON.parse(init.body as string) as Record<string, unknown>,
  };
}

describe("verification email through Resend (ADR-035)", () => {
  beforeEach(() => {
    environment.RESEND_API_KEY = KEY;
    environment.EMAIL_FROM = FROM;
    // Configured too, and not used: Resend goes first when it is set.
    environment.EMAIL_VERIFICATION_WEBHOOK_URL = "https://mail.stellar.test/hook";
    environment.EMAIL_VERIFICATION_WEBHOOK_SECRET =
      "webhook-secret-that-is-at-least-32-chars";
  });

  it("posts the English email to Resend's API", async () => {
    await sendEmailVerification({
      recipient: "a@example.com",
      verificationUrl: URL_EN,
      locale: "en",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = sent();
    expect(request.url).toBe("https://api.resend.com/emails");
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.body).toMatchObject({ from: FROM, to: ["a@example.com"] });
    expect(request.body.subject).toContain("Stellar");
    expect(request.body.text).toContain(URL_EN);
    expect(request.body.html).toContain(`href="${URL_EN}"`);
    expect(JSON.stringify(request.body).toLowerCase()).not.toContain("darkview");
  });

  it("writes the Georgian email in Georgian", async () => {
    await sendEmailVerification({
      recipient: "b@example.com",
      verificationUrl: URL_KA,
      locale: "ka",
    });

    const request = sent();
    expect(request.body).toMatchObject({ from: FROM, to: ["b@example.com"] });
    expect(request.body.subject).toContain("სტელარი");
    expect(request.body.text).toContain("დაადასტურე ელფოსტის");
    expect(request.body.text).toContain(URL_KA);
    expect(JSON.stringify(request.body).toLowerCase()).not.toContain("darkview");
  });

  it("throws when Resend answers non-OK", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 422 }));
    await expect(
      sendEmailVerification({
        recipient: "a@example.com",
        verificationUrl: URL_EN,
        locale: "en",
      }),
    ).rejects.toThrow("Email verification delivery failed");
  });
});

describe("verification email through the webhook", () => {
  it("falls back to the signed webhook when Resend is not configured", async () => {
    environment.EMAIL_VERIFICATION_WEBHOOK_URL = "https://mail.stellar.test/hook";
    environment.EMAIL_VERIFICATION_WEBHOOK_SECRET =
      "webhook-secret-that-is-at-least-32-chars";
    const message = {
      recipient: "a@example.com",
      verificationUrl: URL_EN,
      locale: "en" as const,
    };

    await sendEmailVerification(message);

    const request = sent();
    expect(request.url).toBe("https://mail.stellar.test/hook");
    expect(request.headers["x-darkview-signature"]).toEqual(expect.any(String));
    expect(request.body).toEqual(message);
  });

  it("throws when neither path is configured", async () => {
    await expect(
      sendEmailVerification({
        recipient: "a@example.com",
        verificationUrl: URL_EN,
        locale: "en",
      }),
    ).rejects.toThrow("not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
