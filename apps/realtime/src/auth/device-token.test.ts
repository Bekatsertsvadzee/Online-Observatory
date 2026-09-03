import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { authenticateAgent, bearerTokenFrom, hashDeviceToken } from "@/auth/device-token";
import { FakeLinkStore } from "@/link/fake-store";

const observatory = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "tbilisi",
  mode: "SIMULATED" as const,
};

const TOKEN = "a-real-looking-device-token-value";

function storeWithToken() {
  const store = new FakeLinkStore();
  store.registerToken(hashDeviceToken(TOKEN), observatory);
  return store;
}

// criterion 6
describe("device token authentication", () => {
  it("admits the observatory that owns the token", async () => {
    await expect(
      authenticateAgent(storeWithToken(), `Bearer ${TOKEN}`),
    ).resolves.toEqual(observatory);
  });

  it.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["a non-bearer scheme", `Basic ${TOKEN}`],
    ["a wrong token", "Bearer not-the-token"],
    ["the hash instead of the token", `Bearer ${hashDeviceToken(TOKEN)}`],
  ])("refuses %s", async (_label, header) => {
    await expect(authenticateAgent(storeWithToken(), header)).resolves.toBeNull();
  });

  it("admits no agent when the observatory has no token issued", async () => {
    await expect(
      authenticateAgent(new FakeLinkStore(), `Bearer ${TOKEN}`),
    ).resolves.toBeNull();
  });

  it("never derives the token back from what is stored", () => {
    const hash = hashDeviceToken(TOKEN);
    expect(hash).not.toContain(TOKEN);
    expect(hashDeviceToken(TOKEN)).toBe(hash);
    expect(hashDeviceToken(`${TOKEN} `)).not.toBe(hash);
  });

  it("extracts only the token portion of the header", () => {
    expect(bearerTokenFrom(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerTokenFrom("Bearer")).toBeNull();
  });
});

// criterion 6, second half: never logged
describe("the token is never written to a log", () => {
  const sourceRoot = path.resolve(import.meta.dirname, "..");

  function filesUnder(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) return filesUnder(full);
      return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
    });
  }

  it("has no console call naming a token or credential", () => {
    const offending = filesUnder(sourceRoot).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, index) => ({ file, line: index + 1, text: line }))
        .filter(
          ({ text }) =>
            /console\.\w+\(/.test(text) && /token|secret|authorization/i.test(text),
        )
        .map(({ file: f, line }) => `${path.relative(sourceRoot, f)}:${line}`),
    );

    expect(offending).toEqual([]);
  });

  it("keeps the raw token out of everything below authentication", () => {
    // Only device-token.ts sees the credential. Nothing else may name the header
    // or carry it further into the service.
    const leaked = filesUnder(sourceRoot)
      .filter((file) => !file.endsWith("auth/device-token.ts"))
      .filter((file) => /headers\.authorization/.test(readFileSync(file, "utf8")))
      .filter((file) => !file.endsWith("server.ts")); // hands it straight to authenticateAgent

    expect(leaked).toEqual([]);
  });
});
