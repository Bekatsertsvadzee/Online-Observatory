import "server-only";

import { randomUUID } from "node:crypto";

import type { NetworkNode, RegisterNetworkNodeRequest } from "@darkview/contracts";
import { recordAuditEvent } from "@darkview/db/audit";
import type { Prisma } from "@darkview/db";

import { getDatabase } from "@/lib/db/client";

/**
 * Partner observatories, from the owner's side (ADR-013).
 *
 * A telescope somebody else owns, joining the network by installing the agent on
 * their own machine. Nothing here grants a node any authority: registration
 * creates it in `DRAFT`, and `DRAFT` refuses everything. The path out of refusal
 * is an operator's qualification, which lives in `features/admin/network.ts`
 * because it is an operator action and is audited as one.
 */

/**
 * The columns a contract `NetworkNode` is built from.
 *
 * `safetyEnvelope` comes along because whether an instrument has a *measured*
 * altitude limit is part of what a node is. It is reported rather than asserted
 * -- see `approveNetworkNode` -- and a reader of a node should be able to see the
 * same thing approval checks.
 */
const NODE_COLUMNS = {
  id: true,
  observatoryId: true,
  ownerId: true,
  kind: true,
  approvalStatus: true,
  capabilities: true,
  approvedAt: true,
  createdAt: true,
  observatory: {
    select: {
      nameEn: true,
      city: true,
      countryCode: true,
      timezone: true,
      safetyEnvelope: { select: { maxAltitudeDegrees: true } },
    },
  },
} satisfies Prisma.ObservatoryNetworkNodeSelect;

type NodeRow = Prisma.ObservatoryNetworkNodeGetPayload<{ select: typeof NODE_COLUMNS }>;

export function toContractNode(row: NodeRow): NetworkNode {
  return {
    nodeId: row.id,
    observatoryId: row.observatoryId,
    ownerId: row.ownerId,
    kind: row.kind,
    approvalStatus: row.approvalStatus,
    siteName: row.observatory.nameEn,
    city: row.observatory.city,
    countryCode: row.observatory.countryCode,
    timezone: row.observatory.timezone,
    // Null is UNMEASURED, and every slew is refused while it holds -- by the
    // cloud and independently by the agent. That is the shipped state of every
    // instrument until somebody measures where its optical train meets its mount.
    safetyEnvelopeMeasured: row.observatory.safetyEnvelope?.maxAltitudeDegrees != null,
    capabilities: row.capabilities,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A slug nobody has to choose.
 *
 * Derived from the site name so an operator reading a URL can tell which site it
 * is, plus a random suffix so two people in Tbilisi naming their roof "Tbilisi"
 * do not collide. The name is not trusted to be sluggable -- it can be Georgian,
 * Spanish or an emoji -- so anything outside the allowed set is dropped, and a
 * name that reduces to nothing still yields a usable slug from the suffix.
 */
function slugFor(siteName: string) {
  const base = siteName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base ? `${base}-` : "node-"}${randomUUID().slice(0, 8)}`;
}

export type RegisterResult = { ok: true; node: NetworkNode };

/**
 * Register a telescope somebody owns.
 *
 * The site, the instrument and the node are created together, in one
 * transaction: a partner has none of the three until they register, and a site
 * with no node or a node with no instrument is a half-registration somebody would
 * have to clean up.
 *
 * The observatory is created `OFFLINE`, `SIMULATED`, and with no device token.
 * None of those is an oversight. There is no agent yet, nothing has been
 * qualified, and a null `deviceTokenHash` is what the link service reads as "no
 * agent may connect" -- so a freshly registered node cannot be reached even by
 * somebody who knows its identifiers.
 */
export async function registerNetworkNode(input: {
  ownerId: string;
  request: RegisterNetworkNodeRequest;
  now: Date;
}): Promise<RegisterResult> {
  const { request } = input;

  const node = await getDatabase().$transaction(async (tx) => {
    const observatory = await tx.observatory.create({
      data: {
        slug: slugFor(request.siteName),
        // One name, written to both language columns. A telescope on a roof in
        // Santiago has one name, and inventing a Georgian translation of somebody
        // else's property would be fabricating data. The first-party observatory
        // is bilingual because Darkview named it in both languages.
        nameEn: request.siteName,
        nameKa: request.siteName,
        city: request.city,
        countryCode: request.countryCode,
        latitude: request.latitude,
        longitude: request.longitude,
        timezone: request.timezone,
        telescopes: {
          create: {
            name: request.telescope.name,
            manufacturer: request.telescope.manufacturer,
            model: request.telescope.model,
            apertureMm: request.telescope.apertureMm,
            focalLengthMm: request.telescope.focalLengthMm,
          },
        },
      },
      select: { id: true, telescopes: { select: { id: true } } },
    });

    const created = await tx.observatoryNetworkNode.create({
      data: {
        ownerId: input.ownerId,
        observatoryId: observatory.id,
        primaryTelescopeId: observatory.telescopes[0]?.id ?? null,
        kind: "PARTNER",
        // Explicit rather than left to the column default. The resting state of a
        // partner telescope is the most important fact about this row.
        approvalStatus: "DRAFT",
        capabilities: [],
      },
      select: NODE_COLUMNS,
    });

    await recordAuditEvent(
      {
        category: "OBSERVATORY_MODE",
        action: "NETWORK_NODE_REGISTERED",
        actorUserId: input.ownerId,
        entityType: "ObservatoryNetworkNode",
        entityId: created.id,
        detail: { observatoryId: observatory.id, city: request.city },
      },
      tx,
    );

    return created;
  });

  return { ok: true, node: toContractNode(node) };
}

/** The caller's own nodes. Scoped by ownerId in the query, never filtered after. */
export async function listMyNetworkNodes(ownerId: string): Promise<NetworkNode[]> {
  const rows = await getDatabase().observatoryNetworkNode.findMany({
    where: { ownerId },
    orderBy: { createdAt: "desc" },
    select: NODE_COLUMNS,
  });

  return rows.map(toContractNode);
}

export type SubmitFailure = { ok: false; status: 404 | 409; message: string };
export type SubmitResult = { ok: true; node: NetworkNode } | SubmitFailure;

/**
 * The owner says the telescope is ready to be looked at.
 *
 * `DRAFT` to `UNDER_REVIEW`, and that is the whole of it. It grants nothing, and
 * it is deliberately not a state the node can leave on its own: only an operator
 * moves it further, because ADR-013 puts a person between a stranger's telescope
 * and a customer.
 *
 * Re-submitting a node already under review is refused rather than treated as
 * idempotent. It is not a retry of the same intention -- somebody is asking why
 * nothing has happened yet, and answering 200 would tell them it just did.
 */
export async function submitNetworkNodeForReview(input: {
  ownerId: string;
  nodeId: string;
}): Promise<SubmitResult> {
  const database = getDatabase();

  // Scoped by ownerId, so a node belonging to somebody else is indistinguishable
  // from one that does not exist.
  const node = await database.observatoryNetworkNode.findFirst({
    where: { id: input.nodeId, ownerId: input.ownerId },
    select: { id: true, approvalStatus: true },
  });

  if (!node) return { ok: false, status: 404, message: "No such node." };

  if (node.approvalStatus !== "DRAFT") {
    return {
      ok: false,
      status: 409,
      message: `A node in ${node.approvalStatus} cannot be submitted for review.`,
    };
  }

  const updated = await database.observatoryNetworkNode.update({
    where: { id: node.id },
    data: { approvalStatus: "UNDER_REVIEW" },
    select: NODE_COLUMNS,
  });

  await recordAuditEvent(
    {
      category: "OBSERVATORY_MODE",
      action: "NETWORK_NODE_SUBMITTED",
      actorUserId: input.ownerId,
      entityType: "ObservatoryNetworkNode",
      entityId: node.id,
    },
    // Outside a transaction, and there is nothing for it to be atomic with: the
    // update above is the only write, and it has already committed.
    database,
  );

  return { ok: true, node: toContractNode(updated) };
}
