import { createHmac, randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@darkview/db";

import { createPrismaStore, type RealtimeStore } from "@/link/prisma-store";
import {
  dispatchPendingEmails,
  MAX_ATTEMPTS,
  queueSlotReminders,
  retryDelayMs,
} from "@/notifications/email";

/**
 * DV-064 against a real PostgreSQL instance.
 *
 * The claims that matter are about rows: a reminder is queued once however often
 * the sweep runs, a delivery is claimed so two passes cannot both send it, and a
 * failure is scheduled for later rather than lost or retried at once.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const NOW = new Date("2026-12-15T18:00:00.000Z");
const WEBHOOK = {
  url: "https://mail.darkview.test/hook",
  secret: "integration-test-mail-secret-0000000000",
};

let database: PrismaClient;
let store: RealtimeStore;
let observatoryId: string;
let telescopeId: string;
let targetId: string;
let userId: string;

type Sent = { headers: Record<string, string>; body: string };

function mailService(answer: () => Response = () => new Response(null, { status: 202 })) {
  const sent: Sent[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
    return answer();
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

async function booking(minutesFromNow: number, status: "CONFIRMED" | "PENDING_PAYMENT" = "CONFIRMED") {
  const row = await database.booking.create({
    data: {
      userId,
      targetId,
      observatoryId,
      telescopeId,
      slotStartAt: new Date(NOW.getTime() + minutesFromNow * 60_000),
      // Twenty minutes, and every fixture below starts at least that far from the
      // next: DV-066's exclusion constraint refuses two held bookings that overlap.
      durationMinutes: 20,
      status,
      // booking_pending_payment_has_hold_expiry: a held slot always says when it lapses.
      holdExpiresAt: status === "PENDING_PAYMENT" ? new Date(NOW.getTime() + 15 * 60_000) : null,
      priceMinor: 4500,
    },
  });
  return row.id;
}

const outbox = () => database.emailNotification.findMany({ orderBy: { createdAt: "asc" } });

beforeAll(async () => {
  database = new PrismaClient({ adapter: new PrismaPg({ connectionString: CONNECTION_STRING }) });
  await database.$queryRaw`SELECT 1`;
  store = createPrismaStore(CONNECTION_STRING);
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(async () => {
  await database.emailNotification.deleteMany();
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

  const observatory = await database.observatory.create({
    data: {
      slug: `test-${randomUUID()}`,
      nameEn: "Tbilisi Observatory",
      nameKa: "თბილისის ობსერვატორია",
      city: "Tbilisi",
      countryCode: "GE",
      latitude: 41.7151,
      longitude: 44.8271,
      timezone: "Asia/Tbilisi",
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
    },
  });
  telescopeId = telescope.id;

  const target = await database.target.create({
    data: {
      slug: `m13-${randomUUID()}`,
      nameEn: "M13",
      nameKa: "M13 ბურთისებრი გროვა",
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

  const user = await database.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      name: "Nino",
      locale: "ka",
      emailVerifiedAt: NOW,
    },
  });
  userId = user.id;
});

describe("slot reminders", () => {
  it("queues one for each confirmed booking starting within two hours", async () => {
    const soon = await booking(30);
    await booking(180);
    await booking(60, "PENDING_PAYMENT");
    await booking(-30);

    await expect(queueSlotReminders(database, NOW)).resolves.toBe(1);

    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "SLOT_REMINDER", userId, status: "PENDING" });
    expect(rows[0].payload).toEqual({ bookingId: soon });
  });

  it("queues nothing twice however often the sweep runs", async () => {
    await booking(90);

    await queueSlotReminders(database, NOW);
    await expect(queueSlotReminders(database, new Date(NOW.getTime() + 60_000))).resolves.toBe(0);

    expect(await outbox()).toHaveLength(1);
  });
});

describe("delivering the outbox", () => {
  it("sends a signed email in the customer's locale, with what it is about", async () => {
    await booking(90);
    await queueSlotReminders(database, NOW);
    const mail = mailService();

    const summary = await dispatchPendingEmails({ database, webhook: WEBHOOK, now: NOW, fetchImpl: mail.fetchImpl });

    expect(summary).toEqual({ sent: 1, retrying: 0, failed: 0, skipped: 0 });
    const [{ headers, body }] = mail.sent;
    expect(headers["x-darkview-signature"]).toBe(
      createHmac("sha256", WEBHOOK.secret).update(body).digest("base64url"),
    );

    const [row] = await outbox();
    expect(headers["idempotency-key"]).toBe(row.id);
    expect(JSON.parse(body)).toMatchObject({
      kind: "SLOT_REMINDER",
      locale: "ka",
      recipient: { name: "Nino" },
      data: {
        durationMinutes: 20,
        target: { nameEn: "M13", nameKa: "M13 ბურთისებრი გროვა" },
        observatory: { timezone: "Asia/Tbilisi" },
      },
    });
    expect(row).toMatchObject({ status: "SENT", attempts: 1, sentAt: NOW });
  });

  it("schedules a retry after a failure instead of losing the email", async () => {
    await booking(90);
    await queueSlotReminders(database, NOW);
    const mail = mailService(() => new Response(null, { status: 503 }));

    const summary = await dispatchPendingEmails({ database, webhook: WEBHOOK, now: NOW, fetchImpl: mail.fetchImpl });

    expect(summary.retrying).toBe(1);
    const [row] = await outbox();
    expect(row.status).toBe("PENDING");
    expect(row.nextAttemptAt).toEqual(new Date(NOW.getTime() + retryDelayMs(1)));
    expect(row.lastError).toContain("503");

    // Not due yet, so a pass a moment later sends nothing.
    await dispatchPendingEmails({ database, webhook: WEBHOOK, now: new Date(NOW.getTime() + 1_000), fetchImpl: mail.fetchImpl });
    expect(mail.sent).toHaveLength(1);
  });

  it(`gives up after ${MAX_ATTEMPTS} failed deliveries`, async () => {
    await booking(90);
    await queueSlotReminders(database, NOW);
    const mail = mailService(() => new Response(null, { status: 500 }));

    let at = NOW;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await dispatchPendingEmails({ database, webhook: WEBHOOK, now: at, fetchImpl: mail.fetchImpl });
      at = new Date(at.getTime() + retryDelayMs(attempt) + 1_000);
    }

    const [row] = await outbox();
    expect(row).toMatchObject({ status: "FAILED", attempts: MAX_ATTEMPTS });
    expect(mail.sent).toHaveLength(MAX_ATTEMPTS);
  });

  it("sends each email once when two passes run at the same moment", async () => {
    await booking(30);
    await booking(90);
    await queueSlotReminders(database, NOW);
    const mail = mailService();

    await Promise.all([
      dispatchPendingEmails({ database, webhook: WEBHOOK, now: NOW, fetchImpl: mail.fetchImpl }),
      dispatchPendingEmails({ database, webhook: WEBHOOK, now: NOW, fetchImpl: mail.fetchImpl }),
    ]);

    expect(mail.sent).toHaveLength(2);
    expect(new Set(mail.sent.map((sent) => sent.headers["idempotency-key"])).size).toBe(2);
  });

  it("skips a reminder whose booking was cancelled after it was queued", async () => {
    const id = await booking(90);
    await queueSlotReminders(database, NOW);
    await database.booking.update({ where: { id }, data: { status: "CANCELLED" } });
    const mail = mailService();

    const summary = await dispatchPendingEmails({ database, webhook: WEBHOOK, now: NOW, fetchImpl: mail.fetchImpl });

    expect(summary.skipped).toBe(1);
    expect(mail.sent).toEqual([]);
    expect((await outbox())[0].status).toBe("SKIPPED");
  });
});

describe("a capture reaching the Collection", () => {
  it("queues a capture-ready email for the mission's owner, once", async () => {
    const mission = await database.mission.create({
      data: { userId, targetId, observatoryId, telescopeId, state: "CAPTURING" },
    });
    const session = await database.missionSession.create({
      data: {
        missionId: mission.id,
        userId,
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30 * 60_000),
      },
    });
    const command = await database.observatoryCommand.create({
      data: {
        id: randomUUID(),
        missionId: mission.id,
        sessionId: session.id,
        userId,
        observatoryId,
        type: "CAPTURE",
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30_000),
        payload: { kind: "CAPTURE" },
      },
    });
    const record = () =>
      store.recordCapture({
        observatoryId,
        missionId: mission.id,
        commandId: command.id,
        capturedAt: NOW,
        imagingProfile: "GLOBULAR_CLUSTER",
        opticalConfig: "F10_NATIVE",
        exposureMilliseconds: 2000,
        gain: 200,
        framesStacked: 10,
        integrationSeconds: 20,
        widthPx: null,
        heightPx: null,
        solvedFocalLengthMm: null,
        assets: [{ kind: "IMAGE", storageKey: "captures/image.jpg" }],
      });

    const outcome = await record();
    await record();
    if (outcome.outcome !== "RECORDED") throw new Error("expected a capture");

    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "CAPTURE_READY", userId });
    expect(rows[0].payload).toEqual({ captureId: outcome.capture.id });
  });
});
