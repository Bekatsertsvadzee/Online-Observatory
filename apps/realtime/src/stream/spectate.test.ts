import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashSessionToken } from "@/auth/user-session";
import { FakeLinkStore } from "@/link/fake-store";
import type { LiveFrame } from "@/stream/frames";
import {
  handleStreamRequest,
  SPECTATOR_CAPACITY,
  SPECTATOR_FRAME_INTERVAL_MS,
  SpectatorGate,
} from "@/stream/http";
import { LiveStream } from "@/stream/live-stream";
import { signStreamToken } from "@/stream/token";

/**
 * Clients ADR-066: anyone may watch a session its owner opened to Tonight, live, one
 * frame every four seconds, twenty at a time, and nobody once it is closed.
 */
const APP_URL = "https://darkview.test";
const SECRET = "a-stream-signing-secret-of-at-least-32-characters";
const OBSERVATORY = "11111111-1111-4111-8111-111111111111";
const MISSION = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const OWNER_COOKIE = "an-owner-browser-session-token";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

let store: FakeLinkStore;
let live: LiveStream;
let gate: SpectatorGate;
let server: Server;
let origin: string;
let sequence = 0;

function frame(): LiveFrame {
  sequence += 1;
  return {
    missionId: MISSION,
    observatoryId: OBSERVATORY,
    mode: "SIMULATED",
    encoding: "JPEG",
    sequence,
    bytes: JPEG,
    receivedAt: Date.now(),
  };
}

/** Read a multipart stream, counting the parts that arrive until it is aborted. */
function watch(path: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const state = { status: 0, parts: 0, ended: false };
  const done = fetch(`${origin}${path}`, { headers, signal: controller.signal })
    .then(async (response) => {
      state.status = response.status;
      if (!response.body) return;
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        state.parts += (
          decoder.decode(chunk).match(/Content-Type: image\/jpeg/g) ?? []
        ).length;
      }
      state.ended = true;
    })
    .catch(() => {});
  return { state, stop: () => controller.abort(), done };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  store = new FakeLinkStore();
  live = new LiveStream(APP_URL, SECRET);
  gate = new SpectatorGate();
  store.addMission(MISSION, { observatoryId: OBSERVATORY, state: "OBSERVING" });
  const later = new Date(Date.now() + 60 * 60_000);
  store.registerUserSession(
    hashSessionToken(OWNER_COOKIE),
    { id: OWNER, role: "USER" },
    later,
  );
  store.setActiveSession(OBSERVATORY, {
    sessionId: "77777777-7777-4777-8777-777777777777",
    missionId: MISSION,
    userId: OWNER,
    expiresAt: later,
  });
  live.publish(frame());

  server = createServer((request, response) => {
    void handleStreamRequest(
      { store, stream: live, spectators: gate },
      request,
      response,
    ).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  live.release(MISSION);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const spectate = `/stream/mission/${MISSION}/spectate`;

describe("a spectator", () => {
  it("is refused with the same 404 until the owner opens the session", async () => {
    const response = await fetch(`${origin}${spectate}`);
    expect(response.status).toBe(404);
    expect(gate.watching(MISSION)).toBe(0);
  });

  it("needs no sign-in once it is open, and gets the stream", async () => {
    store.tonight.add(MISSION);
    const viewer = watch(spectate);
    await wait(300);
    expect(viewer.state.status).toBe(200);
    expect(viewer.state.parts).toBe(1);
    expect(gate.watching(MISSION)).toBe(1);
    viewer.stop();
    await viewer.done;
    await wait(50);
    expect(gate.watching(MISSION)).toBe(0);
  });

  it("is turned away at the cap with 503, not 404", async () => {
    store.tonight.add(MISSION);
    const small = new SpectatorGate(2);
    gate = small;
    server.removeAllListeners("request");
    server.on("request", (request, response) => {
      void handleStreamRequest(
        { store, stream: live, spectators: small },
        request,
        response,
      );
    });
    const first = watch(spectate);
    const second = watch(spectate);
    await wait(300);
    const third = await fetch(`${origin}${spectate}`);
    expect(third.status).toBe(503);
    expect(third.headers.get("retry-after")).toBe("30");
    first.stop();
    second.stop();
  });
});

describe("the fan-out at the cap (ADR-066 §4, ADR-036)", () => {
  it("serves the owner, ten observers and twenty spectators at once, spectators at the slower rate", async () => {
    store.tonight.add(MISSION);
    const viewers: { kind: "full" | "spectator"; stream: ReturnType<typeof watch> }[] =
      [];
    const users = [
      OWNER,
      ...Array.from({ length: 10 }, (_, index) => `observer-${index}`),
    ];
    for (const [index, user] of users.entries()) {
      const cookie = `cookie-${index}`;
      if (user !== OWNER) {
        store.registerUserSession(
          hashSessionToken(cookie),
          { id: user, role: "USER" },
          new Date(Date.now() + 60 * 60_000),
        );
        store.addObserverSeat(MISSION, user);
      }
      const token = signStreamToken(
        { missionId: MISSION, userId: user, expiresAt: new Date(Date.now() + 300_000) },
        SECRET,
      );
      viewers.push({
        kind: "full",
        stream: watch(`/stream/mission/${MISSION}?t=${encodeURIComponent(token)}`, {
          cookie: `darkview_session=${user === OWNER ? OWNER_COOKIE : cookie}`,
        }),
      });
    }
    for (let index = 0; index < SPECTATOR_CAPACITY; index += 1) {
      viewers.push({ kind: "spectator", stream: watch(spectate) });
    }
    await wait(300);
    const over = await fetch(`${origin}${spectate}`);

    // A frame every half second for nine seconds: eighteen more.
    for (let index = 0; index < 18; index += 1) {
      await wait(500);
      live.publish(frame());
    }
    await wait(300);

    const full = viewers.filter((viewer) => viewer.kind === "full");
    const spectators = viewers.filter((viewer) => viewer.kind === "spectator");
    expect(full).toHaveLength(11);
    expect(spectators).toHaveLength(SPECTATOR_CAPACITY);
    expect(over.status).toBe(503);
    for (const viewer of viewers) expect(viewer.stream.state.status).toBe(200);
    // Every full viewer saw (nearly) every frame.
    for (const viewer of full)
      expect(viewer.stream.state.parts).toBeGreaterThanOrEqual(17);
    // A spectator saw one every four seconds: the first, then two or three more.
    const expected = Math.floor(9000 / SPECTATOR_FRAME_INTERVAL_MS) + 1;
    for (const viewer of spectators) {
      expect(viewer.stream.state.parts).toBeGreaterThanOrEqual(expected - 1);
      expect(viewer.stream.state.parts).toBeLessThanOrEqual(expected + 1);
    }
    for (const viewer of viewers) viewer.stream.stop();
  }, 30_000);
});
