import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({
    APP_URL: "https://darkview.test",
    AUTH_SECRET: "unit-test-secret-unit-test-secret-unit",
  }),
}));

const { identityFromIdToken } = await import("@/features/auth/google");

const CLIENT = "client-id.apps.googleusercontent.com";

function token(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

const valid = {
  iss: "https://accounts.google.com",
  aud: CLIENT,
  exp: Math.floor(Date.now() / 1000) + 60,
  sub: "1234567890",
  email: "Observer@Example.test",
  email_verified: true,
  name: "Observer",
};

describe("the claims this API relies on (ADR-048)", () => {
  it("reads the subject, the address, whether Google verified it, and the name", () => {
    expect(identityFromIdToken(token(valid), CLIENT)).toEqual({
      subject: "1234567890",
      email: "Observer@Example.test",
      emailVerified: true,
      name: "Observer",
    });
  });

  it("accepts the bare issuer Google also uses, and no name", () => {
    const { name, ...rest } = valid;
    void name;
    expect(identityFromIdToken(token({ ...rest, iss: "accounts.google.com" }), CLIENT)).toMatchObject(
      { name: null, emailVerified: true },
    );
  });

  it("refuses another client's token, another issuer's, an expired one, and a malformed one", () => {
    expect(() => identityFromIdToken(token({ ...valid, aud: "other" }), CLIENT)).toThrow(/audience/);
    expect(() => identityFromIdToken(token({ ...valid, iss: "https://evil.test" }), CLIENT)).toThrow(
      /issuer/,
    );
    expect(() =>
      identityFromIdToken(token({ ...valid, exp: Math.floor(Date.now() / 1000) - 1 }), CLIENT),
    ).toThrow(/Expired/);
    expect(() => identityFromIdToken("not.a.jwt.at.all", CLIENT)).toThrow(/Malformed/);
    expect(() => identityFromIdToken(token({ ...valid, sub: undefined }), CLIENT)).toThrow(
      /subject/,
    );
  });

  it("reads an unverified address as unverified, whatever else the token says", () => {
    expect(identityFromIdToken(token({ ...valid, email_verified: "true" }), CLIENT).emailVerified).toBe(
      false,
    );
  });
});
