import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const apiSource = path.join(repositoryRoot, "apps/api/src");

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return filesUnder(full);
    return full.endsWith(".ts") || full.endsWith(".tsx") ? [full] : [];
  });
}

/**
 * DV-057 criterion 1: the observatory socket lives in its own long-running
 * process, and the Next.js app holds no agent connection.
 *
 * `CLAUDE.md` is unambiguous -- never hold the observatory socket inside a
 * serverless function. A Next.js route is one. This is the kind of rule that is
 * obeyed on the day it is written and quietly broken a month later by someone
 * adding "just a small websocket handler", so it is asserted rather than trusted.
 */
describe("the agent link is not in the Next.js app", () => {
  const apiFiles = filesUnder(apiSource);

  it.each([
    ["a websocket server library", /from ["']ws["']|WebSocketServer/],
    ["the agent link path", /\/ws\/agent/],
    ["an upgrade handler", /\bon\(["']upgrade["']\)|handleUpgrade/],
  ])("apps/api contains no reference to %s", (_label, pattern) => {
    const offending = apiFiles
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(repositoryRoot, file));

    expect(offending).toEqual([]);
  });

  it("apps/api does not depend on the realtime service or on ws", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, "apps/api/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    const dependencies = Object.keys(manifest.dependencies ?? {});
    expect(dependencies).not.toContain("ws");
    expect(dependencies).not.toContain("@darkview/realtime");
  });

  it("the realtime service is its own workspace with its own entry point", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, "apps/realtime/package.json"), "utf8"),
    ) as { name: string; scripts?: Record<string, string> };

    expect(manifest.name).toBe("@darkview/realtime");
    expect(manifest.scripts?.start).toContain("src/server.ts");
  });
});
