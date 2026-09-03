import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ObservatoryAdapter } from "@/lib/observatory/adapter";
import { RealObservatoryAdapter } from "@/lib/observatory/real-adapter";

describe("RealObservatoryAdapter", () => {
  it("fails every operation explicitly while no real protocol is configured", async () => {
    const adapter: ObservatoryAdapter = new RealObservatoryAdapter();
    const command = {
      commandId: "command-1",
      missionId: "mission-1",
      userId: "operator-1",
      issuedAt: "2026-08-26T19:59:00.000Z",
      expiresAt: "2026-08-26T20:01:00.000Z",
    };
    const failures = [
      adapter.getStatus(),
      adapter.getCurrentTarget(),
      adapter.getCoordinates(),
      adapter.startMission({
        ...command,
        target: { id: "saturn", catalogId: "SATURN", nameEn: "Saturn" },
        coordinates: {
          rightAscensionHours: 23.4,
          declinationDegrees: -5.2,
          epoch: "J2000",
        },
      }),
      adapter.abortMission({ ...command, reason: "Safety hold" }),
      adapter.park(command),
      adapter.capture({ ...command, preset: "NATURAL" }),
      adapter.getPreview(),
      adapter.getMissionEvents("mission-1"),
    ];

    for (const failure of failures) {
      await expect(failure).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    }
  });
});
