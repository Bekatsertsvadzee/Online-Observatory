import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { ObservatoryTelemetrySnapshot } from "@darkview/contracts";

import type { AgentLinkRegistry } from "@/link/registry";

const STATE_PATH = /^\/internal\/observatories\/([0-9a-fA-F-]{36})\/state$/;

export type InternalDependencies = {
  registry: AgentLinkRegistry;
  secret: string;
};

/**
 * `GET /internal/observatories/{observatoryId}/state` -- ADR-017.
 *
 * The API's read of the latest telemetry this process holds for a connected agent.
 * Returns whether the request was for this path at all, so the caller falls
 * through to its other handlers for everything else.
 *
 * **Every refusal and every absence is the same 404**: a wrong method, no or a
 * wrong secret, an observatory with no link, a link that has not finished its
 * hello, a link that has not reported yet. The stream answers on that rule too, and
 * a caller without the secret must not be able to learn which observatories are
 * connected.
 *
 * The credential arrives as `authorization`, not read from the request here:
 * `server.ts` is the one place besides device-token.ts that touches the header,
 * which `auth/device-token.test.ts` holds this service to.
 */
export function handleInternalRequest(
  { registry, secret }: InternalDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  authorization: string | undefined,
): boolean {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = STATE_PATH.exec(url.pathname);
  if (!path) return false;

  const snapshot =
    request.method === "GET" && presentsSecret(authorization, secret)
      ? snapshotOf(registry, path[1].toLowerCase())
      : null;

  if (!snapshot) {
    response.writeHead(404, { "cache-control": "no-store" }).end();
    return true;
  }

  response
    .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
    .end(JSON.stringify(snapshot));
  return true;
}

/**
 * Constant time, over digests of equal length, so neither the comparison nor an
 * early return on a length mismatch says how much of a guess was right.
 */
function presentsSecret(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const presented = createHash("sha256").update(header.slice("Bearer ".length)).digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(presented, expected);
}

function snapshotOf(
  registry: AgentLinkRegistry,
  observatoryId: string,
): ObservatoryTelemetrySnapshot | null {
  const link = registry.get(observatoryId);
  if (!link || link.currentState !== "ONLINE") return null;

  const telemetry = link.latestTelemetry;
  if (!telemetry) return null;

  return {
    observatoryId,
    telemetry,
    lastHeartbeatAt: new Date(link.lastSeenAt).toISOString(),
  };
}
