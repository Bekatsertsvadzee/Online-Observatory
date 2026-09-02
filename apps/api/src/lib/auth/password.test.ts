import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { hashPassword, verifyPassword } from "@/lib/auth/password";

describe("password hashing", () => {
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await hashPassword("a long observatory password");
  });

  it("stores a salted scrypt representation rather than the password", () => {
    expect(passwordHash).toMatch(/^scrypt\$65536\$8\$1\$/);
    expect(passwordHash).not.toContain("a long observatory password");
  });

  it("accepts the correct password and rejects another password", async () => {
    await expect(
      verifyPassword("a long observatory password", passwordHash),
    ).resolves.toBe(true);
    await expect(verifyPassword("a different password", passwordHash)).resolves.toBe(
      false,
    );
  });

  it("fails closed for an unsupported password encoding", async () => {
    await expect(verifyPassword("password", "plaintext")).resolves.toBe(false);
  });
});
