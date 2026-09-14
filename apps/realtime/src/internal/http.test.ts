import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ObservatoryTelemetry } from "@darkview/contracts";
import { zObservatoryTelemetrySnapshot } from "@darkview/contracts/zod";

import { handleInternalRequest } from "@/internal/http";
import { AgentLink } from "@/link/agent-link";
import { FakeLinkStore } from "@/link/fake-store";
import { FAKE_STORAGE } from "@/link/fake-storage";
import { PROTOCOL_VERSION } from "@/link/protocol";
import { AgentLinkRegistry } from "@/link/registry";
import type { ObservatoryRecord } from "@/link/store";
import { RecordingBroadcast } from "@/mission/fake-broadcast";

/**
 * ADR-017 §2, through a real HTTP server: who is answered, and what with.
 */
const SECRET = "an-internal-secret-of-at-least-32-characters";

const observatory: ObservatoryRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "tbilisi",
  mode: "SIMULATED",
};
const UNKNOWN = "99999999-9999-4999-8999-999999999999";

const at = Date.parse("2026-09-14T20:00:00.000Z");

const telemetry: ObservatoryTelemetry = {
  mode: "SIMULATED",
  link: "ONLINE",
  mount: { health: "OK", detail: null },
  camera: { health: "OK", detail: null },
  focuser: { health: "NOT_CONFIGURED", detail: null },
  weather: {
    status: "CLEAR",
    source: "OPERATOR",
    holdActive: false,
    note: null,
    updatedAt: "2026-09-14T19:00:00.000Z",
  },
  tracking: true,
  parked: false,
  slewing: false,
  reportedAt: "2026-09-14T19:59:59.000Z",
};

let registry: AgentLinkRegistry;
let link: AgentLink;
let server: Server;
let origin: string;

async function connect() {
  link = new AgentLink(
    observatory,
    new FakeLinkStore(),
    () => {},
    () => {},
    new RecordingBroadcast(),
    FAKE_STORAGE,
    () => at,
  );
  registry.admit(observatory.id, link);
  await link.receive(
    JSON.stringify({
      type: "AGENT_HELLO",
      messageId: randomUUID(),
      sentAt: new Date(at).toISOString(),
      protocolVersion: PROTOCOL_VERSION,
      observatoryId: observatory.id,
      agentVersion: "0.1.0",
      mode: "SIMULATED",
      bootedAt: new Date(at).toISOString(),
      safetyEnvelopeConfigured: true,
      resumeMissionId: null,
    }),
  );
}

async function report(sample: ObservatoryTelemetry = telemetry) {
  await link.receive(
    JSON.stringify({
      type: "AGENT_STATE_DELTA",
      messageId: randomUUID(),
      sentAt: new Date(at).toISOString(),
      telemetry: sample,
      missionId: null,
      missionState: null,
    }),
  );
}

function get(observatoryId = observatory.id, authorization: string | null = `Bearer ${SECRET}`) {
  return fetch(`${origin}/internal/observatories/${observatoryId}/state`, {
    headers: authorization ? { authorization } : {},
  });
}

beforeEach(async () => {
  registry = new AgentLinkRegistry();
  server = createServer((request, response) => {
    if (
      !handleInternalRequest(
        { registry, secret: SECRET },
        request,
        response,
        request.headers.authorization,
      )
    ) {
      response.writeHead(418).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the latest telemetry of a connected agent", () => {
  it("is served to the API, in the contract's own shape", async () => {
    await connect();
    await report();

    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = zObservatoryTelemetrySnapshot.parse(await response.json());
    expect(body).toEqual({
      observatoryId: observatory.id,
      telemetry,
      lastHeartbeatAt: new Date(at).toISOString(),
    });
  });

  it("is the newest sample, not the first", async () => {
    await connect();
    await report();
    await report({ ...telemetry, slewing: true, reportedAt: "2026-09-14T20:00:00.000Z" });

    const body = zObservatoryTelemetrySnapshot.parse(await (await get()).json());
    expect(body.telemetry.slewing).toBe(true);
  });

  it("is gone once the link is released", async () => {
    await connect();
    await report();
    registry.release(observatory.id, link);

    expect((await get()).status).toBe(404);
  });
});

describe("every refusal is the same 404", () => {
  beforeEach(async () => {
    await connect();
    await report();
  });

  it("refuses a request with no secret", async () => {
    expect((await get(observatory.id, null)).status).toBe(404);
  });

  it("refuses a wrong secret", async () => {
    expect((await get(observatory.id, "Bearer not-the-secret")).status).toBe(404);
  });

  it("refuses the right secret in the wrong scheme", async () => {
    expect((await get(observatory.id, SECRET)).status).toBe(404);
  });

  it("refuses an observatory with no link", async () => {
    expect((await get(UNKNOWN)).status).toBe(404);
  });

  it("refuses anything but GET", async () => {
    const response = await fetch(`${origin}/internal/observatories/${observatory.id}/state`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(response.status).toBe(404);
  });
});

describe("absences", () => {
  it("answers 404 for a connected agent that has not reported yet", async () => {
    await connect();
    expect((await get()).status).toBe(404);
  });

  it("leaves every other path to the next handler", async () => {
    expect((await fetch(`${origin}/stream/mission/${UNKNOWN}`)).status).toBe(418);
  });
});
