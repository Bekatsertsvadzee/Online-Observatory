import { NextResponse } from "next/server";

/**
 * Liveness probe.
 *
 * Reports only that the process is up. It deliberately does not report database
 * connectivity, observatory link state or safety-envelope status — those are
 * real checks with real failure modes, and a health endpoint that guesses at
 * them is worse than one that says nothing. DV-063 adds the operator status API.
 */
export function GET() {
  return NextResponse.json({
    service: "darkview-api",
    status: "up",
    checkedAt: new Date().toISOString(),
  });
}
