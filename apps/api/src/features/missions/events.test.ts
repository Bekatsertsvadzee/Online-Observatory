import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const findUnique = vi.fn();
const findMany = vi.fn();
vi.mock("@/lib/db/client", () => ({
  getDatabase: () => ({
    mission: { findUnique },
    missionEvent: { findMany },
  }),
}));

const { listMissionEvents, toContractMissionEvent } =
  await import("@/features/missions/events");
const { zMissionEvent, zMissionEventPage } = await import("@darkview/contracts/zod");

beforeEach(() => {
  findUnique.mockReset();
  findMany.mockReset();
});

const OWNER = randomUUID();
const MISSION = randomUUID();
const OCCURRED_AT = new Date("2026-07-15T20:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    missionId: MISSION,
    occurredAt: OCCURRED_AT,
    state: "SLEWING" as const,
    failureReason: null,
    source: "AGENT" as const,
    commandId: null,
    message: null,
    ...overrides,
  };
}

describe("who may read a mission's trail", () => {
  it("gives the owner their own", async () => {
    findUnique.mockResolvedValueOnce({ userId: OWNER });
    findMany.mockResolvedValueOnce([row()]);

    const result = await listMissionEvents({
      missionId: MISSION,
      actor: { id: OWNER, role: "USER" },
    });

    expect(result.ok).toBe(true);
  });

  it("answers 404 for somebody else's mission, not 403", async () => {
    findUnique.mockResolvedValueOnce({ userId: OWNER });

    const result = await listMissionEvents({
      missionId: MISSION,
      actor: { id: randomUUID(), role: "USER" },
    });

    // Existence is private. A 403 would confirm the mission is real to a stranger
    // walking mission ids, which is the same answer the rest of the mission
    // surface refuses to give.
    expect(result).toEqual({ ok: false, status: 404 });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("gives an operator anyone's", async () => {
    findUnique.mockResolvedValueOnce({ userId: OWNER });
    findMany.mockResolvedValueOnce([]);

    const result = await listMissionEvents({
      missionId: MISSION,
      actor: { id: randomUUID(), role: "OPERATOR" },
    });

    expect(result.ok).toBe(true);
  });

  it("answers 404 for a mission that does not exist", async () => {
    findUnique.mockResolvedValueOnce(null);

    const result = await listMissionEvents({
      missionId: MISSION,
      actor: { id: OWNER, role: "USER" },
    });

    expect(result).toEqual({ ok: false, status: 404 });
  });
});

describe("the trail itself", () => {
  it("is ordered by the observatory's clock, not by insert order", async () => {
    findUnique.mockResolvedValueOnce({ userId: OWNER });
    findMany.mockResolvedValueOnce([]);

    await listMissionEvents({ missionId: MISSION, actor: { id: OWNER, role: "USER" } });

    // A queue drained after an outage arrives late. Filing those events under the
    // moment the cloud received them would be a fabricated chronology of a real
    // telescope; `occurredAt` is replayed unchanged and is what orders them.
    expect(findMany.mock.calls.at(-1)?.[0]).toMatchObject({
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    });
  });

  it("carries the failure reason and the causing command of each event", async () => {
    const commandId = randomUUID();
    const event = toContractMissionEvent(
      row({ state: "FAILED", failureReason: "SLEW_TIMEOUT", commandId, message: "no" }),
    );

    // Both arrive on AgentMissionEvent and were dropped before DV-062: the
    // mission kept only its latest failure reason, and nothing recorded which
    // command produced which transition.
    expect(event.failureReason).toBe("SLEW_TIMEOUT");
    expect(event.commandId).toBe(commandId);
    expect(event.at).toBe(OCCURRED_AT.toISOString());
    expect(() => zMissionEvent.parse(event)).not.toThrow();
  });

  it("pages with a keyset cursor and validates against the contract", async () => {
    const rows = [row(), row(), row()];
    findUnique.mockResolvedValueOnce({ userId: OWNER });
    findMany.mockResolvedValueOnce(rows);

    const result = await listMissionEvents({
      missionId: MISSION,
      actor: { id: OWNER, role: "USER" },
      limit: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.items).toHaveLength(2);
    expect(result.page.page).toEqual({ hasMore: true, nextCursor: rows[1]?.id });
    expect(() => zMissionEventPage.parse(result.page)).not.toThrow();
  });
});
