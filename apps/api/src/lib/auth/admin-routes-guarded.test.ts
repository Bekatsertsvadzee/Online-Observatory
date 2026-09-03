import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const appDirectory = path.resolve(import.meta.dirname, "../../app");
const adminDirectory = path.join(appDirectory, "admin");

function routeFilesUnder(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return routeFilesUnder(full);
    return entry === "route.ts" ? [full] : [];
  });
}

/**
 * DV-051 acceptance criterion 2: every `/admin/*` route rejects a USER with 403.
 *
 * The contract declares ten admin operations; DV-063 builds them. Rather than
 * assert the criterion once against today's routes and let tomorrow's slip past,
 * this walks the route tree and fails if any admin route omits the operator
 * guard. It is a standing invariant, not a snapshot.
 *
 * Today the admin tree is empty, so this asserts nothing about behaviour -- it
 * exists so that the first admin route added cannot land unguarded.
 */
describe("every admin route is behind the operator guard", () => {
  const adminRoutes = routeFilesUnder(adminDirectory);

  it.runIf(adminRoutes.length > 0).each(adminRoutes)(
    "%s calls requireOperator",
    (routeFile) => {
      expect(readFileSync(routeFile, "utf8")).toContain("requireOperator");
    },
  );

  it("finds no unguarded admin route", () => {
    const unguarded = adminRoutes.filter(
      (routeFile) => !readFileSync(routeFile, "utf8").includes("requireOperator"),
    );
    expect(unguarded).toEqual([]);
  });

  it("guards every route outside the public allow-list", () => {
    // Routes that are deliberately reachable without an operator role. Anything
    // added to the app tree that is not here and not under /admin must still make
    // its own authentication decision -- this list is the record of that decision.
    const publicRoutes = new Set(["health", "me"]);

    const topLevel = routeFilesUnder(appDirectory)
      .map((file) => path.relative(appDirectory, file).split(path.sep)[0])
      .filter((segment) => segment !== "admin");

    expect(topLevel.filter((segment) => !publicRoutes.has(segment))).toEqual([]);
  });
});
