import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ getDatabase: () => null }));

const { mayWatch } = await import("@/features/missions/watch");

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const privateLive = { ownerId: OWNER, joinPolicy: "DISABLED", state: "OBSERVING" };
const openLive = { ownerId: OWNER, joinPolicy: "OPEN", state: "OBSERVING" };

describe("mayWatch (ADR-034)", () => {
  it("lets the owner watch their own session, private or not, live or not", () => {
    expect(mayWatch({ ...privateLive, actorId: OWNER, seated: false })).toBe(true);
    expect(
      mayWatch({ ...privateLive, state: "COMPLETE", actorId: OWNER, seated: false }),
    ).toBe(true);
  });

  it("lets a seated observer watch", () => {
    expect(mayWatch({ ...privateLive, actorId: OTHER, seated: true })).toBe(true);
  });

  it("lets any signed-in user watch a live session its owner opened", () => {
    expect(mayWatch({ ...openLive, actorId: OTHER, seated: false })).toBe(true);
  });

  it("refuses a stranger on a private session", () => {
    expect(mayWatch({ ...privateLive, actorId: OTHER, seated: false })).toBe(false);
  });

  it("refuses a stranger on an opened session that is no longer live", () => {
    for (const state of ["SCHEDULED", "COMPLETE", "CANCELLED", "FAILED"]) {
      expect(mayWatch({ ...openLive, state, actorId: OTHER, seated: false })).toBe(false);
    }
  });
});
