import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every operation in `contracts/openapi.yaml` has a route handler here (#152).
 *
 * `listBookings` and `setMissionObservation` were in the contract with no handler
 * for their method -- a 405 for any conforming client -- and nothing noticed. This
 * reads the spec and the `route.ts` files and fails on any path + method the API
 * does not export.
 *
 * Only `paths` is checked. `x-darkview-websockets` and `x-darkview-internal` are
 * served by `apps/realtime` and have no path item, so they are not in `paths` at
 * all. An operation that is in `paths` but deliberately served somewhere else must
 * be named in SERVED_ELSEWHERE with its reason; there are none today.
 */
const SERVED_ELSEWHERE: ReadonlyArray<{ operation: string; reason: string }> = [];

const METHODS = ["get", "put", "post", "patch", "delete", "head", "options"] as const;

const APP_DIR = path.resolve(import.meta.dirname);
const SPEC = path.resolve(import.meta.dirname, "../../../../contracts/openapi.yaml");

/**
 * `paths` from the spec as "METHOD /path" strings.
 *
 * Read by indentation rather than a YAML library, because none is a declared
 * dependency of this workspace. The spec's layout is fixed -- path keys at two
 * spaces, methods at four -- and the parse checks itself against the number of
 * `operationId`s in the section, so a layout it misreads fails here rather than
 * passing with operations missing.
 */
function contractOperations(): string[] {
  const lines = readFileSync(SPEC, "utf8").split("\n");
  const start = lines.indexOf("paths:");
  expect(start).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
  const section = lines.slice(start + 1, end === -1 ? undefined : end);

  const operations: string[] = [];
  let current: string | null = null;
  for (const line of section) {
    const pathKey = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathKey) {
      current = pathKey[1] ?? null;
      continue;
    }
    const method = /^ {4}([a-z]+):\s*$/.exec(line);
    if (method && current && (METHODS as readonly string[]).includes(method[1] ?? "")) {
      operations.push(`${(method[1] ?? "").toUpperCase()} ${current}`);
    }
  }

  const operationIds = section.filter((line) => /^ {6}operationId:/.test(line)).length;
  expect(operations.length).toBe(operationIds);
  return operations;
}

/** Route handlers under `src/app` as "METHOD /path", dynamic segments as `{}`. */
function servedOperations(): Set<string> {
  const served = new Set<string>();
  const entries = readdirSync(APP_DIR, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name !== "route.ts") continue;
    const relative = path.relative(APP_DIR, entry.parentPath);
    const route =
      "/" +
      relative
        .split(path.sep)
        .filter((segment) => segment !== "" && !/^\(.*\)$/.test(segment))
        .map((segment) => (/^\[.+\]$/.test(segment) ? "{}" : segment))
        .join("/");
    const source = readFileSync(path.join(entry.parentPath, entry.name), "utf8");
    for (const match of source.matchAll(
      /^export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|PUT|POST|PATCH|DELETE|HEAD|OPTIONS)\b/gm,
    )) {
      served.add(`${match[1]} ${route === "/" ? "/" : route}`);
    }
  }
  return served;
}

const normalise = (operation: string) => operation.replace(/\{[^}]+\}/g, "{}");

describe("contract conformance", () => {
  it("serves every path and method in contracts/openapi.yaml", () => {
    const served = servedOperations();
    const exempt = new Set(SERVED_ELSEWHERE.map((entry) => normalise(entry.operation)));

    const missing = contractOperations()
      .map(normalise)
      .filter((operation) => !exempt.has(operation) && !served.has(operation));

    expect(missing).toEqual([]);
  });

  it("names a reason for every operation it lets another service serve", () => {
    for (const entry of SERVED_ELSEWHERE) expect(entry.reason.trim()).not.toBe("");
  });
});
