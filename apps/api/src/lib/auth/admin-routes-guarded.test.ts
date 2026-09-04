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
    // Routes that are deliberately reachable without a session. Anything added to
    // the app tree that is not here and not under /admin must call a guard of its
    // own -- this list is the record of that decision, and the assertion below is
    // what makes it a decision rather than an oversight.
    //
    //   health   liveness only; reports nothing about the observatory
    //   targets  public by contract (security: []) -- choosing what to look at
    //            does not require an account, and the catalogue is not secret
    //   slots    public by contract (security: []) -- someone deciding whether
    //            to book should not have to sign up to see what is available.
    //            Reserving one is POST /bookings, which is not public.
    const publicRoutes = new Set(["health", "targets", "slots"]);

    const unguarded = routeFilesUnder(appDirectory)
      .filter((file) => {
        const segment = path.relative(appDirectory, file).split(path.sep)[0];
        return segment !== "admin" && !publicRoutes.has(segment);
      })
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return (
          !source.includes("requireApiSession") &&
          !source.includes("requireApiMutation") &&
          !source.includes("requireOperator")
        );
      })
      .map((file) => path.relative(appDirectory, file));

    expect(unguarded).toEqual([]);
  });

  it("puts every mutating route behind the same-origin guard", () => {
    // A session cookie is attached by the browser to a cross-site POST as readily
    // as to a first-party one. requireApiSession alone therefore proves who the
    // caller is but not that they meant to call: a mutating route needs
    // requireApiMutation, which checks Origin first.
    const mutating = routeFilesUnder(appDirectory).filter((file) => {
      const source = readFileSync(file, "utf8");
      return /export async function (POST|PUT|PATCH|DELETE)\b/.test(source);
    });

    const withoutOriginCheck = mutating
      .filter((file) => !readFileSync(file, "utf8").includes("requireApiMutation"))
      .map((file) => path.relative(appDirectory, file));

    expect(withoutOriginCheck).toEqual([]);
  });
});
