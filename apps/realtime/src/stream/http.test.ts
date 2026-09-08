import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashSessionToken } from "@/auth/user-session";
import { FakeLinkStore } from "@/link/fake-store";
import { handleStreamRequest } from "@/stream/http";
import { LiveStream } from "@/stream/live-stream";
import type { LiveFrame } from "@/stream/frames";
import { signStreamToken } from "@/stream/token";

const APP_URL = "https://darkview.test";
const SECRET = "a-stream-signing-secret-of-at-least-32-characters";

const OBSERVATORY = "11111111-1111-4111-8111-111111111111";
const MISSION = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const STRANGER = "44444444-4444-4444-8444-444444444444";
const OBSERVER = "66666666-6666-4666-8666-666666666666";
const SECOND_OBSERVER = "88888888-8888-4888-8888-888888888888";

const COOKIE = "a-browser-session-token";
const STRANGER_COOKIE = "another-browser-session-token";
const OBSERVER_COOKIE = "an-observer-browser-session-token";
const SECOND_OBSERVER_COOKIE = "a-second-observer-browser-session-token";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

let store: FakeLinkStore;
let live: LiveStream;
let server: Server;
let origin: string;
let now: Date;

function frame(overrides: Partial<LiveFrame> = {}): LiveFrame {
  return {
    missionId: MISSION,
    observatoryId: OBSERVATORY,
    mode: "SIMULATED",
    encoding: "JPEG",
    sequence: 0,
    bytes: JPEG,
    receivedAt: now.getTime(),
    ...overrides,
  };
}

function tokenFor(userId: string, missionId = MISSION, ttlSeconds = 300): string {
  return signStreamToken(
    {
      missionId,
      userId,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    },
    SECRET,
  );
}

function get(path: string, cookie: string | null = COOKIE) {
  return fetch(`${origin}${path}`, {
    headers: cookie ? { cookie: `darkview_session=${cookie}` } : {},
  });
}

beforeEach(async () => {
  now = new Date("2026-09-08T21:00:00.000Z");
  store = new FakeLinkStore();
  live = new LiveStream(APP_URL, SECRET);

  const later = new Date(now.getTime() + 60 * 60_000);
  store.registerUserSession(hashSessionToken(COOKIE), { id: OWNER, role: "USER" }, later);
  store.registerUserSession(
    hashSessionToken(STRANGER_COOKIE),
    { id: STRANGER, role: "USER" },
    later,
  );
  store.registerUserSession(
    hashSessionToken(OBSERVER_COOKIE),
    { id: OBSERVER, role: "USER" },
    later,
  );
  store.registerUserSession(
    hashSessionToken(SECOND_OBSERVER_COOKIE),
    { id: SECOND_OBSERVER, role: "USER" },
    later,
  );

  store.addMission(MISSION, { observatoryId: OBSERVATORY, state: "OBSERVING" });
  store.setActiveSession(OBSERVATORY, {
    sessionId: "77777777-7777-4777-8777-777777777777",
    missionId: MISSION,
    userId: OWNER,
    expiresAt: later,
  });

  server = createServer((request, response) => {
    void handleStreamRequest(
      { store, stream: live, now: () => now },
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Every refusal is the same 404. These are separate tests rather than a table
 * because each is a different way in, and one of them regressing while the others
 * hold is exactly the failure a table would hide behind a single name.
 */
describe("who is refused, and how", () => {
  it("refuses a request with no session cookie", async () => {
    live.publish(frame());
    const response = await get(`/stream/mission/${MISSION}?t=${tokenFor(OWNER)}`, null);
    expect(response.status).toBe(404);
  });

  it("refuses a request with no token", async () => {
    live.publish(frame());
    expect((await get(`/stream/mission/${MISSION}`)).status).toBe(404);
  });

  it("refuses a forged token", async () => {
    live.publish(frame());
    const forged = signStreamToken(
      { missionId: MISSION, userId: OWNER, expiresAt: new Date(now.getTime() + 300_000) },
      "a-completely-different-secret-32-characters-long",
    );
    expect((await get(`/stream/mission/${MISSION}?t=${forged}`)).status).toBe(404);
  });

  it("refuses an expired token", async () => {
    live.publish(frame());
    const stale = signStreamToken(
      { missionId: MISSION, userId: OWNER, expiresAt: new Date(now.getTime() - 1) },
      SECRET,
    );
    expect((await get(`/stream/mission/${MISSION}?t=${stale}`)).status).toBe(404);
  });

  it("refuses somebody else's token, even signed in", async () => {
    // The whole point of naming the viewer inside the signature: a URL lifted
    // from the owner's page must not work for another signed-in customer.
    live.publish(frame());
    const response = await get(
      `/stream/mission/${MISSION}?t=${tokenFor(OWNER)}`,
      STRANGER_COOKIE,
    );
    expect(response.status).toBe(404);
  });

  it("refuses a token minted for another viewer who is also entitled", async () => {
    // The sharper version of the test above. When the impostor is a stranger, the
    // entitlement check alone would refuse them and the userId inside the
    // signature would be doing nothing. Here both people hold a seat on the same
    // mission, so the *only* thing that separates them is whose name the token
    // carries -- which is what makes it a URL for one customer rather than a
    // password for the mission.
    live.publish(frame());
    store.addObserverSeat(MISSION, OBSERVER);
    store.addObserverSeat(MISSION, SECOND_OBSERVER);

    const theirs = tokenFor(OBSERVER);

    expect(
      (await get(`/stream/mission/${MISSION}?t=${theirs}`, OBSERVER_COOKIE)).status,
    ).toBe(200);
    expect(
      (await get(`/stream/mission/${MISSION}?t=${theirs}`, SECOND_OBSERVER_COOKIE))
        .status,
    ).toBe(404);
  });

  it("refuses a token minted for a different mission", async () => {
    live.publish(frame());
    const elsewhere = tokenFor(OWNER, "55555555-5555-4555-8555-555555555555");
    expect((await get(`/stream/mission/${MISSION}?t=${elsewhere}`)).status).toBe(404);
  });

  it("refuses a viewer whose entitlement has since been withdrawn", async () => {
    // A valid, unexpired token held by an observer the controller has closed the
    // mission against. If the token alone were enough this would keep serving for
    // the rest of its five minutes.
    live.publish(frame());
    store.addObserverSeat(MISSION, OBSERVER);
    const token = tokenFor(OBSERVER);

    expect(
      (await get(`/stream/mission/${MISSION}?t=${token}`, OBSERVER_COOKIE)).status,
    ).toBe(200);

    store.closeToObservers(MISSION);

    expect(
      (await get(`/stream/mission/${MISSION}?t=${token}`, OBSERVER_COOKIE)).status,
    ).toBe(404);
  });

  it("answers a mission with no frames the same as a mission that does not exist", async () => {
    const unknown = "99999999-9999-4999-8999-999999999999";

    const noFrames = await get(`/stream/mission/${MISSION}?t=${tokenFor(OWNER)}`);
    const noMission = await get(
      `/stream/mission/${unknown}?t=${tokenFor(OWNER, unknown)}`,
    );

    expect(noFrames.status).toBe(404);
    expect(noMission.status).toBe(404);
    expect(await noFrames.text()).toBe(await noMission.text());
  });

  it("refuses a method other than GET", async () => {
    live.publish(frame());
    const response = await fetch(
      `${origin}/stream/mission/${MISSION}?t=${tokenFor(OWNER)}`,
      { method: "POST", headers: { cookie: `darkview_session=${COOKIE}` } },
    );
    expect(response.status).toBe(404);
  });

  it("leaves paths that are not a stream alone", async () => {
    expect((await get("/")).status).toBe(404);
    expect((await get("/stream/mission/not-a-uuid")).status).toBe(404);
  });
});

describe("what a viewer receives", () => {
  it("serves the current frame as replacing multipart", async () => {
    live.publish(frame());
    const response = await get(`/stream/mission/${MISSION}?t=${tokenFor(OWNER)}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(
      /^multipart\/x-mixed-replace; boundary=darkview-/,
    );
    // Never cached. A cached frame is a stale telescope image presented as current.
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const body = await readSome(response, 1);
    expect(body).toContain("Content-Type: image/jpeg");
    expect(body).toContain(`Content-Length: ${JPEG.byteLength}`);
    live.release(MISSION);
  });

  it("writes each new frame as it arrives", async () => {
    live.publish(frame({ sequence: 0, bytes: Buffer.from("first-frame") }));
    const response = await get(`/stream/mission/${MISSION}?t=${tokenFor(OWNER)}`);

    const reader = response.body!.getReader();
    let seen = await pull(reader);

    live.publish(frame({ sequence: 1, bytes: Buffer.from("second-frame") }));
    seen += await pull(reader);

    expect(seen).toContain("first-frame");
    expect(seen).toContain("second-frame");
    live.release(MISSION);
  });

  it("ends the response when the mission is released", async () => {
    // A customer must not be left watching a still image of a mission that ended.
    live.publish(frame());
    const response = await get(`/stream/mission/${MISSION}?t=${tokenFor(OWNER)}`);
    const reader = response.body!.getReader();
    await pull(reader);

    live.release(MISSION);

    expect((await reader.read()).done).toBe(true);
  });

  it("admits an observer holding a seat", async () => {
    // ADR-011: observers read the same per-mission frame. A permission question,
    // not a plumbing one.
    live.publish(frame());
    store.addObserverSeat(MISSION, OBSERVER);

    const response = await get(
      `/stream/mission/${MISSION}?t=${tokenFor(OBSERVER)}`,
      OBSERVER_COOKIE,
    );

    expect(response.status).toBe(200);
    live.release(MISSION);
  });
});

/** Read `parts` chunks of the body and give up the rest. */
async function readSome(response: Response, parts: number): Promise<string> {
  const reader = response.body!.getReader();
  let out = "";
  for (let index = 0; index < parts; index += 1) out += await pull(reader);
  void reader.cancel();
  return out;
}

async function pull(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value } = await reader.read();
  return value ? Buffer.from(value).toString("binary") : "";
}
