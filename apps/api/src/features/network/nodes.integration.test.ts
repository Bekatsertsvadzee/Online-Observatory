import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@darkview/db";

vi.mock("server-only", () => ({}));

const { testDatabase } = vi.hoisted(() => ({
  testDatabase: { current: null as unknown as PrismaClient },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => testDatabase.current }));

const { registerNetworkNode, listMyNetworkNodes, submitNetworkNodeForReview } =
  await import("@/features/network/nodes");
const {
  approveNetworkNode,
  getNetworkNodeReview,
  listNetworkNodes,
  suspendNetworkNode,
} = await import("@/features/admin/network");
const { zNetworkNode, zNetworkNodePage, zNetworkNodeReview } = await import(
  "@darkview/contracts/zod"
);

/**
 * DV-120 against a real PostgreSQL instance.
 *
 * ADR-013 lets a telescope somebody else owns be operated while nobody is standing
 * next to it. The only thing standing between that and a broken mount is the
 * qualification below, so what these tests hold is the shape of the refusals:
 * that DRAFT grants nothing, that approval cannot happen without a measured
 * altitude limit, and that taking a qualification away is never refused.
 */
const CONNECTION_STRING =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const NOW = new Date("2026-07-15T20:00:00.000Z");

/** A stand-in for MAX_ALT_SAFE, which DV-034 measures. NAMED A FAKE BECAUSE IT IS ONE. */
const FAKE_MEASURED_MAX_ALTITUDE_DEGREES = 78;

let database: PrismaClient;
let ownerId: string;
let strangerId: string;
let operatorId: string;

const registration = () => ({
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
});

const attestation = (overrides: Record<string, unknown> = {}) => ({
  coordinatesVerified: true,
  horizonMaskRecorded: true,
  firstLightSupervised: true,
  parkProven: true,
  ownerTermsAccepted: true,
  reason: "qualified on site, park proven twice",
  ...overrides,
});

async function createUser(role: "USER" | "OPERATOR" = "USER") {
  const user = await database.user.create({
    data: { email: `${randomUUID()}@darkview.test`, name: "Partner", role },
  });
  return user.id;
}

/** A registered node, optionally advanced through the workflow. */
async function nodeIn(state: "DRAFT" | "UNDER_REVIEW", owner = ownerId) {
  const { node } = await registerNetworkNode({
    ownerId: owner,
    request: registration(),
    now: NOW,
  });
  if (state === "UNDER_REVIEW") {
    await submitNetworkNodeForReview({ ownerId: owner, nodeId: node.nodeId });
  }
  return node;
}

/** Measure the altitude limit for a node's instrument, or explicitly leave it unmeasured. */
async function measureEnvelope(observatoryId: string, maxAltitude: number | null) {
  await database.safetyEnvelope.create({
    data: {
      observatoryId,
      minAltitudeDegrees: 20,
      maxAltitudeDegrees: maxAltitude,
      maxAltitudeMeasuredAt: maxAltitude === null ? null : NOW,
      maxAltitudeMeasuredBy: maxAltitude === null ? null : "integration-test fake",
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
}

beforeAll(async () => {
  database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: CONNECTION_STRING }),
  });
  testDatabase.current = database;
  await database.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  await database.$disconnect();
});

beforeEach(async () => {
  await database.capture.deleteMany();
  await database.auditLog.deleteMany();
  await database.missionEvent.deleteMany();
  await database.observatoryCommand.deleteMany();
  await database.missionSession.deleteMany();
  await database.networkAvailabilityWindow.deleteMany();
  await database.observatoryNetworkNode.deleteMany();
  await database.safetyEnvelope.deleteMany();
  await database.booking.deleteMany();
  await database.mission.deleteMany();
  // Payment holds a Restrict foreign key to User. This suite creates none, but
  // the integration suites share one database and run in sequence, so a payment
  // left by an earlier file makes the user cleanup below fail -- which is why
  // every other suite deletes it here too.
  await database.payment.deleteMany();
  await database.telescope.deleteMany();
  await database.target.deleteMany();
  await database.weatherState.deleteMany();
  await database.observatory.deleteMany();
  await database.user.deleteMany();

  ownerId = await createUser();
  strangerId = await createUser();
  operatorId = await createUser("OPERATOR");
});

describe("registering a telescope somebody owns", () => {
  it("creates the site, the instrument and the node together, in DRAFT", async () => {
    const { node } = await registerNetworkNode({
      ownerId,
      request: registration(),
      now: NOW,
    });

    expect(zNetworkNode.safeParse(node).success).toBe(true);
    expect(node.approvalStatus).toBe("DRAFT");
    expect(node.kind).toBe("PARTNER");
    expect(node.approvedAt).toBeNull();

    const observatory = await database.observatory.findUniqueOrThrow({
      where: { id: node.observatoryId },
      include: { telescopes: true },
    });
    expect(observatory.telescopes).toHaveLength(1);
    expect(observatory.city).toBe("Tbilisi");
  });

  it("leaves the new observatory unreachable by any agent", async () => {
    // No device token, offline, simulated. A freshly registered node cannot be
    // connected to even by somebody who knows its identifiers -- nothing has been
    // qualified yet, and there is no agent.
    const { node } = await registerNetworkNode({
      ownerId,
      request: registration(),
      now: NOW,
    });

    const observatory = await database.observatory.findUniqueOrThrow({
      where: { id: node.observatoryId },
    });
    expect(observatory.deviceTokenHash).toBeNull();
    expect(observatory.mode).toBe("SIMULATED");
    expect(observatory.status).toBe("OFFLINE");
  });

  it("reports the instrument as unmeasured", async () => {
    // The shipped state of every telescope until somebody measures where its
    // optical train meets its mount. Every slew is refused while it holds.
    const { node } = await registerNetworkNode({
      ownerId,
      request: registration(),
      now: NOW,
    });

    expect(node.safetyEnvelopeMeasured).toBe(false);
  });

  it("gives two sites of the same name different slugs", async () => {
    const first = await registerNetworkNode({ ownerId, request: registration(), now: NOW });
    const second = await registerNetworkNode({ ownerId, request: registration(), now: NOW });

    const slugs = await database.observatory.findMany({
      where: { id: { in: [first.node.observatoryId, second.node.observatoryId] } },
      select: { slug: true },
    });
    expect(new Set(slugs.map((row) => row.slug)).size).toBe(2);
  });

  it("lists only the caller's own nodes", async () => {
    await nodeIn("DRAFT", ownerId);
    await nodeIn("DRAFT", strangerId);

    const mine = await listMyNetworkNodes(ownerId);

    expect(mine).toHaveLength(1);
    expect(mine[0].ownerId).toBe(ownerId);
  });
});

describe("offering a node for review", () => {
  it("moves DRAFT to UNDER_REVIEW", async () => {
    const node = await nodeIn("DRAFT");

    const result = await submitNetworkNodeForReview({ ownerId, nodeId: node.nodeId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.node.approvalStatus).toBe("UNDER_REVIEW");
  });

  it("will not let somebody submit a node they do not own", async () => {
    const node = await nodeIn("DRAFT", strangerId);

    const result = await submitNetworkNodeForReview({ ownerId, nodeId: node.nodeId });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });

  it("refuses a second submission rather than treating it as a retry", async () => {
    const node = await nodeIn("UNDER_REVIEW");

    const result = await submitNetworkNodeForReview({ ownerId, nodeId: node.nodeId });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
  });
});

describe("qualifying a node to operate unattended", () => {
  it("refuses while the instrument has no measured altitude limit", async () => {
    // The condition ADR-013 does not let an operator attest. MAX_ALT_SAFE is
    // where the optical train meets the mount; a checkbox for it would let an
    // unmeasured telescope be approved by clicking, on somebody else's property.
    const node = await nodeIn("UNDER_REVIEW");
    await measureEnvelope(node.observatoryId, null);

    const result = await approveNetworkNode({
      nodeId: node.nodeId,
      request: attestation(),
      operatorId,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SAFETY_NOT_CONFIGURED");
  });

  it("refuses when no envelope exists at all", async () => {
    // A missing row and a row with a null limit are the same fact, and both must
    // refuse. Only one of them looks like a mistake.
    const node = await nodeIn("UNDER_REVIEW");

    const result = await approveNetworkNode({
      nodeId: node.nodeId,
      request: attestation(),
      operatorId,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SAFETY_NOT_CONFIGURED");
  });

  it.each([
    "coordinatesVerified",
    "horizonMaskRecorded",
    "firstLightSupervised",
    "parkProven",
    "ownerTermsAccepted",
  ])("refuses when %s is not attested, and says which", async (condition) => {
    const node = await nodeIn("UNDER_REVIEW");
    await measureEnvelope(node.observatoryId, FAKE_MEASURED_MAX_ALTITUDE_DEGREES);

    const result = await approveNetworkNode({
      nodeId: node.nodeId,
      request: attestation({ [condition]: false }),
      operatorId,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(result.details?.unmet).toEqual([condition]);
  });

  it("refuses a node that was never offered for review", async () => {
    const node = await nodeIn("DRAFT");
    await measureEnvelope(node.observatoryId, FAKE_MEASURED_MAX_ALTITUDE_DEGREES);

    const result = await approveNetworkNode({
      nodeId: node.nodeId,
      request: attestation(),
      operatorId,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
  });

  it("approves a qualified node and records every attestation verbatim", async () => {
    const node = await nodeIn("UNDER_REVIEW");
    await measureEnvelope(node.observatoryId, FAKE_MEASURED_MAX_ALTITUDE_DEGREES);

    const result = await approveNetworkNode({
      nodeId: node.nodeId,
      request: attestation(),
      operatorId,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.node.approvalStatus).toBe("APPROVED");
    expect(result.node.approvedAt).toBe(NOW.toISOString());
    expect(result.node.safetyEnvelopeMeasured).toBe(true);

    // The audit row is what an approval is. A row saying only "approved" would
    // record that a decision happened and nothing about what it rested on.
    const audit = await database.auditLog.findFirstOrThrow({
      where: { action: "NETWORK_NODE_APPROVED" },
    });
    expect(audit.actorUserId).toBe(operatorId);
    expect(audit.metadata).toMatchObject({
      reason: "qualified on site, park proven twice",
      parkProven: true,
      coordinatesVerified: true,
    });
  });
});

describe("taking a qualification away", () => {
  async function approvedNode() {
    const node = await nodeIn("UNDER_REVIEW");
    await measureEnvelope(node.observatoryId, FAKE_MEASURED_MAX_ALTITUDE_DEGREES);
    await approveNetworkNode({
      nodeId: node.nodeId,
      request: attestation(),
      operatorId,
      now: NOW,
    });
    return node;
  }

  it("suspends an approved node and clears its approval", async () => {
    const node = await approvedNode();

    const result = await suspendNetworkNode({
      nodeId: node.nodeId,
      request: { reason: "owner reports a slipping clutch" },
      operatorId,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.node.approvalStatus).toBe("SUSPENDED");
    expect(result.node.approvedAt).toBeNull();
  });

  it("suspends a node that was never approved, without complaint", async () => {
    // Anything that stops a telescope is never refused. An operator suspending
    // something already stopped is asking for nothing, and answering 409 would be
    // an argument at the worst possible moment.
    const node = await nodeIn("DRAFT");

    const result = await suspendNetworkNode({
      nodeId: node.nodeId,
      request: { reason: "precautionary, owner unreachable" },
      operatorId,
      now: NOW,
    });

    expect(result.ok).toBe(true);
  });

  it("suspends twice without complaint", async () => {
    const node = await approvedNode();
    const first = { nodeId: node.nodeId, request: { reason: "first suspension" }, operatorId, now: NOW };

    await suspendNetworkNode(first);
    const again = await suspendNetworkNode({ ...first, request: { reason: "second suspension" } });

    expect(again.ok).toBe(true);
  });

  it("keeps SUSPENDED distinct from DRAFT", async () => {
    // Both refuse everything. They are different facts: one telescope has never
    // been qualified, the other had its qualification taken away, and that is the
    // history an operator needs before granting it again.
    const suspended = await approvedNode();
    await suspendNetworkNode({
      nodeId: suspended.nodeId,
      request: { reason: "owner reports a slipping clutch" },
      operatorId,
      now: NOW,
    });
    const draft = await nodeIn("DRAFT");

    const rows = await database.observatoryNetworkNode.findMany({
      where: { id: { in: [suspended.nodeId, draft.nodeId] } },
      select: { id: true, approvalStatus: true },
    });

    expect(new Set(rows.map((row) => row.approvalStatus))).toEqual(
      new Set(["SUSPENDED", "DRAFT"]),
    );
  });

  it("stops a mission that is running on it", async () => {
    // The behaviour the whole feature turns on. Suspending an approved node while
    // a customer is mid-observation must actually stop the telescope, not merely
    // stop the next booking -- otherwise "the operator can revoke it in one row"
    // is a claim about paperwork rather than about a mount that is moving.
    const node = await approvedNode();
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

    await suspendNetworkNode({
      nodeId: node.nodeId,
      request: { reason: "mount is not tracking, stopping now" },
      operatorId,
      now: NOW,
    });

    const after = await database.mission.findUniqueOrThrow({
      where: { id: mission.id },
      select: { state: true },
    });
    expect(after.state).toBe("CANCELLED");
  });

  it("records the reason and what the node was before", async () => {
    const node = await approvedNode();

    await suspendNetworkNode({
      nodeId: node.nodeId,
      request: { reason: "owner reports a slipping clutch" },
      operatorId,
      now: NOW,
    });

    const audit = await database.auditLog.findFirstOrThrow({
      where: { action: "NETWORK_NODE_SUSPENDED" },
    });
    expect(audit.metadata).toMatchObject({
      reason: "owner reports a slipping clutch",
      previousStatus: "APPROVED",
    });
  });
});

/**
 * DV-122 -- the operator's side of a qualification: finding the nodes waiting, and
 * reading the evidence before deciding one.
 */
describe("the qualification queue", () => {
  /** Pin a node's creation time, so "oldest first" is a fact the test chose. */
  async function registeredAt(nodeId: string, minutesAgo: number) {
    await database.observatoryNetworkNode.update({
      where: { id: nodeId },
      data: { createdAt: new Date(NOW.getTime() - minutesAgo * 60_000) },
    });
  }

  it("lists only the nodes awaiting review, the longest-waiting first", async () => {
    const newer = await nodeIn("UNDER_REVIEW");
    const older = await nodeIn("UNDER_REVIEW");
    const draft = await nodeIn("DRAFT");
    await registeredAt(newer.nodeId, 10);
    await registeredAt(older.nodeId, 60);
    await registeredAt(draft.nodeId, 120);

    const page = await listNetworkNodes({ approvalStatus: "UNDER_REVIEW", limit: 20 });

    expect(page.items.map((node) => node.nodeId)).toEqual([older.nodeId, newer.nodeId]);
    expect(zNetworkNodePage.safeParse(page).success).toBe(true);
  });

  it("lists every node, in every state, when no status is asked for", async () => {
    const draft = await nodeIn("DRAFT");
    const reviewing = await nodeIn("UNDER_REVIEW", strangerId);

    const page = await listNetworkNodes({ limit: 20 });

    // Unscoped by owner: two owners' nodes on one page is what an admin read is.
    expect(new Set(page.items.map((node) => node.nodeId))).toEqual(
      new Set([draft.nodeId, reviewing.nodeId]),
    );
  });

  it("pages without repeating or skipping a node", async () => {
    const nodes = [];
    for (const minutesAgo of [30, 20, 10]) {
      const node = await nodeIn("UNDER_REVIEW");
      await registeredAt(node.nodeId, minutesAgo);
      nodes.push(node.nodeId);
    }

    const first = await listNetworkNodes({ approvalStatus: "UNDER_REVIEW", limit: 2 });
    const second = await listNetworkNodes({
      approvalStatus: "UNDER_REVIEW",
      limit: 2,
      cursor: first.page.nextCursor ?? undefined,
    });

    expect(first.page.hasMore).toBe(true);
    expect(second.page.hasMore).toBe(false);
    expect([...first.items, ...second.items].map((node) => node.nodeId)).toEqual(nodes);
  });
});

describe("reviewing a qualification", () => {
  it("shows the operator who owns it and exactly where it is", async () => {
    // What the public surfaces withhold, and the reviewer needs: ADR-013 requires
    // the coordinates verified against the sky, and nobody can compare a plate
    // solve with a number they are not shown.
    const node = await nodeIn("UNDER_REVIEW");

    const review = await getNetworkNodeReview(node.nodeId);

    expect(review?.owner.id).toBe(ownerId);
    expect(review?.site).toEqual({
      latitude: 41.7151,
      longitude: 44.8271,
      timezone: "Asia/Tbilisi",
    });
    expect(review?.telescope).toEqual(registration().telescope);
    expect(zNetworkNodeReview.safeParse(review).success).toBe(true);
  });

  it("reports the envelope measurement and the surveyed horizon", async () => {
    const node = await nodeIn("UNDER_REVIEW");
    await measureEnvelope(node.observatoryId, FAKE_MEASURED_MAX_ALTITUDE_DEGREES);
    const envelope = await database.safetyEnvelope.findUniqueOrThrow({
      where: { observatoryId: node.observatoryId },
    });
    await database.horizonMaskEntry.createMany({
      data: [0, 90, 180].map((azimuthDegrees) => ({
        safetyEnvelopeId: envelope.id,
        azimuthDegrees,
        minAltitudeDegrees: 15,
      })),
    });
    await database.azimuthSector.create({
      data: { safetyEnvelopeId: envelope.id, fromDegrees: 200, toDegrees: 220 },
    });

    const review = await getNetworkNodeReview(node.nodeId);

    expect(review?.evidence.safetyEnvelope).toEqual({
      maxAltitudeDegrees: FAKE_MEASURED_MAX_ALTITUDE_DEGREES,
      measuredAt: NOW.toISOString(),
      measuredBy: "integration-test fake",
      measurementNote: null,
    });
    expect(review?.evidence.horizonMaskEntries).toBe(3);
    expect(review?.evidence.forbiddenAzimuthSectors).toBe(1);
  });

  it("reports an instrument nobody has surveyed as exactly that", async () => {
    // The state every registered node starts in. Zero is the answer, not a gap.
    const node = await nodeIn("UNDER_REVIEW");

    const review = await getNetworkNodeReview(node.nodeId);

    expect(review?.evidence).toEqual({
      safetyEnvelope: null,
      horizonMaskEntries: 0,
      forbiddenAzimuthSectors: 0,
      completedRealMissions: 0,
    });
  });

  /**
   * First light is the hardware doing it with somebody watching. A simulated
   * mission says nothing about a telescope on somebody else's roof, and a real one
   * that failed is not a first light.
   */
  it("counts only completed missions on real hardware toward first light", async () => {
    const node = await nodeIn("UNDER_REVIEW");
    const telescope = await database.telescope.findFirstOrThrow({
      where: { observatoryId: node.observatoryId },
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
    const mission = (state: "COMPLETE" | "FAILED", mode: "REAL" | "SIMULATED") => ({
      userId: ownerId,
      targetId: target.id,
      observatoryId: node.observatoryId,
      telescopeId: telescope.id,
      state,
      mode,
    });
    await database.mission.createMany({
      data: [
        mission("COMPLETE", "REAL"),
        mission("COMPLETE", "SIMULATED"),
        mission("FAILED", "REAL"),
      ],
    });

    const review = await getNetworkNodeReview(node.nodeId);

    expect(review?.evidence.completedRealMissions).toBe(1);
  });

  it("gives the history oldest first, with each operator's reason verbatim", async () => {
    // Another owner's node in the table, with a history of its own. The review is
    // of one telescope, and must not borrow a stranger's approval.
    await nodeIn("UNDER_REVIEW", strangerId);
    const node = await nodeIn("UNDER_REVIEW");
    await measureEnvelope(node.observatoryId, FAKE_MEASURED_MAX_ALTITUDE_DEGREES);
    await approveNetworkNode({
      nodeId: node.nodeId,
      request: attestation(),
      operatorId,
      now: NOW,
    });
    await suspendNetworkNode({
      nodeId: node.nodeId,
      request: { reason: "owner reported a slipping clutch" },
      operatorId,
      now: NOW,
    });

    const review = await getNetworkNodeReview(node.nodeId);

    expect(review?.history.map((entry) => [entry.action, entry.reason])).toEqual([
      ["REGISTERED", null],
      ["SUBMITTED", null],
      ["APPROVED", "qualified on site, park proven twice"],
      ["SUSPENDED", "owner reported a slipping clutch"],
    ]);
    expect(review?.history.at(-1)?.actorUserId).toBe(operatorId);
    expect(review?.node.approvalStatus).toBe("SUSPENDED");
  });

  it("answers nothing for a node that does not exist", async () => {
    expect(await getNetworkNodeReview(randomUUID())).toBeNull();
  });
});
