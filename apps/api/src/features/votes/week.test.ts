import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ getDatabase: () => ({}) }));

const { addDays, isMonday, localDateOf, locksAtOf, weekOf } = await import("./week");

describe("the week's calendar", () => {
  it("names a week by its Monday, on the calendar and not the clock", () => {
    expect(weekOf("2026-10-16")).toBe("2026-10-12");
    expect(weekOf("2026-10-12")).toBe("2026-10-12");
    expect(weekOf("2026-10-18")).toBe("2026-10-12");
    expect(weekOf("2026-11-01")).toBe("2026-10-26");
    expect(isMonday("2026-10-12")).toBe(true);
    expect(isMonday("2026-10-13")).toBe(false);
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
  });

  it("reads the local date in the observatory's zone, not the server's", () => {
    // 22:30 UTC is already the 17th in Tbilisi (UTC+4) and still the 16th in Santiago.
    const at = new Date("2026-10-16T22:30:00Z");
    expect(localDateOf(at, "Asia/Tbilisi")).toBe("2026-10-17");
    expect(localDateOf(at, "America/Santiago")).toBe("2026-10-16");
  });

  it("locks the ballot on the week's Sunday at 13:00 UTC", () => {
    expect(locksAtOf("2026-10-12").toISOString()).toBe("2026-10-18T13:00:00.000Z");
  });
});
