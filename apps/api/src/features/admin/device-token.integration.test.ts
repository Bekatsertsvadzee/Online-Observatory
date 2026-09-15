import { createHash, randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

const { registerNetworkNode } = await import("@/features/network/nodes");
const { getNetworkNodeReview } = await import("@/features/admin/network");
const { issueDeviceToken, rotateDeviceToken, revokeDeviceToken } = await import(
  "@/features/admin/device-token"
);
const { zDeviceTokenIssued, zNetworkNodeReview } = await import("@darkview/contracts/zod");

/**
 * ADR-020 against a real PostgreSQL instance.
 *
 * Two claims only a database can hold: that the stored value is the one the link
 * service looks an agent up by, and that rotation and revocation notify the
 * realtime service in the same transaction that changed the token.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const NOW = new Date("2026-07-15T20:00:00.000Z");

let database: PrismaClient;
let listener: Client;
let notifications: Record<string, unknown>[];
let ownerId: string;
let operatorId: string;

/** The link service's own derivation (`apps/realtime/src/auth/device-token.ts`). */
const linkServiceHash = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("base64url");

async function createUser(role: "USER" | "OPERATOR" = "USER") {
  const user = await database.user.create({
    data: { email: `${randomUUID()}@darkview.test`, name: "Partner", role },
  });
  return user.id;
}

async function registeredNode() {
  const { node } = await registerNetworkNode({
    ownerId,
    request: {
      siteName: "Roof, Vake",
      city: "Tbilisi",
      countryCode: "GE",
      latitude: 41.7151,
      longitude: 44.8271,
      timezone: "Asia/Tbilisi",
      telescope: {
        name: "EdgeHD 8",
        manufacturer: "Celestron",
        model: "EdgeHD 800",
        apertureMm: 203,
        focalLengthMm: 2032,
      },
    },
    now: NOW,
  });
  return node;
}

const change = (nodeId: string, reason = "owner is installing the agent") => ({
  nodeId,
  request: { reason },
  operatorId,
  now: NOW,
});

async function storedHash(observatoryId: string) {
  const row = await database.observatory.findUniqueOrThrow({
    where: { id: observatoryId },
    select: { deviceTokenHash: true },
  });
  return row.deviceTokenHash;
}

async function credentialNotifications(observatoryId: string, settleMs = 200) {
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  return notifications.filter(
    (note) => note.kind === "CREDENTIAL" && note.observatoryId === observatoryId,
  );
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING }),
  });
  testDatabase.current = database;
  await database.$queryRaw`SELECT 1`;

  listener = new Client({ connectionString: CONNECTION_STRING });
  await listener.connect();
  await listener.query("LISTEN darkview_agent");
  listener.on("notification", (message) => {
    if (message.payload) notifications.push(JSON.parse(message.payload));
  });
});

afterAll(async () => {
  await listener.end();
  await database.$disconnect();
});

beforeEach(async () => {
  notifications = [];

  await database.capture.deleteMany();
  await database.auditLog.deleteMany();
  await database.missionEvent.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  await database.networkAvailabilityWindow.deleteMany();
  await database.observatoryNetworkNode.deleteMany();
  await database.safetyEnvelope.deleteMany();
  await database.observerPack.deleteMany();
  await database.booking.deleteMany();
  await database.mission.deleteMany();
  await database.payment.deleteMany();
  await database.telescope.deleteMany();
  await database.target.deleteMany();
  await database.weatherState.deleteMany();
  await database.observatory.deleteMany();
  await database.user.deleteMany();

  ownerId = await createUser();
  operatorId = await createUser("OPERATOR");
});

describe("issuing a device token", () => {
  it("stores exactly what the link service looks an agent up by", async () => {
    const node = await registeredNode();

    const result = await issueDeviceToken(change(node.nodeId));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => zDeviceTokenIssued.parse(result.issued)).not.toThrow();

    const found = await database.observatory.findUnique({
      where: { deviceTokenHash: linkServiceHash(result.issued.deviceToken) },
      select: { id: true },
    });
    expect(found?.id).toBe(node.observatoryId);
  });

  it("works before approval, since first light needs a connected agent", async () => {
    const node = await registeredNode();
    expect(node.approvalStatus).toBe("DRAFT");

    await expect(issueDeviceToken(change(node.nodeId))).resolves.toMatchObject({ ok: true });
  });

  it("never stores or audits the token itself", async () => {
    const node = await registeredNode();
    const result = await issueDeviceToken(change(node.nodeId));
    if (!result.ok) throw new Error("expected a token");

    expect(await storedHash(node.observatoryId)).not.toBe(result.issued.deviceToken);
    const audit = await database.auditLog.findMany({ where: { entityId: node.nodeId } });
    expect(JSON.stringify(audit)).not.toContain(result.issued.deviceToken);
  });

  it("refuses a second issue and keeps the first token working", async () => {
    const node = await registeredNode();
    const first = await issueDeviceToken(change(node.nodeId));
    if (!first.ok) throw new Error("expected a token");

    await expect(issueDeviceToken(change(node.nodeId))).resolves.toMatchObject({
      ok: false,
      status: 409,
      code: "CONFLICT",
    });
    expect(await storedHash(node.observatoryId)).toBe(
      linkServiceHash(first.issued.deviceToken),
    );
  });

  it("issues exactly once when two operators issue at the same moment", async () => {
    const node = await registeredNode();

    const results = await Promise.all([
      issueDeviceToken(change(node.nodeId)),
      issueDeviceToken(change(node.nodeId)),
    ]);

    const issued = results.filter((result) => result.ok);
    expect(issued).toHaveLength(1);
    const winner = issued[0];
    if (!winner.ok) return;
    expect(await storedHash(node.observatoryId)).toBe(
      linkServiceHash(winner.issued.deviceToken),
    );
  });

  it("rings no bell, because nothing was connected with a token that did not exist", async () => {
    const node = await registeredNode();
    await issueDeviceToken(change(node.nodeId));

    expect(await credentialNotifications(node.observatoryId)).toEqual([]);
  });

  it("answers an unknown node with 404", async () => {
    await expect(issueDeviceToken(change(randomUUID()))).resolves.toMatchObject({
      status: 404,
    });
  });
});

describe("rotating a device token", () => {
  it("replaces the token, so the old one finds no observatory", async () => {
    const node = await registeredNode();
    const first = await issueDeviceToken(change(node.nodeId));
    if (!first.ok) throw new Error("expected a token");

    const rotated = await rotateDeviceToken(change(node.nodeId, "token was pasted into a chat"));

    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(rotated.issued.deviceToken).not.toBe(first.issued.deviceToken);
    expect(
      await database.observatory.findUnique({
        where: { deviceTokenHash: linkServiceHash(first.issued.deviceToken) },
      }),
    ).toBeNull();
    expect(await storedHash(node.observatoryId)).toBe(
      linkServiceHash(rotated.issued.deviceToken),
    );
  });

  it("tells the realtime service to close the link", async () => {
    const node = await registeredNode();
    await issueDeviceToken(change(node.nodeId));

    await rotateDeviceToken(change(node.nodeId, "token was pasted into a chat"));

    expect(await credentialNotifications(node.observatoryId)).toHaveLength(1);
  });

  it("refuses a node with no token, and says nothing", async () => {
    const node = await registeredNode();

    await expect(rotateDeviceToken(change(node.nodeId))).resolves.toMatchObject({
      status: 409,
      code: "CONFLICT",
    });
    expect(await storedHash(node.observatoryId)).toBeNull();
    expect(await credentialNotifications(node.observatoryId)).toEqual([]);
  });
});

describe("revoking a device token", () => {
  it("removes the token and tells the realtime service to close the link", async () => {
    const node = await registeredNode();
    await issueDeviceToken(change(node.nodeId));

    await expect(
      revokeDeviceToken(change(node.nodeId, "owner reports the laptop was stolen")),
    ).resolves.toEqual({ ok: true });

    expect(await storedHash(node.observatoryId)).toBeNull();
    expect(await credentialNotifications(node.observatoryId)).toHaveLength(1);
  });

  it("revokes a node that never had a token, and twice, without complaint", async () => {
    const node = await registeredNode();

    await expect(revokeDeviceToken(change(node.nodeId))).resolves.toEqual({ ok: true });
    await expect(revokeDeviceToken(change(node.nodeId))).resolves.toEqual({ ok: true });

    const rows = await database.auditLog.findMany({
      where: { action: "NETWORK_NODE_DEVICE_TOKEN_REVOKED", entityId: node.nodeId },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].metadata).toMatchObject({ wasIssued: false });
  });

  it("stops a mission that is running on the node", async () => {
    const node = await registeredNode();
    await issueDeviceToken(change(node.nodeId));
    const observatory = await database.observatory.findUniqueOrThrow({
      where: { id: node.observatoryId },
      include: { telescopes: true },
    });
    const target = await database.target.create({
      data: {
        slug: `target-${randomUUID()}`,
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
    const mission = await database.mission.create({
      data: {
        userId: ownerId,
        targetId: target.id,
        observatoryId: node.observatoryId,
        telescopeId: observatory.telescopes[0].id,
        state: "OBSERVING",
      },
    });

    await revokeDeviceToken(change(node.nodeId, "agent is sending garbage, stopping"));

    const after = await database.mission.findUniqueOrThrow({
      where: { id: mission.id },
      select: { state: true },
    });
    expect(after.state).toBe("CANCELLED");
  });

  it("answers an unknown node with 404", async () => {
    await expect(revokeDeviceToken(change(randomUUID()))).resolves.toMatchObject({
      status: 404,
    });
  });
});

describe("the node's history", () => {
  it("shows every token change with the operator's reason, oldest first", async () => {
    const node = await registeredNode();
    await issueDeviceToken(change(node.nodeId, "owner is installing the agent"));
    await rotateDeviceToken(change(node.nodeId, "token was pasted into a chat"));
    await revokeDeviceToken(change(node.nodeId, "owner reports the laptop was stolen"));

    const review = await getNetworkNodeReview(node.nodeId);

    expect(() => zNetworkNodeReview.parse(review)).not.toThrow();
    expect(review?.history.map((entry) => [entry.action, entry.reason])).toEqual([
      ["REGISTERED", null],
      ["DEVICE_TOKEN_ISSUED", "owner is installing the agent"],
      ["DEVICE_TOKEN_ROTATED", "token was pasted into a chat"],
      ["DEVICE_TOKEN_REVOKED", "owner reports the laptop was stolen"],
    ]);
  });
});
