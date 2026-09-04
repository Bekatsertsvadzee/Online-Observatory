import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { hashDeviceToken } from "@/auth/device-token";
import { FakeLinkStore } from "@/link/fake-store";
import type { ObservatoryRecord } from "@/link/store";
import { createRealtimeServer } from "@/server";

/**
 * These tests drive a real socket through the real HTTP upgrade.
 *
 * The link's own rules are covered against an in-memory link in
 * `agent-link.test.ts`. What is *not* covered there is the wiring: which record
 * the server hands the link when a socket arrives. That wiring was wrong --
 * `mode` was a hardcoded literal rather than the row the token resolved to --
 * and no test could have caught it without going through the upgrade.
 */
const DEVICE_TOKEN = "device-token-for-the-tbilisi-observatory";

const realObservatory: ObservatoryRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "tbilisi",
  mode: "REAL",
};

let store: FakeLinkStore;
let server: ReturnType<typeof createRealtimeServer>;
let port: number;
let clients: WebSocket[];

async function connect(token: string | null): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  clients.push(client);

  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
    client.once("unexpected-response", (_request, response) =>
      reject(new Error(`refused with ${response.statusCode}`)),
    );
  });

  return client;
}

beforeEach(async () => {
  store = new FakeLinkStore();
  store.registerToken(hashDeviceToken(DEVICE_TOKEN), realObservatory);
  clients = [];

  server = createRealtimeServer(store);
  const httpServer = server.listen(0);
  await new Promise<void>((resolve) => httpServer.once("listening", () => resolve()));
  port = (httpServer.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const client of clients) client.close();
  await server.close();
});

describe("the record the server hands the link", () => {
  it("is the observatory the device token resolved to", async () => {
    await connect(DEVICE_TOKEN);

    const link = server.registry.get(realObservatory.id);
    expect(link).toBeDefined();
    expect(link!.observatory).toEqual(realObservatory);
  });

  it("reports REAL for an observatory stored as REAL", async () => {
    await connect(DEVICE_TOKEN);

    // The flag every hardware-safety rule is built on. A literal here would read
    // as true to whatever consults it next and be wrong for exactly the
    // observatory it matters for.
    expect(server.registry.get(realObservatory.id)!.observatory.mode).toBe("REAL");
  });

  it("reports SIMULATED for an observatory stored as SIMULATED", async () => {
    const simulated: ObservatoryRecord = { ...realObservatory, mode: "SIMULATED" };
    store.registerToken(hashDeviceToken(DEVICE_TOKEN), simulated);

    await connect(DEVICE_TOKEN);

    // The old code returned SIMULATED here too, and for the wrong reason. This
    // passes only because the store said so.
    expect(server.registry.get(simulated.id)!.observatory.mode).toBe("SIMULATED");
  });

  it("carries the slug rather than an empty string", async () => {
    await connect(DEVICE_TOKEN);

    expect(server.registry.get(realObservatory.id)!.observatory.slug).toBe("tbilisi");
  });
});

describe("who is let in", () => {
  it("refuses a connection with no Authorization header", async () => {
    await expect(connect(null)).rejects.toThrow(/401/);
    expect(server.registry.size).toBe(0);
  });

  it("refuses a connection presenting an unknown token", async () => {
    await expect(connect("not-the-right-token")).rejects.toThrow(/401/);
    expect(server.registry.size).toBe(0);
  });

  it("refuses a second connection for the same observatory", async () => {
    const first = await connect(DEVICE_TOKEN);
    const second = await connect(DEVICE_TOKEN);

    const closed = await new Promise<number>((resolve) =>
      second.once("close", (code) => resolve(code)),
    );

    expect(closed).toBe(1008);
    // The incumbent keeps the observatory, and keeps its own record.
    expect(first.readyState).toBe(WebSocket.OPEN);
    expect(server.registry.get(realObservatory.id)!.observatory).toEqual(realObservatory);
  });
});
