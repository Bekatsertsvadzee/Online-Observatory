import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { hashDeviceToken } from "@/auth/device-token";
import { hashSessionToken } from "@/auth/user-session";
import { FakeLinkStore } from "@/link/fake-store";
import type { ObservatoryRecord } from "@/link/store";
import type { ChannelUser } from "@/mission/store";
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
const APP_URL = "https://darkview.test";

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

  server = createRealtimeServer(store, APP_URL);
  const httpServer = server.listen(0);
  await new Promise<void>((resolve) => httpServer.once("listening", () => resolve()));
  port = (httpServer.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const client of clients) client.close();
  await server.close();
});

describe("what a heartbeat costs", () => {
  const PROTOCOL_VERSION = "1";

  function hello(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      type: "AGENT_HELLO",
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      protocolVersion: PROTOCOL_VERSION,
      observatoryId: realObservatory.id,
      agentVersion: "0.1.0",
      mode: "REAL",
      bootedAt: new Date().toISOString(),
      safetyEnvelopeConfigured: false,
      resumeMissionId: null,
      ...overrides,
    });
  }

  function heartbeat(sequence: number) {
    return JSON.stringify({
      type: "AGENT_HEARTBEAT",
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      sequence,
      uptimeSeconds: sequence * 5,
    });
  }

  /** Let the server finish the work it kicked off for the frames just sent. */
  async function settle() {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  it("sweeps once when the link comes online, and not again per message", async () => {
    const client = await connect(DEVICE_TOKEN);

    client.send(hello());
    await settle();
    const afterHello = store.envelopeReads.length;

    for (let sequence = 1; sequence <= 5; sequence += 1) client.send(heartbeat(sequence));
    await settle();

    // The sweep re-sends the safety envelope, the session owner and any unrelayed
    // command. Running it per frame meant a heartbeat every five seconds pushed
    // all of that at an observatory doing nothing, forever. It belongs on the
    // transition into ONLINE, which happens once.
    expect(afterHello).toBe(1);
    expect(store.envelopeReads.length).toBe(afterHello);
  });
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

/**
 * The mission channel through the real HTTP upgrade.
 *
 * The channel's own rules are covered against an in-memory channel in
 * `mission/channel.test.ts`. What is only reachable here is the handshake: the
 * origin check, the cookie, and the fact that a customer's socket is routed to a
 * mission channel and never to the agent link.
 */
describe("the mission client channel", () => {
  const SESSION_COOKIE = "a-browser-session-cookie-value";
  const MISSION = "22222222-2222-4222-8222-222222222222";

  const customer: ChannelUser = {
    id: "44444444-4444-4444-8444-444444444444",
    role: "USER",
  };

  let missionSessionId: string;

  function openMissionSocket(headers: Record<string, string>) {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/mission/${MISSION}`, {
      headers,
    });
    clients.push(client);

    return new Promise<WebSocket>((resolve, reject) => {
      client.once("open", () => resolve(client));
      client.once("error", reject);
      client.once("unexpected-response", (_request, response) =>
        reject(new Error(`refused with ${response.statusCode}`)),
      );
    });
  }

  function signedIn() {
    return {
      origin: APP_URL,
      cookie: `darkview_session=${SESSION_COOKIE}`,
    };
  }

  beforeEach(() => {
    missionSessionId = randomUUID();
    store.registerUserSession(
      hashSessionToken(SESSION_COOKIE),
      customer,
      new Date(Date.now() + 60 * 60_000),
    );
    store.addMission(MISSION, {
      observatoryId: realObservatory.id,
      state: "OBSERVING",
    });
    store.setActiveSession(realObservatory.id, {
      sessionId: missionSessionId,
      missionId: MISSION,
      userId: customer.id,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
  });

  it("refuses a handshake from another origin", async () => {
    // A WebSocket handshake carries the customer's cookies whatever page opened
    // it. Without this, any site could subscribe as a signed-in customer.
    await expect(
      openMissionSocket({
        origin: "https://darkview.ge.evil.example",
        cookie: `darkview_session=${SESSION_COOKIE}`,
      }),
    ).rejects.toThrow("refused with 403");
  });

  it("refuses a handshake with no session cookie", async () => {
    await expect(openMissionSocket({ origin: APP_URL })).rejects.toThrow(
      "refused with 401",
    );
  });

  it("refuses a handshake carrying an unknown cookie", async () => {
    await expect(
      openMissionSocket({ origin: APP_URL, cookie: "darkview_session=guessed" }),
    ).rejects.toThrow("refused with 401");
  });

  it("delivers the mission's state to a customer who subscribes", async () => {
    const client = await openMissionSocket(signedIn());
    const received = new Promise<Record<string, unknown>>((resolve) =>
      client.once("message", (data) => resolve(JSON.parse(data.toString()))),
    );

    client.send(
      JSON.stringify({
        type: "CLIENT_SUBSCRIBE",
        messageId: randomUUID(),
        sentAt: new Date().toISOString(),
        missionId: MISSION,
        sessionId: missionSessionId,
      }),
    );

    expect(await received).toMatchObject({
      type: "MISSION_STATE",
      missionId: MISSION,
      state: "OBSERVING",
    });
    expect(server.missions.subscribers(MISSION)).toHaveLength(1);
  });

  it("does not register a customer's socket as an agent link", async () => {
    // The two channels are separate credentials and separate powers. A browser
    // socket appearing in the agent registry would be a socket that could be
    // handed a CommandEnvelope.
    await openMissionSocket(signedIn());

    expect(server.registry.size).toBe(0);
  });

  it("drops the subscriber from the fan-out when the socket closes", async () => {
    const client = await openMissionSocket(signedIn());
    client.close();

    await vi.waitFor(() => expect(server.missions.size).toBe(0));
  });

  it("refuses an unknown path outright", async () => {
    const stray = new WebSocket(`ws://127.0.0.1:${port}/ws/nonsense`);
    clients.push(stray);

    await expect(
      new Promise((_resolve, reject) => {
        stray.once("open", () => reject(new Error("opened")));
        stray.once("error", (error) => reject(error));
      }),
    ).rejects.toThrow();
  });
});
