import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@darkview/db";

import type { ForecastHour, ForecastSource } from "@/conditions/forecast";
import { refreshViewingConditions } from "@/conditions/forecast";
import { sweepSeconds } from "@/deployment";
import { AgentLink } from "@/link/agent-link";
import { AgentRelay } from "@/link/agent-relay";
import { FAKE_STORAGE } from "@/link/fake-storage";
import { createPrismaStore, type RealtimeStore } from "@/link/prisma-store";
import { PROTOCOL_VERSION } from "@/link/protocol";
import { AgentLinkRegistry } from "@/link/registry";
import { RecordingBroadcast } from "@/mission/fake-broadcast";
import { dispatchPendingEmails, queueSlotReminders } from "@/notifications/email";
import { evaluateEndedSlots, refundExpiredEntitlements } from "@/refunds/entitlements";
import { createSandboxCharger, sweepSubscriptions } from "@/subscriptions/renewals";

/**
 * The hosted demo's free database plan was suspended after 101.8k operations in three
 * weeks (#196). This suite replays one idle demo hour against a real PostgreSQL and
 * counts every row written, so a change that brings back a write per heartbeat or a
 * write per empty sweep fails here instead of on the demo's bill.
 *
 * Idle means: two simulated observatories connected, each heartbeating every five
 * seconds with an unchanged posture, no customer, no booking, no mission. Every sweep
 * `server.ts` runs on a demo deployment runs as many times as it fires in an hour.
 *
 * Measured 2026-10-23 on PostgreSQL 16 by the triggers below: 192 rows, all of them
 * the hourly forecast refresh (48 hours deleted and 48 written per observatory).
 * Heartbeats and the empty sweeps wrote none. Before #196 the heartbeats alone wrote
 * 1,440. The budget leaves room for one more forecast refresh and nothing else.
 */
const IDLE_HOUR_WRITE_BUDGET = 400;

const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

/** Fixed instant. Nothing here may depend on when the suite runs. */
const START = Date.parse("2026-12-15T20:00:00.000Z");
const HOUR_SECONDS = 3600;
const HEARTBEAT_SECONDS = 5;

/** The demo intervals, from the same function and production values `server.ts` uses. */
const DEMO = {
  pending: sweepSeconds("demo", 15, 30),
  unstarted: sweepSeconds("demo", 60, 300),
  reminders: sweepSeconds("demo", 60, 300),
  entitlements: sweepSeconds("demo", 60, 300),
  subscriptions: sweepSeconds("demo", 60, 300),
  email: sweepSeconds("demo", 30, 120),
  conditions: 3600,
};

const COUNTER = "_idle_hour_writes";

let database: PrismaClient;
let store: RealtimeStore;
let tables: string[] = [];

function forecastSource(): ForecastSource {
  return {
    name: "OPEN_METEO",
    async fetchHours() {
      const first = Math.floor(START / 3_600_000) * 3_600_000;
      return Array.from({ length: 48 }, (_, index): ForecastHour => ({
        at: new Date(first + index * 3_600_000),
        cloudCoverPercent: 10,
        cloudCoverLowPercent: null,
        cloudCoverMidPercent: null,
        cloudCoverHighPercent: null,
        precipitationProbabilityPercent: 0,
        relativeHumidityPercent: 50,
        windSpeedMetresPerSecond: 2,
        seeingArcseconds: null,
      }));
    },
  };
}

async function observatory(ownerId: string, index: number) {
  const record = await database.observatory.create({
    data: {
      slug: `idle-${randomUUID()}`,
      nameEn: `Idle ${index}`,
      nameKa: `Idle ${index}`,
      city: "Tbilisi",
      countryCode: "GE",
      latitude: 41.7151,
      longitude: 44.8271,
      timezone: "Asia/Tbilisi",
      status: "OFFLINE",
      isDemo: true,
    },
  });
  await database.observatoryNetworkNode.create({
    data: {
      ownerId,
      observatoryId: record.id,
      kind: "FIRST_PARTY",
      approvalStatus: "APPROVED",
      approvedAt: new Date(START),
      capabilities: [],
    },
  });
  return record;
}

async function cleanUp() {
  await database.networkAvailabilityWindow.deleteMany();
  await database.observatoryNetworkNode.deleteMany();
  await database.capture.deleteMany();
  await database.auditLog.deleteMany();
  await database.missionParticipant.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  await database.missionEvent.deleteMany();
  await database.observerPack.deleteMany();
  await database.booking.deleteMany();
  await database.mission.deleteMany();
  await database.payment.deleteMany();
  await database.telescope.deleteMany();
  await database.target.deleteMany();
  await database.weatherState.deleteMany();
  await database.viewingForecastHour.deleteMany();
  await database.agentMessage.deleteMany();
  await database.observatory.deleteMany();
  await database.user.deleteMany();
}

async function dropCounter() {
  for (const table of tables) {
    await database.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS idle_hour_count ON "${table}"`,
    );
  }
  await database.$executeRawUnsafe(`DROP FUNCTION IF EXISTS idle_hour_count() CASCADE`);
  await database.$executeRawUnsafe(`DROP TABLE IF EXISTS "${COUNTER}"`);
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING }),
  });
  await database.$queryRaw`SELECT 1`;
  store = createPrismaStore(CONNECTION_STRING);
  await dropCounter();
  await cleanUp();
});

afterAll(async () => {
  await dropCounter();
  await cleanUp();
  await database.$disconnect();
});

describe("an idle demo hour", () => {
  it(`writes fewer than ${IDLE_HOUR_WRITE_BUDGET} rows`, async () => {
    const owner = await database.user.create({
      data: {
        email: `idle-${randomUUID()}@darkview.test`,
        name: "Operator",
        role: "OPERATOR",
      },
    });
    const observatories = [
      await observatory(owner.id, 1),
      await observatory(owner.id, 2),
    ];

    let clock = START;
    const registry = new AgentLinkRegistry();
    const relay = new AgentRelay(store, registry);
    const links = observatories.map(
      (record) =>
        new AgentLink(
          { id: record.id, mode: "SIMULATED" } as never,
          store,
          () => {},
          () => {},
          new RecordingBroadcast(),
          FAKE_STORAGE,
          () => clock,
        ),
    );

    // Connecting is not idle: the hello writes the link-up row and the posture once.
    for (const [index, link] of links.entries()) {
      await link.receive(
        JSON.stringify({
          type: "AGENT_HELLO",
          messageId: randomUUID(),
          sentAt: new Date(clock).toISOString(),
          protocolVersion: PROTOCOL_VERSION,
          observatoryId: observatories[index].id,
          agentVersion: "0.1.0",
          mode: "SIMULATED",
          posture: "SIMULATED",
          bootedAt: new Date(clock).toISOString(),
          safetyEnvelopeConfigured: true,
          resumeMissionId: null,
        }),
      );
      registry.admit(observatories[index].id, link);
      await link.receive(heartbeat(clock, 0));
    }
    expect(links.every((link) => link.currentState === "ONLINE")).toBe(true);
    // The previous hour's forecast, so this hour's refresh replaces rows as it does live.
    await refreshViewingConditions(database, {
      sources: [forecastSource()],
      now: new Date(clock),
    });

    tables = (
      await database.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
    ).map((row) => row.tablename);
    await database.$executeRawUnsafe(
      `CREATE TABLE "${COUNTER}" (table_name text NOT NULL, operation text NOT NULL)`,
    );
    await database.$executeRawUnsafe(`
      CREATE FUNCTION idle_hour_count() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO "${COUNTER}" (table_name, operation) VALUES (TG_TABLE_NAME, TG_OP);
        RETURN NULL;
      END $$`);
    for (const table of tables) {
      await database.$executeRawUnsafe(
        `CREATE TRIGGER idle_hour_count AFTER INSERT OR UPDATE OR DELETE ON "${table}"
         FOR EACH ROW EXECUTE FUNCTION idle_hour_count()`,
      );
    }

    const due = (seconds: number, interval: number) =>
      seconds > 0 && seconds % interval === 0;
    for (
      let second = HEARTBEAT_SECONDS;
      second <= HOUR_SECONDS;
      second += HEARTBEAT_SECONDS
    ) {
      clock = START + second * 1000;
      const now = new Date(clock);

      for (const link of links)
        await link.receive(heartbeat(clock, second / HEARTBEAT_SECONDS));

      if (due(second, DEMO.pending)) {
        for (const id of registry.observatoryIds()) await relay.sweepPendingCommands(id);
      }
      if (due(second, DEMO.unstarted)) await store.closeUnstartedMissions(now);
      if (due(second, DEMO.reminders)) await queueSlotReminders(database, now);
      if (due(second, DEMO.entitlements)) {
        await evaluateEndedSlots(database, now);
        await refundExpiredEntitlements(database, now);
      }
      if (due(second, DEMO.subscriptions)) {
        await sweepSubscriptions(database, { charger: createSandboxCharger(), now });
      }
      if (due(second, DEMO.email)) {
        await dispatchPendingEmails({
          database,
          resend: {
            apiKey: "test",
            from: "test@darkview.test",
            appUrl: "http://localhost",
          },
          now,
          fetchImpl: async () => {
            throw new Error("an idle hour sends no email");
          },
        });
      }
      if (due(second, DEMO.conditions)) {
        await refreshViewingConditions(database, { sources: [forecastSource()], now });
      }
    }

    expect(links.every((link) => link.currentState === "ONLINE")).toBe(true);

    const counts = await database.$queryRawUnsafe<
      { table_name: string; operation: string; rows: bigint }[]
    >(
      `SELECT table_name, operation, count(*) AS rows FROM "${COUNTER}"
       GROUP BY table_name, operation ORDER BY table_name, operation`,
    );
    const total = counts.reduce((sum, row) => sum + Number(row.rows), 0);
    console.info(
      `idle demo hour: ${total} row(s) written`,
      counts.map((row) => `${row.table_name} ${row.operation} ${row.rows}`),
    );

    // The regressions this exists for: a heartbeat or an empty sweep that writes.
    expect(counts.filter((row) => row.table_name === "AgentMessage")).toEqual([]);
    expect(counts.filter((row) => row.table_name === "Observatory")).toEqual([]);
    expect(counts.filter((row) => row.table_name === "AuditLog")).toEqual([]);
    expect(total).toBeLessThan(IDLE_HOUR_WRITE_BUDGET);
  });
});

function heartbeat(at: number, sequence: number) {
  return JSON.stringify({
    type: "AGENT_HEARTBEAT",
    messageId: randomUUID(),
    sentAt: new Date(at).toISOString(),
    sequence,
    uptimeSeconds: sequence * HEARTBEAT_SECONDS,
    posture: "SIMULATED",
  });
}
