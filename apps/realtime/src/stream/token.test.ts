import { describe, expect, it } from "vitest";

import {
  STREAM_TOKEN_TTL_SECONDS,
  signStreamToken,
  verifyStreamToken,
} from "@/stream/token";

const SECRET = "a-stream-signing-secret-of-at-least-32-characters";
const OTHER_SECRET = "a-different-signing-secret-also-32-characters-long";

const MISSION = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const OTHER_USER = "44444444-4444-4444-8444-444444444444";

const now = new Date("2026-09-08T21:00:00.000Z");
const expiresAt = new Date(now.getTime() + STREAM_TOKEN_TTL_SECONDS * 1000);

describe("what a stream token proves", () => {
  it("round-trips the mission, the viewer and the deadline", () => {
    const token = signStreamToken({ missionId: MISSION, userId: USER, expiresAt }, SECRET);
    const verdict = verifyStreamToken(token, SECRET, now);

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.grant.missionId).toBe(MISSION);
    expect(verdict.grant.userId).toBe(USER);
    expect(verdict.grant.expiresAt.toISOString()).toBe(expiresAt.toISOString());
  });

  it("names the viewer, so one customer's URL is not another's", () => {
    // The heart of it. Without userId inside the signature a token would prove
    // only that somebody was granted this mission, and a URL copied out of one
    // customer's page would serve any other signed-in customer.
    const mine = signStreamToken({ missionId: MISSION, userId: USER, expiresAt }, SECRET);
    const theirs = signStreamToken(
      { missionId: MISSION, userId: OTHER_USER, expiresAt },
      SECRET,
    );

    expect(mine).not.toBe(theirs);

    const verdict = verifyStreamToken(mine, SECRET, now);
    expect(verdict.ok && verdict.grant.userId).toBe(USER);
  });

  it("refuses a token signed with a different key", () => {
    const forged = signStreamToken(
      { missionId: MISSION, userId: USER, expiresAt },
      OTHER_SECRET,
    );

    expect(verifyStreamToken(forged, SECRET, now)).toEqual({
      ok: false,
      reason: "bad signature",
    });
  });

  it("refuses a payload edited after signing", () => {
    // Escalation attempt: keep the signature, swap the viewer.
    const token = signStreamToken({ missionId: MISSION, userId: USER, expiresAt }, SECRET);
    const signature = token.slice(token.indexOf(".") + 1);
    const swapped = Buffer.from(
      `${MISSION}:${OTHER_USER}:${Math.floor(expiresAt.getTime() / 1000)}`,
      "utf8",
    ).toString("base64url");

    expect(verifyStreamToken(`${swapped}.${signature}`, SECRET, now)).toEqual({
      ok: false,
      reason: "bad signature",
    });
  });

  it("refuses a token past its deadline", () => {
    const token = signStreamToken({ missionId: MISSION, userId: USER, expiresAt }, SECRET);

    expect(verifyStreamToken(token, SECRET, expiresAt).ok).toBe(false);
    expect(
      verifyStreamToken(token, SECRET, new Date(expiresAt.getTime() - 1)).ok,
    ).toBe(true);
  });

  it("refuses rubbish without throwing", () => {
    // Anything reachable from a query string. A throw here would be a 500 on a
    // public path, which is both a crash and a way to tell the shapes apart.
    for (const rubbish of ["", ".", "nonsense", "a.b", "....", "%%%.%%%"]) {
      expect(() => verifyStreamToken(rubbish, SECRET, now)).not.toThrow();
      expect(verifyStreamToken(rubbish, SECRET, now).ok).toBe(false);
    }
  });
});
