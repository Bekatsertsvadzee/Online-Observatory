import { beforeEach, describe, expect, it } from "vitest";

import { FakeLinkStore } from "@/link/fake-store";
import {
  sessionCookieName,
  authenticateClient,
  hashSessionToken,
  isAllowedOrigin,
  readCookie,
} from "@/auth/user-session";
import type { ChannelUser } from "@/mission/store";

const APP_URL = "https://darkview.ge";
const TOKEN = "a-browser-session-cookie-value";

const user: ChannelUser = { id: "44444444-4444-4444-8444-444444444444", role: "USER" };

let store: FakeLinkStore;
let now: Date;

beforeEach(() => {
  store = new FakeLinkStore();
  now = new Date("2026-09-07T21:00:00.000Z");
  store.registerUserSession(
    hashSessionToken(TOKEN),
    user,
    new Date(now.getTime() + 60 * 60_000),
  );
});

describe("origin", () => {
  it("accepts the app's own origin", () => {
    expect(isAllowedOrigin("https://darkview.ge", APP_URL)).toBe(true);
  });

  it("refuses another site", () => {
    // A WebSocket handshake is not subject to the same-origin policy, and the
    // browser attaches the customer's cookies to it regardless. Origin is the
    // only thing separating our page from someone else's.
    expect(isAllowedOrigin("https://darkview.ge.evil.example", APP_URL)).toBe(false);
    expect(isAllowedOrigin("http://darkview.ge", APP_URL)).toBe(false);
  });

  it("refuses a request with no origin at all", () => {
    // Browsers always send one on a WebSocket handshake. Something that does not
    // is not a browser, and this channel serves browsers.
    expect(isAllowedOrigin(undefined, APP_URL)).toBe(false);
  });

  it("refuses an unparseable origin rather than throwing", () => {
    expect(isAllowedOrigin("not a url", APP_URL)).toBe(false);
  });
});

describe("cookies", () => {
  it("finds a cookie among several", () => {
    expect(readCookie("theme=dark; darkview_session=abc; locale=ka", "darkview_session"))
      .toBe("abc");
  });

  it("takes the first of a repeated cookie, not the last", () => {
    // A duplicate is ambiguous. Taking the last would let an attacker-set
    // duplicate override the real one.
    expect(readCookie("s=real; s=injected", "s")).toBe("real");
  });

  it("does not match a name by suffix", () => {
    expect(readCookie("not_darkview_session=abc", "darkview_session")).toBeNull();
  });

  it("reads nothing from a missing header", () => {
    expect(readCookie(undefined, "darkview_session")).toBeNull();
  });
});

describe("authenticating a client", () => {
  it("resolves the signed-in user", async () => {
    const found = await authenticateClient(
      store,
      { cookie: `darkview_session=${TOKEN}` },
      now,
      "development",
    );
    expect(found).toEqual(user);
  });

  it("reads the __Host- prefixed name in production", async () => {
    // Duplicated from apps/api's cookies.ts because this service does not depend
    // on the Next.js app. If that name changes and this does not, production
    // stops authenticating anyone and this test is what says so.
    expect(sessionCookieName("production")).toBe("__Host-darkview_session");

    const found = await authenticateClient(
      store,
      { cookie: `__Host-darkview_session=${TOKEN}` },
      now,
      "production",
    );
    expect(found).toEqual(user);
  });

  it("refuses the unprefixed name in production", async () => {
    // The __Host- prefix is the browser's guarantee that no sibling subdomain set
    // this cookie. Accepting the development name as well in production would
    // hand that guarantee back: a subdomain may set `darkview_session` for
    // `.darkview.ge`, and the browser would attach it to this handshake.
    const found = await authenticateClient(
      store,
      { cookie: `darkview_session=${TOKEN}` },
      now,
      "production",
    );
    expect(found).toBeNull();
  });

  it("refuses the __Host- name outside production, where nothing sets it", async () => {
    const found = await authenticateClient(
      store,
      { cookie: `__Host-darkview_session=${TOKEN}` },
      now,
      "development",
    );
    expect(found).toBeNull();
  });

  it("refuses an unknown token", async () => {
    expect(await authenticateClient(store, { cookie: "darkview_session=guessed" }, now)).toBeNull();
  });

  it("refuses a lapsed session", async () => {
    const later = new Date(now.getTime() + 61 * 60_000);
    expect(await authenticateClient(store, { cookie: `darkview_session=${TOKEN}` }, later)).toBeNull();
  });

  it("refuses a request carrying no cookie", async () => {
    expect(await authenticateClient(store, {}, now)).toBeNull();
  });

  it("never asks storage for the token itself", async () => {
    // Only the SHA-256 crosses this line, the same rule the device token follows.
    const asked: string[] = [];
    const spy = {
      ...store,
      findUserBySessionTokenHash: async (hash: string) => {
        asked.push(hash);
        return null;
      },
      loadMissionSnapshot: store.loadMissionSnapshot.bind(store),
      hasObserverSeat: store.hasObserverSeat.bind(store),
      mayWatchMission: store.mayWatchMission.bind(store),
      isOnTonight: store.isOnTonight.bind(store),
    };

    await authenticateClient(spy, { cookie: `darkview_session=${TOKEN}` }, now);

    expect(asked).not.toContain(TOKEN);
    expect(asked).toEqual([hashSessionToken(TOKEN)]);
  });
});

describe("a native client's bearer session (ADR-061)", () => {
  const NATIVE = "a-native-session-token-of-forty-three-chars";

  beforeEach(() => {
    store.registerUserSession(
      hashSessionToken(NATIVE),
      user,
      new Date(now.getTime() + 60 * 60_000),
      "NATIVE",
    );
  });

  it("resolves a NATIVE session from Authorization: Bearer", async () => {
    expect(await authenticateClient(store, { authorization: `Bearer ${NATIVE}` }, now)).toEqual(
      user,
    );
  });

  it("refuses a WEB session's token presented as a bearer", async () => {
    // A cookie session's token must not be replayable outside a cookie.
    const webToken = "a-browser-session-cookie-value-long-enough";
    store.registerUserSession(hashSessionToken(webToken), user, new Date(now.getTime() + 60_000));
    expect(await authenticateClient(store, { authorization: `Bearer ${webToken}` }, now)).toBeNull();
  });

  it("refuses a NATIVE token presented as the cookie", async () => {
    expect(
      await authenticateClient(store, { cookie: `darkview_session=${NATIVE}` }, now, "development"),
    ).toBeNull();
  });

  it("judges by the header alone: a malformed one is not rescued by a good cookie", async () => {
    expect(
      await authenticateClient(
        store,
        { authorization: "Basic dXNlcjpwYXNz", cookie: `darkview_session=${TOKEN}` },
        now,
        "development",
      ),
    ).toBeNull();
  });

  it("refuses a lapsed native session", async () => {
    const later = new Date(now.getTime() + 61 * 60_000);
    expect(
      await authenticateClient(store, { authorization: `Bearer ${NATIVE}` }, later),
    ).toBeNull();
  });
});
