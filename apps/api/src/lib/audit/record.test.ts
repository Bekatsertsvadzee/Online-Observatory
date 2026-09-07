import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { assertDetailCarriesNoSecret, recordAuditEvent } =
  await import("@darkview/db/audit");

/**
 * The recorder lives in `packages/db`, because both services write audit rows and
 * one vocabulary is better than two. Its tests live here, because this is where a
 * test runner already exists; adding vitest to the database package to hold two
 * describe blocks would be more machinery than the thing being tested.
 */
function fakeWriter() {
  const rows: unknown[] = [];
  return {
    rows,
    writer: {
      auditLog: {
        create: async ({ data }: { data: unknown }) => {
          rows.push(data);
          return data;
        },
      },
    } as never,
  };
}

describe("what an audit row may carry", () => {
  it.each([
    ["deviceToken", { deviceToken: "abc" }],
    ["a nested naming", { agentSecret: "abc" }],
    ["password", { password: "abc" }],
    ["authorization", { authorization: "Bearer abc" }],
  ])("refuses a detail carrying %s", async (_label, detail) => {
    expect(() => assertDetailCarriesNoSecret(detail)).toThrow(/may not carry a secret/);
  });

  it("refuses the write itself, rather than redacting it", async () => {
    const { rows, writer } = fakeWriter();

    await expect(
      recordAuditEvent(
        {
          category: "AGENT_LINK",
          action: "AGENT_LINK_UP",
          detail: { deviceTokenHash: "abc" },
        },
        writer,
      ),
    ).rejects.toThrow(/may not carry a secret/);

    // A redacted row would hide that a call site tried. Nothing is written.
    expect(rows).toEqual([]);
  });

  it("allows ordinary operational detail", async () => {
    const { rows, writer } = fakeWriter();

    await recordAuditEvent(
      {
        category: "SAFETY",
        action: "SAFETY_ENVELOPE_RECORDED",
        detail: { maxAltitudeDegrees: null, measurementTransition: "UNCHANGED" },
      },
      writer,
    );

    expect(rows).toHaveLength(1);
  });
});

describe("the shape of a written row", () => {
  it("writes nulls rather than leaving fields undefined", async () => {
    const { rows, writer } = fakeWriter();

    await recordAuditEvent(
      { category: "AUTH", action: "LOGIN_FAILED", actorHash: "hashed" },
      writer,
    );

    expect(rows[0]).toMatchObject({
      category: "AUTH",
      action: "LOGIN_FAILED",
      actorUserId: null,
      actorHash: "hashed",
      missionId: null,
      commandId: null,
      entityType: null,
      entityId: null,
      isDemo: false,
    });
  });

  it("takes no timestamp from its caller", async () => {
    const { rows, writer } = fakeWriter();

    await recordAuditEvent({ category: "AUTH", action: "LOGGED_OUT" }, writer);

    // AuditEvent: "never backdated". `createdAt` is the database's default and
    // there is no parameter that could override it -- which is what makes
    // backdating impossible rather than merely discouraged.
    expect(rows[0]).not.toHaveProperty("createdAt");
  });
});
