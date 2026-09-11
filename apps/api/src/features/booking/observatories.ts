import "server-only";

import type { BookableObservatoryList } from "@darkview/contracts";
import type { Prisma } from "@darkview/db";

import { getDatabase } from "@/lib/db/client";
import type { LocalWindow } from "@/lib/slots/availability";

/**
 * What makes an observatory bookable, written once (ADR-015, DV-066).
 *
 * **An APPROVED network node, whatever its kind.** A first-party observatory is
 * approved the same way a partner one is, so there is one rule rather than two,
 * and the first-party site cannot become bookable by the accident of having no
 * node. DRAFT, UNDER_REVIEW and SUSPENDED are not bookable: ADR-013 makes
 * APPROVED the only state in which somebody else's telescope may be operated, and
 * a telescope that may not be operated may not be sold.
 *
 * **And a primary telescope.** A booking is time on an instrument, and the node
 * names which one. `primaryTelescopeId` is set at registration and nulled only if
 * the telescope row is deleted; a node that has lost it has nothing to sell.
 *
 * Every surface that answers "may this be booked?" reads this filter. Before
 * DV-066 the slot list and the reservation each resolved the observatory with
 * `findFirst` and each read the node separately, which is two chances to disagree
 * about the same telescope.
 */
const BOOKABLE = {
  approvalStatus: "APPROVED",
  primaryTelescopeId: { not: null },
} satisfies Prisma.ObservatoryNetworkNodeWhereInput;

export type BookableObservatory = {
  id: string;
  timezone: string;
  latitude: number;
  longitude: number;
  status: string;
  isDemo: boolean;
  weatherHold: boolean;
  telescopeId: string;
  /** The hours the owner offered (DV-121). Disabled rows are already excluded. */
  windows: LocalWindow[];
};

/**
 * One bookable observatory, or null.
 *
 * Null for an id that does not exist and for one whose node is not bookable, and
 * the callers answer both the same way. Whether a suspended partner node exists is
 * not something a customer is entitled to learn by probing ids.
 */
export async function findBookableObservatory(
  observatoryId: string,
): Promise<BookableObservatory | null> {
  const node = await getDatabase().observatoryNetworkNode.findFirst({
    where: { observatoryId, ...BOOKABLE },
    select: {
      primaryTelescopeId: true,
      // Disabled rows are excluded here rather than filtered later: `enabled` is
      // how an owner switches a window off without deleting it, and a disabled
      // window must not be distinguishable from one that was never recorded.
      availabilityWindows: {
        where: { enabled: true },
        select: { weekday: true, startMinute: true, endMinute: true },
      },
      observatory: {
        select: {
          id: true,
          timezone: true,
          latitude: true,
          longitude: true,
          status: true,
          isDemo: true,
          weatherState: { select: { holdActive: true } },
        },
      },
    },
  });

  // BOOKABLE already refuses a null telescope. Narrowing again keeps the type
  // honest without a non-null assertion that would survive the filter changing.
  if (!node || !node.primaryTelescopeId) return null;

  return {
    id: node.observatory.id,
    timezone: node.observatory.timezone,
    latitude: node.observatory.latitude,
    longitude: node.observatory.longitude,
    status: node.observatory.status,
    isDemo: node.observatory.isDemo,
    weatherHold: node.observatory.weatherState?.holdActive ?? false,
    telescopeId: node.primaryTelescopeId,
    windows: node.availabilityWindows,
  };
}

/**
 * GET /observatories -- every telescope a customer may book.
 *
 * Public-safe fields only. Latitude and longitude are read by the slot generator
 * and never leave it: `PublicObservatoryStatus` already excludes coordinates
 * precise enough to be actionable, and the precise position of a telescope on
 * somebody else's roof is not a public field.
 *
 * Ordered by creation, so the first-party observatory -- which predates every
 * partner -- comes first, and the order does not move when a new one is approved.
 */
export async function listBookableObservatories(): Promise<BookableObservatoryList> {
  const nodes = await getDatabase().observatoryNetworkNode.findMany({
    where: BOOKABLE,
    orderBy: { observatory: { createdAt: "asc" } },
    select: {
      kind: true,
      observatory: {
        select: {
          id: true,
          slug: true,
          nameEn: true,
          nameKa: true,
          city: true,
          countryCode: true,
          timezone: true,
        },
      },
      primaryTelescope: {
        select: {
          manufacturer: true,
          model: true,
          apertureMm: true,
          focalLengthMm: true,
        },
      },
    },
  });

  return {
    items: nodes.flatMap((node) =>
      node.primaryTelescope
        ? [
            {
              id: node.observatory.id,
              slug: node.observatory.slug,
              kind: node.kind,
              nameEn: node.observatory.nameEn,
              nameKa: node.observatory.nameKa,
              city: node.observatory.city,
              countryCode: node.observatory.countryCode,
              timezone: node.observatory.timezone,
              telescope: {
                manufacturer: node.primaryTelescope.manufacturer,
                model: node.primaryTelescope.model,
                apertureMm: node.primaryTelescope.apertureMm,
                focalLengthMm: node.primaryTelescope.focalLengthMm,
              },
            },
          ]
        : [],
    ),
  };
}
