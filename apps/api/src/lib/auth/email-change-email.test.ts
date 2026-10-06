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

import { emailChangeContent, sendEmailChangeMessage } from "./email-change-email";

const link = {
  kind: "EMAIL_CHANGE" as const,
  recipient: "new@example.test",
  locale: "ka" as const,
  verificationUrl: "https://darkview.test/ka/verify-email/token",
};

afterEach(() => {
  vi.unstubAllGlobals();
  environment.current.RESEND_API_KEY = undefined;
  environment.current.EMAIL_FROM = undefined;
});

describe("sendEmailChangeMessage", () => {
  it("posts the message signed over the exact body, kind included", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendEmailChangeMessage(link);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://mail.darkview.test/hook");
    expect(JSON.parse(init.body as string)).toEqual(link);
    const signature = createHmac("sha256", "unit-test-webhook-secret-0000000000")
      .update(init.body as string)
      .digest("base64url");
    expect((init.headers as Record<string, string>)["x-darkview-signature"]).toBe(
      signature,
    );
  });

  it("sends through Resend when it is configured", async () => {
    environment.current.RESEND_API_KEY = "re_test";
    environment.current.EMAIL_FROM = "Stellar <hello@example.test>";
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendEmailChangeMessage(link);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(init.body as string)).toMatchObject({ to: ["new@example.test"] });
  });

  it("throws when the mail service refuses, so the caller answers 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );

    await expect(sendEmailChangeMessage(link)).rejects.toThrow();
  });
});

describe("emailChangeContent", () => {
  it("carries the link only in the message to the new address", () => {
    expect(emailChangeContent(link).text).toContain(link.verificationUrl);
    for (const kind of ["EMAIL_CHANGE_REQUESTED", "EMAIL_IN_USE"] as const) {
      const content = emailChangeContent({
        kind,
        recipient: "x@example.test",
        locale: "en",
      });
      expect(content.text).not.toContain("http");
    }
  });

  it("escapes the link in the HTML part", () => {
    const content = emailChangeContent({
      ...link,
      verificationUrl: 'https://x.test/"><b>',
    });
    expect(content.html).not.toContain('"><b>');
  });

  it("names Stellar, in both languages", () => {
    for (const locale of ["en", "ka"] as const) {
      for (const kind of ["EMAIL_CHANGE_REQUESTED", "EMAIL_IN_USE"] as const) {
        const { subject } = emailChangeContent({
          kind,
          recipient: "x@example.test",
          locale,
        });
        expect(subject).toMatch(locale === "ka" ? /სტელარი/ : /Stellar/);
      }
    }
  });
});
