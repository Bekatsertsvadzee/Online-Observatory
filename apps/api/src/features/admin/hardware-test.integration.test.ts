import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase, environment } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
  environment: {
    NODE_ENV: "test",
    DARKVIEW_DEPLOYMENT: "demo" as "production" | "demo",
    DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID: undefined as string | undefined,
  },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));
vi.mock("@/lib/validation/env", () => ({ getServerEnvironment: () => environment }));

const { setObservatoryMode } = await import("@/features/admin/observatory");
const { listObservatoriesForOperator } = await import("@/features/admin/observatories");
const { zAdminObservatoryList } = await import("@darkview/contracts/zod");

/**
 * ADR-074 against a real PostgreSQL instance: the demo's hardware test observatory,
 * which the operator console lists although no customer can book it, and which never
 * goes onto real hardware once it can be booked.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const NOW = new Date("2026-07-15T20:00:00.000Z");

let database: PrismaClient;
let operatorId: string;

async function observatory(slug: string) {
  return database.observatory.create({
    data: {
      slug: `${slug}-${randomUUID()}`,
      nameEn: slug,
      nameKa: slug,
      city: "Tbilisi",
      countryCode: "GE",
      latitude: 41.7151,
      longitude: 44.8271,
      timezone: "Asia/Tbilisi",
    },
  });
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING }),
  });
  testDatabase.current = database;
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(async () => {
  environment.DARKVIEW_DEPLOYMENT = "demo";
  environment.DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID = undefined;
  // CASCADE: other files leave captures, bookings and missions behind, and a
  // deleteMany chain here would have to know every one of them.
  await database.$executeRawUnsafe('TRUNCATE "AuditLog", "Observatory", "User" CASCADE');

  const operator = await database.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      name: "Operator",
      role: "OPERATOR",
      emailVerifiedAt: NOW,
    },
  });
  operatorId = operator.id;
});

describe("the operator's list of observatories", () => {
  it("lists every observatory, bookable or not, and marks the hardware test one", async () => {
    const demo = await observatory("demo");
    await database.observatoryNetworkNode.create({
      data: {
        ownerId: operatorId,
        observatoryId: demo.id,
        kind: "FIRST_PARTY",
        approvalStatus: "APPROVED",
      },
    });
    const test = await observatory("hardware-test");
    environment.DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID = test.id;

    const list = zAdminObservatoryList.parse(await listObservatoriesForOperator());

    expect(list.items.map((item) => item.id)).toEqual([demo.id, test.id]);
    expect(list.items[0]).toMatchObject({
      hardwareTest: false,
      kind: "FIRST_PARTY",
      approvalStatus: "APPROVED",
    });
    expect(list.items[1]).toMatchObject({
      hardwareTest: true,
      kind: null,
      approvalStatus: null,
      mode: "SIMULATED",
    });
  });
});

describe("REAL on a demo deployment (ADR-074)", () => {
  const real = (observatoryId: string) =>
    setObservatoryMode({
      observatoryId,
      actorUserId: operatorId,
      request: { mode: "REAL", reason: "first light", attendedOperatorPresent: true },
    });

  it("lets the hardware test observatory switch to REAL", async () => {
    const test = await observatory("hardware-test");
    environment.DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID = test.id;

    await expect(real(test.id)).resolves.toMatchObject({ ok: true, mode: "REAL" });
  });

  it("refuses the hardware test observatory once a customer could book it", async () => {
    const test = await observatory("hardware-test");
    await database.observatoryNetworkNode.create({
      data: {
        ownerId: operatorId,
        observatoryId: test.id,
        kind: "FIRST_PARTY",
        approvalStatus: "APPROVED",
      },
    });
    environment.DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID = test.id;

    await expect(real(test.id)).resolves.toMatchObject({ ok: false, status: 403 });
    const row = await database.observatory.findUniqueOrThrow({ where: { id: test.id } });
    expect(row.mode).toBe("SIMULATED");
  });

  it("refuses every other observatory", async () => {
    const test = await observatory("hardware-test");
    const other = await observatory("demo");
    environment.DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID = test.id;

    await expect(real(other.id)).resolves.toMatchObject({ ok: false, status: 403 });
  });
});
