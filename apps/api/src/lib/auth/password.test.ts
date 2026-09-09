import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { hashPassword, verifyPassword } from "@/lib/auth/password";

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword("a long observatory password");
});

describe("password hashing", () => {
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

describe("a stored hash that cannot be used", () => {
  // Not remotely triggerable: every one of these needs a corrupt or hand-edited
  // `Account.passwordHash`. Before this, each one crashed sign-in for that
  // account with a 500 and a stack trace, which reads as an outage rather than
  // as the one bad row it is. An unusable stored hash is a failed verification.
  const withParameters = (cost: string, blockSize: string, parallelization: string) =>
    `scrypt$${cost}$${blockSize}$${parallelization}$c2FsdA$a2V5`;

  it("fails a non-numeric cost", async () => {
    await expect(verifyPassword("password", withParameters("x", "8", "1"))).resolves.toBe(
      false,
    );
  });

  it("fails a non-numeric block size", async () => {
    await expect(verifyPassword("password", withParameters("65536", "r", "1"))).resolves.toBe(
      false,
    );
  });

  it("fails a non-numeric parallelisation", async () => {
    await expect(
      verifyPassword("password", withParameters("65536", "8", "p")),
    ).resolves.toBe(false);
  });

  it("fails a zero or negative cost", async () => {
    // `Number("0")` is a number and not a usable one. The check is for a
    // positive integer rather than merely for something numeric.
    await expect(verifyPassword("password", withParameters("0", "8", "1"))).resolves.toBe(
      false,
    );
    await expect(verifyPassword("password", withParameters("-1", "8", "1"))).resolves.toBe(
      false,
    );
  });

  it("fails a fractional block size", async () => {
    // The case that makes the integer check load-bearing rather than decorative.
    // `128 * N * 8.5` is under the memory ceiling and `8.5` is a perfectly good
    // number, so every bound below would admit it -- and node's scrypt would then
    // reject a non-integer r and throw, which is the whole defect.
    await expect(
      verifyPassword("password", withParameters("65536", "8.5", "1")),
    ).resolves.toBe(false);
  });

  it("fails a cost that is not a power of two", async () => {
    await expect(
      verifyPassword("password", withParameters("65535", "8", "1")),
    ).resolves.toBe(false);
  });

  it("fails a cost whose working set exceeds maxmem", async () => {
    // 128 * N * r against a 128 MiB ceiling: this is the parameter that made the
    // original crash easiest to reach, because a plausible-looking number does it.
    await expect(
      verifyPassword("password", withParameters("1048576", "8", "1")),
    ).resolves.toBe(false);
  });

  it("fails a parallelisation past scrypt's own ceiling", async () => {
    await expect(
      verifyPassword("password", withParameters("65536", "8", "4294967295")),
    ).resolves.toBe(false);
  });

  it("still verifies a valid hash, so the refusals above are not blanket", async () => {
    // Guards the guard: a `verifyPassword` that returned false unconditionally
    // would pass every assertion above and let nobody sign in.
    await expect(
      verifyPassword("a long observatory password", passwordHash),
    ).resolves.toBe(true);
  });
});
