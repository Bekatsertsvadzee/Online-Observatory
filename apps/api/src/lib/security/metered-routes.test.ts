import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const appDirectory = path.resolve(import.meta.dirname, "../../app");

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

const MUTATING = /export async function (POST|PUT|PATCH|DELETE)\b/;

/**
 * A call, not an import.
 *
 * Written as `includes("meterRequest")` first, which passed against a route
 * whose metering had been deleted and whose import line survived. An assertion
 * that a file mentions a function proves nothing about whether it calls it.
 */
const METERED = /await meterRequest\(/;

/**
 * Routes that change something and are deliberately not metered.
 *
 * The rule this file enforces has one shape: **anything that stops the telescope
 * is never metered, anything that starts or widens it is.** A limiter able to
 * delay an emergency stop is a regression dressed as hardening -- the moment an
 * operator most needs it is the moment they have been hammering the console,
 * which is exactly when a meter would refuse them.
 *
 * Two routes are exempt only in part and so are absent from this list: the
 * override meters everything except PARK and ABORT, and the weather hold meters
 * clearing but never declaring.
 *
 * This list is the record of a decision. The assertion below is what makes it a
 * decision rather than an oversight.
 */
const UNMETERED_BY_DESIGN = [
  // Cancelling ends a stuck mission and releases the observatory, which is the
  // stopping direction. There is one active mission at a time, so cancelling in
  // a loop cancels the same single mission repeatedly and gains an attacker
  // nothing a first cancel did not already do -- while metering it would let a
  // flood of anything else deny an operator the one control that frees a
  // telescope nobody can book behind.
  "admin/missions/[missionId]/cancel/route.ts",
  // Suspending a partner node is the emergency stop for a telescope nobody is
  // standing next to (ADR-013). It follows Park: a limiter able to delay it would
  // be a regression dressed as hardening, and the moment an operator most needs
  // it is the moment they have been hammering the console.
  "admin/network/nodes/[nodeId]/suspend/route.ts",
];

describe("every mutating route is metered", () => {
  const mutatingRoutes = routeFilesUnder(appDirectory).filter((routeFile) =>
    MUTATING.test(readFileSync(routeFile, "utf8")),
  );

  it("finds mutating routes to check", () => {
    // Guards the guard: a walker that silently found nothing would pass every
    // assertion below while proving nothing at all.
    expect(mutatingRoutes.length).toBeGreaterThan(5);
  });

  it("leaves no mutating route unmetered and undeclared", () => {
    const unmetered = mutatingRoutes
      .filter((routeFile) => !METERED.test(readFileSync(routeFile, "utf8")))
      .map((routeFile) => path.relative(appDirectory, routeFile));

    expect(unmetered).toEqual(UNMETERED_BY_DESIGN);
  });

  it("keeps the exemption list honest", () => {
    // An entry naming a route that no longer exists is worse than no list: it
    // reads as a considered exemption while exempting nothing.
    const present = mutatingRoutes.map((routeFile) =>
      path.relative(appDirectory, routeFile),
    );

    for (const exempt of UNMETERED_BY_DESIGN) {
      expect(present).toContain(exempt);
    }
  });
});
