import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const findMany = vi.fn();
vi.mock("@/lib/db/client", () => ({
  getDatabase: () => ({ auditLog: { findMany } }),
}));

const { listAuditEvents, pageLimitOf, toContractAuditEvent, MAX_PAGE_LIMIT } =
  await import("@/features/audit/logs");
const { zAuditEvent, zAuditEventPage } = await import("@darkview/contracts/zod");

const AT = new Date("2026-07-15T20:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    createdAt: AT,
    category: "COMMAND" as const,
    action: "COMMAND_MINTED",
    actorUserId: randomUUID(),
    missionId: randomUUID(),
    commandId: randomUUID(),
    entityType: null,
    entityId: null,
    metadata: { commandType: "NUDGE" },
    ...overrides,
  };
}

describe("the contract shape of an audit event", () => {
  it("is what the generated validator accepts", () => {
    expect(() => zAuditEvent.parse(toContractAuditEvent(row()))).not.toThrow();
  });

  it("never lets actorHash across the boundary", () => {
    const event = toContractAuditEvent(row({ actorUserId: null }));

    // AuditEvent does not declare it, and it identifies an address the system
    // deliberately does not store. `strictObject` would reject it anyway; this
    // asserts the mapping never offers it in the first place.
    expect(event).not.toHaveProperty("actorHash");
    expect(JSON.stringify(event)).not.toContain("actorHash");
  });

  it("folds entityType and entityId into detail rather than inventing fields", () => {
    const observatoryId = randomUUID();
    const event = toContractAuditEvent(
      row({ entityType: "Observatory", entityId: observatoryId, metadata: null }),
    );

    expect(event.detail).toEqual({
      entityType: "Observatory",
      entityId: observatoryId,
    });
    expect(() => zAuditEvent.parse(event)).not.toThrow();
  });

  it("omits detail entirely when there is none", () => {
    const event = toContractAuditEvent(row({ metadata: null }));
    expect(event).not.toHaveProperty("detail");
  });
});

describe("paging", () => {
  it("clamps the limit to the contract's range and defaults to twenty", () => {
    expect(pageLimitOf(null)).toBe(20);
    expect(pageLimitOf("not a number")).toBe(20);
    expect(pageLimitOf("0")).toBe(1);
    expect(pageLimitOf("1000")).toBe(MAX_PAGE_LIMIT);
    expect(pageLimitOf("7")).toBe(7);
  });

  it("asks for one more row than the page, and reports the surplus as hasMore", async () => {
    const rows = [row(), row(), row()];
    findMany.mockResolvedValueOnce(rows);

    const page = await listAuditEvents({ limit: 2 });

    expect(findMany.mock.calls[0]?.[0]).toMatchObject({ take: 3 });
    expect(page.items).toHaveLength(2);
    expect(page.page).toEqual({ hasMore: true, nextCursor: rows[1]?.id });
    expect(() => zAuditEventPage.parse(page)).not.toThrow();
  });

  it("reports no cursor on the last page", async () => {
    findMany.mockResolvedValueOnce([row()]);

    const page = await listAuditEvents({ limit: 20 });

    expect(page.page).toEqual({ hasMore: false, nextCursor: null });
  });

  it("orders by a stable key, not by timestamp alone", async () => {
    findMany.mockResolvedValueOnce([]);

    await listAuditEvents({ limit: 20 });

    // Two rows written in the same millisecond would otherwise page in whatever
    // order the database chose that time, and a keyset cursor over an unstable
    // order skips rows.
    expect(findMany.mock.calls.at(-1)?.[0]).toMatchObject({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  });

  it("skips the cursor row rather than repeating it", async () => {
    findMany.mockResolvedValueOnce([]);
    const cursor = randomUUID();

    await listAuditEvents({ limit: 20, cursor });

    expect(findMany.mock.calls.at(-1)?.[0]).toMatchObject({
      cursor: { id: cursor },
      skip: 1,
    });
  });
});

describe("filtering", () => {
  it("filters by mission and category when asked, and by neither when not", async () => {
    const missionId = randomUUID();
    findMany.mockResolvedValue([]);

    await listAuditEvents({ limit: 20, missionId, category: "SAFETY" });
    expect(findMany.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { missionId, category: "SAFETY" },
    });

    await listAuditEvents({ limit: 20 });
    expect(findMany.mock.calls.at(-1)?.[0]).toMatchObject({ where: {} });
  });
});
