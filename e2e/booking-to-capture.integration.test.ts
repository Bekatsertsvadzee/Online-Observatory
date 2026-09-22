import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { zCapturePage } from "@darkview/contracts/zod";
import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase, cookieJar, sentLinks } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
  cookieJar: new Map<string, string>(),
  sentLinks: [] as string[],
}));

vi.mock("../apps/api/src/lib/db/client", () => ({
  getDatabase: () => testDatabase.current,
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined,
    set: (name: string, value: string) => cookieJar.set(name, value),
  }),
}));
vi.mock("../apps/api/src/lib/validation/env", () => ({
  getServerEnvironment: () => ({
    NODE_ENV: process.env.NODE_ENV ?? "test",
    APP_URL: "https://darkview.test",
    AUTH_SECRET: "integration-test-secret-integration-test-secret",
    EMAIL_VERIFICATION_WEBHOOK_URL: "https://mail.darkview.test/hook",
    EMAIL_VERIFICATION_WEBHOOK_SECRET: "integration-test-webhook-secret-0000",
    TRUSTED_PROXY_HOPS: 0,
  }),
}));
vi.mock("../apps/api/src/lib/auth/email-verification", () => ({
  sendEmailVerification: async (message: { verificationUrl: string }) => {
    sentLinks.push(message.verificationUrl);
  },
}));
vi.mock("../apps/api/src/lib/storage/configuration", async () => ({
  getStorage: () => FAKE_STORAGE,
}));

const { register, signIn, verifyEmail } =
  await import("../apps/api/src/features/auth/authenticate");
const { getCurrentSession } = await import("../apps/api/src/lib/auth/session");
const { reserveSlot } = await import("../apps/api/src/features/booking/reserve");
const { settlePayment } = await import("../apps/api/src/features/payments/settle");
const { startMissionSession } = await import("../apps/api/src/features/missions/session");
const { mintMissionCommand } = await import("../apps/api/src/features/missions/command");
const { listCaptures } = await import("../apps/api/src/features/captures/collection");
const { nightWindow } = await import("../apps/api/src/lib/slots/darkness");
const { generateSlots, SLOT_DURATION_MINUTES } =
  await import("../apps/api/src/lib/slots/generate");

import { AgentLink } from "../apps/realtime/src/link/agent-link";
import { AgentRelay } from "../apps/realtime/src/link/agent-relay";
import { AGENT_CHANNEL } from "../apps/realtime/src/link/command-listener";
import { FAKE_STORAGE } from "../apps/realtime/src/link/fake-storage";
import { createPrismaStore } from "../apps/realtime/src/link/prisma-store";
import { PROTOCOL_VERSION } from "../apps/realtime/src/link/protocol";
import { AgentLinkRegistry } from "../apps/realtime/src/link/registry";
import { RecordingBroadcast } from "../apps/realtime/src/mission/fake-broadcast";

/**
 * Issue #72, criterion 4: a customer authenticates, reserves, pays, starts their
 * booked mission and keeps a capture, with no database edit advancing any state.
 *
 * The rows written below the fixture line are configuration a real observatory
 * already has -- a site, a telescope, a target, an approved node, an envelope.
 * Every state after that is moved by the code that moves it in production: the
 * API's feature functions, the `NOTIFY` they issue, the realtime relay that hears
 * it, and the agent link that applies what the agent reports.
 *
 * The agent is the one stand-in. Its side of the wire is the messages
 * `MissionRunner` and `Supervisor` send, in the order they send them, parsed by
 * the link exactly as a real agent's are. A real agent process would PUT the
 * capture to object storage before reporting it, and there is no bucket here.
 *
 * Simulator only. The observatory is SIMULATED and the envelope below is a fake,
 * named as one, because MAX_ALT_SAFE is measured by DV-034 and does not exist yet.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const SITE = { latitude: 41.7151, longitude: 44.8271, timezone: "Asia/Tbilisi" };
const PASSWORD = "a correct horse battery";

/** Booked and paid in the afternoon, for that night. */
const RESERVED_AT = new Date("2026-07-15T12:00:00.000Z");
const NIGHT = "2026-07-15";
/**
 * Five minutes into the slot. M13 is at 67 degrees and setting, with the Sun far
 * below the horizon -- the same sky `session.integration.test.ts` relies on.
 */
const ARRIVED_AT = new Date("2026-07-15T20:05:00.000Z");

/** NOT A MEASUREMENT. See FAKE_MEASURED_MAX_ALTITUDE_DEGREES in session.integration.test.ts. */
const FAKE_MEASURED_MAX_ALTITUDE_DEGREES = 78;

type Sent = { type: string; [key: string]: unknown };

let database: PrismaClient;
let listener: Client;
let relaying: Promise<unknown>;
let sent: Sent[];
let clock: Date;

let observatoryId: string;
let targetId: string;

async function eventually<T>(find: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    await relaying;
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`${what} never arrived`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function tick(seconds: number) {
  clock = new Date(clock.getTime() + seconds * 1000);
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING }),
  });
  testDatabase.current = database;
  await database.$queryRaw`SELECT 1`;

  listener = new Client({ connectionString: CONNECTION_STRING });
  await listener.connect();
  await listener.query(`LISTEN ${AGENT_CHANNEL}`);
});

afterAll(async () => {
  await listener.end();
  await database.$disconnect();
});

beforeEach(async () => {
  sent = [];
  relaying = Promise.resolve();
  cookieJar.clear();
  sentLinks.length = 0;

  // The same order as the realtime suites, for the same Restrict keys.
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
  await database.safetyEnvelope.deleteMany();
  await database.telescope.deleteMany();
  await database.target.deleteMany();
  await database.weatherState.deleteMany();
  await database.agentMessage.deleteMany();
  await database.observatory.deleteMany();
  await database.user.deleteMany();

  // ---- fixture: configuration, not state ----

  const observatory = await database.observatory.create({
    data: {
      slug: `test-${randomUUID()}`,
      nameEn: "Test Observatory",
      nameKa: "სატესტო ობსერვატორია",
      city: "Tbilisi",
      countryCode: "GE",
      latitude: SITE.latitude,
      longitude: SITE.longitude,
      timezone: SITE.timezone,
      status: "ONLINE",
    },
  });
  observatoryId = observatory.id;

  const telescope = await database.telescope.create({
    data: {
      observatoryId,
      name: "NexStar 6SE",
      manufacturer: "Celestron",
      model: "NexStar 6SE",
      apertureMm: 150,
      focalLengthMm: 1500,
      status: "ONLINE",
    },
  });

  const operator = await database.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      name: "Operator",
      role: "OPERATOR",
      emailVerifiedAt: RESERVED_AT,
    },
  });
  await database.observatoryNetworkNode.create({
    data: {
      ownerId: operator.id,
      observatoryId,
      primaryTelescopeId: telescope.id,
      kind: "FIRST_PARTY",
      approvalStatus: "APPROVED",
      capabilities: [],
      approvedAt: RESERVED_AT,
    },
  });

  const target = await database.target.create({
    data: {
      slug: `m13-${randomUUID()}`,
      nameEn: "M13",
      nameKa: "M13",
      type: "GLOBULAR_CLUSTER",
      positionSource: "FIXED",
      rightAscensionHours: 16.6949,
      declinationDegrees: 36.4613,
      angularSizeArcmin: 20,
      magnitude: 5.8,
      opticalConfig: "F10_NATIVE",
      imagingProfile: "GLOBULAR_CLUSTER",
      minAltitudeDegrees: 25,
      expectedMissionMinutes: 30,
    },
  });
  targetId = target.id;

  await database.safetyEnvelope.create({
    data: {
      observatoryId,
      minAltitudeDegrees: 20,
      maxAltitudeDegrees: FAKE_MEASURED_MAX_ALTITUDE_DEGREES,
      maxAltitudeMeasuredAt: RESERVED_AT,
      maxAltitudeMeasuredBy: "e2e fake",
      sunExclusionDegrees: 30,
      daylightLockSunAltitudeDegrees: -6,
      nudgeMaxDegrees: 1,
      nudgeRateDegreesPerSecond: 0.25,
      slewTimeoutSeconds: 120,
      heartbeatLossSeconds: 15,
      linkDeadSeconds: 60,
      refocusTemperatureDeltaC: 1.5,
    },
  });
});

describe("a customer's booking, from sign-in to their Collection", () => {
  it("runs on the simulator with nothing but the product's own code moving it", async () => {
    // ---- the observatory is connected ----

    clock = RESERVED_AT;
    const observatory = await database.observatory.findUniqueOrThrow({
      where: { id: observatoryId },
    });
    const store = createPrismaStore(CONNECTION_STRING);
    const registry = new AgentLinkRegistry();
    const link = new AgentLink(
      { id: observatory.id, slug: observatory.slug, mode: observatory.mode },
      store,
      (message) => sent.push(message as Sent),
      () => {},
      new RecordingBroadcast(),
      FAKE_STORAGE,
      () => clock.getTime(),
    );
    registry.admit(observatoryId, link);

    // The realtime service's listener, serialised so a SESSION is relayed before
    // the COMMAND written after it -- as the one connection in production does.
    const relay = new AgentRelay(store, registry, () => clock);
    listener.on("notification", (message) => {
      const payload = message.payload;
      if (payload) relaying = relaying.then(() => relay.handle(payload));
    });

    const agent = (message: Record<string, unknown>) =>
      link.receive(
        JSON.stringify({
          messageId: randomUUID(),
          sentAt: clock.toISOString(),
          ...message,
        }),
      );

    await agent({
      type: "AGENT_HELLO",
      protocolVersion: PROTOCOL_VERSION,
      observatoryId,
      agentVersion: "0.1.0",
      mode: "SIMULATED",
      posture: "SIMULATED",
      bootedAt: clock.toISOString(),
      safetyEnvelopeConfigured: true,
      resumeMissionId: null,
    });

    // ---- authenticate ----

    const email = `${randomUUID()}@example.test`;
    await expect(
      register({ displayName: "Observer", email, password: PASSWORD, locale: "en" }),
    ).resolves.toEqual({ ok: true });
    const token = sentLinks.at(-1)!.split("/").at(-1)!;
    await expect(verifyEmail({ token })).resolves.toMatchObject({ ok: true });
    cookieJar.clear();
    await expect(signIn({ email, password: PASSWORD })).resolves.toMatchObject({
      ok: true,
    });

    // Who the customer is comes from the cookie, as every route reads it.
    const session = await getCurrentSession();
    expect(session?.user.email).toBe(email);
    const actor = { id: session!.user.id, role: session!.user.role };

    // ---- reserve ----

    const window = nightWindow(NIGHT, SITE.timezone, {
      latitudeDegrees: SITE.latitude,
      longitudeDegrees: SITE.longitude,
    });
    if (!window) throw new Error("no astronomical darkness on the fixture night");
    const slot = generateSlots({
      observatoryId,
      window,
      now: RESERVED_AT,
      observatory: { online: true, weatherHold: false },
      bookedStartAt: new Set(),
    }).find((candidate) => {
      const start = new Date(candidate.startAt).getTime();
      return (
        start <= ARRIVED_AT.getTime() &&
        ARRIVED_AT.getTime() < start + SLOT_DURATION_MINUTES * 60_000
      );
    });
    if (!slot?.available)
      throw new Error("the fixture instant is not inside a bookable slot");

    const reserved = await reserveSlot({
      userId: actor.id,
      request: {
        observatoryId,
        targetId,
        slotStartAt: slot.startAt,
        durationMinutes: SLOT_DURATION_MINUTES,
      },
      idempotencyKey: null,
      now: RESERVED_AT,
    });
    if (!reserved.ok) throw new Error(`reservation refused: ${reserved.message}`);
    const { booking } = reserved.body;
    const paymentIntent = reserved.body.paymentIntent!;

    // ---- settle ----

    const settled = await settlePayment({
      provider: "SANDBOX",
      outcome: {
        paymentId: paymentIntent.paymentId,
        providerRef: `sbx_${paymentIntent.paymentId.slice(0, 8)}`,
        result: "CAPTURED",
        amountMinor: booking.priceMinor,
        currency: "GEL",
        failureReason: null,
      },
      now: RESERVED_AT,
    });
    if (!settled.ok || !settled.missionId)
      throw new Error("payment did not schedule a mission");
    const missionId = settled.missionId;

    const mission = () =>
      database.mission.findUniqueOrThrow({ where: { id: missionId } });
    expect((await mission()).state).toBe("SCHEDULED");

    // ---- start ----

    clock = ARRIVED_AT;
    const started = await startMissionSession({ missionId, actor, now: clock });
    if (!started.ok) throw new Error(`start refused: ${started.code} ${started.message}`);
    expect((await mission()).state).toBe("PREPARING");

    const commands = () =>
      sent
        .filter((message) => message.type === "CLOUD_COMMAND")
        .map(
          (message) =>
            message.command as {
              commandId: string;
              sessionId: string;
              type: string;
              missionId: string;
            },
        );

    const goto = await eventually(
      () => commands().find((command) => command.type === "GOTO"),
      "the GOTO",
    );
    expect(goto).toMatchObject({ missionId, sessionId: started.session.sessionId });

    // The agent learns who owns the mission before the command naming them.
    const ownerUpdate = sent.findIndex(
      (message) =>
        message.type === "CLOUD_SESSION_UPDATE" &&
        message.sessionId === started.session.sessionId,
    );
    expect(ownerUpdate).toBeGreaterThanOrEqual(0);
    expect(ownerUpdate).toBeLessThan(
      sent.findIndex((message) => message.type === "CLOUD_COMMAND"),
    );

    // ---- run: what MissionRunner reports ----

    const accept = (commandId: string) =>
      agent({
        type: "AGENT_COMMAND_ACK",
        commandId,
        missionId,
        status: "ACCEPTED",
        rejectionReason: null,
        detail: null,
      });
    const reach = async (state: string) => {
      tick(5);
      await agent({
        type: "AGENT_MISSION_EVENT",
        missionId,
        state,
        failureReason: null,
        occurredAt: clock.toISOString(),
        commandId: null,
        detail: null,
      });
    };

    await accept(goto.commandId);
    for (const state of ["PREPARING", "SLEWING", "VERIFYING", "OBSERVING"])
      await reach(state);
    expect((await mission()).state).toBe("OBSERVING");

    // ---- capture ----

    tick(60);
    const minted = await mintMissionCommand({
      missionId,
      request: {
        type: "CAPTURE",
        capture: { kind: "CAPTURE", imagingProfile: "GLOBULAR_CLUSTER" },
      },
      actor,
      now: clock,
    });
    if (!minted.ok) throw new Error(`capture refused: ${minted.code} ${minted.message}`);

    const capture = await eventually(
      () => commands().find((command) => command.commandId === minted.accepted.commandId),
      "the CAPTURE",
    );
    expect(capture).toMatchObject({
      type: "CAPTURE",
      missionId,
      sessionId: started.session.sessionId,
    });

    await accept(capture.commandId);
    await reach("CAPTURING");
    await reach("PROCESSING");

    // PROCESSING hands the stack to the supervisor, which asks where to put it.
    await agent({
      type: "AGENT_UPLOAD_GRANT_REQUEST",
      missionId,
      commandId: capture.commandId,
      kind: "IMAGE",
      // The URL is signed over these, so the grant is for one object of one
      // media type and one exact size, and nothing else may be PUT at that key.
      contentType: "image/jpeg",
      contentLength: 2_400_000,
    });
    const grant = await eventually(
      () => sent.find((message) => message.type === "CLOUD_UPLOAD_GRANT"),
      "the upload grant",
    );

    await agent({
      type: "AGENT_CAPTURE_READY",
      missionId,
      commandId: capture.commandId,
      capturedAt: clock.toISOString(),
      imagingProfile: "GLOBULAR_CLUSTER",
      opticalConfig: "F10_NATIVE",
      exposureMilliseconds: 2000,
      gain: 200,
      framesStacked: 10,
      integrationSeconds: 20,
      imageStorageKey: grant.storageKey,
      mode: "SIMULATED",
    });
    await reach("COMPLETE");

    // ---- the customer's Collection ----

    expect(sent.filter((message) => message.type === "CLOUD_ERROR")).toEqual([]);
    expect((await mission()).state).toBe("COMPLETE");

    const collection = await listCaptures({ userId: actor.id, limit: 10, now: clock });
    expect(() => zCapturePage.parse(collection)).not.toThrow();
    expect(collection.items).toHaveLength(1);
    expect(collection.items[0]).toMatchObject({ missionId, framesStacked: 10 });

    // Every transition was written by the cloud or reported by the agent, in order.
    const trail = await database.missionEvent.findMany({
      where: { missionId },
      orderBy: { occurredAt: "asc" },
    });
    expect(trail.map((event) => `${event.source}:${event.state}`)).toEqual([
      "CLOUD:SCHEDULED",
      "CLOUD:PREPARING",
      "AGENT:PREPARING",
      "AGENT:SLEWING",
      "AGENT:VERIFYING",
      "AGENT:OBSERVING",
      "AGENT:CAPTURING",
      "AGENT:PROCESSING",
      "AGENT:COMPLETE",
    ]);
    expect(trail.every((event) => event.simulated)).toBe(true);
  });
});
