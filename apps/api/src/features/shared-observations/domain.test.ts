import { describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "@/lib/auth/types";

import { authorizeSharedMission, canSaveSharedCapture } from "./domain";

const viewer: AuthenticatedUser = {
  id: "viewer-1",
  email: "viewer@example.com",
  name: "Viewer",
  role: "USER",
  locale: "en",
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
};

const mission = {
  id: "mission-1",
  ownerId: "owner-1",
  state: "OBSERVING",
  sharingMode: "PUBLIC" as const,
  joinPolicy: "OPEN" as const,
  allowSharedCaptures: true,
};

describe("shared mission authorization", () => {
  it("lets an authenticated viewer watch and join without control permission", () => {
    expect(authorizeSharedMission(viewer, mission)).toEqual({
      canView: true,
      canJoin: true,
      canControl: false,
    });
  });

  it("does not expose private missions to unrelated viewers", () => {
    expect(
      authorizeSharedMission(viewer, { ...mission, sharingMode: "PRIVATE" }),
    ).toMatchObject({ canView: false, canControl: false, reason: "MISSION_PRIVATE" });
  });

  it("recognizes the owner and operators as controllers", () => {
    expect(authorizeSharedMission({ ...viewer, id: "owner-1" }, mission)).toMatchObject({
      canView: true,
      canJoin: false,
      canControl: true,
    });
    expect(
      authorizeSharedMission({ ...viewer, role: "OPERATOR" }, mission),
    ).toMatchObject({
      canView: true,
      canJoin: false,
      canControl: true,
    });
  });
});

describe("shared capture access", () => {
  it("allows an explicitly granted joined viewer to save a capture", () => {
    expect(
      canSaveSharedCapture({
        actorId: viewer.id,
        mission,
        capture: { missionId: mission.id, ownerId: "owner-1" },
        participant: { status: "JOINED", canSaveCaptures: true },
        access: { missionId: mission.id, status: "AVAILABLE" },
      }),
    ).toBe(true);
  });

  it.each([
    ["not joined", null, { missionId: mission.id, status: "AVAILABLE" }],
    [
      "permission disabled",
      { status: "JOINED", canSaveCaptures: false },
      { missionId: mission.id, status: "AVAILABLE" },
    ],
    [
      "grant revoked",
      { status: "JOINED", canSaveCaptures: true },
      { missionId: mission.id, status: "REVOKED" },
    ],
  ] as const)("rejects a viewer when %s", (_label, participant, access) => {
    expect(
      canSaveSharedCapture({
        actorId: viewer.id,
        mission,
        capture: { missionId: mission.id, ownerId: "owner-1" },
        participant,
        access,
      }),
    ).toBe(false);
  });
});
