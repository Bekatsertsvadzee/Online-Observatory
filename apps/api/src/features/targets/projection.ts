import type { Target as ContractTarget } from "@darkview/contracts";

/** The Target columns this projection needs. */
export type TargetRow = {
  id: string;
  slug: string;
  catalogId: string | null;
  type: string;
  nameEn: string;
  nameKa: string;
  descriptionEn: string | null;
  descriptionKa: string | null;
  positionSource: string;
  rightAscensionHours: number | null;
  declinationDegrees: number | null;
  solarSystemBody: string | null;
  angularSizeArcmin: number;
  magnitude: number;
  opticalConfig: string;
  imagingProfile: string;
  minAltitudeDegrees: number;
  expectedMissionMinutes: number;
  previewImageUrl: string | null;
  enabled: boolean;
};

/**
 * A stored target projected into the contract's Target.
 *
 * The row keeps right ascension and declination in two columns because that is
 * how a database stores numbers; the contract groups them into `coordinates`
 * with an explicit epoch, so a client can never mistake J2000 for apparent.
 * A moving target carries no coordinates at all.
 */
export function toContractTarget(row: TargetRow): ContractTarget {
  return {
    id: row.id,
    slug: row.slug,
    catalogId: row.catalogId,
    type: row.type as ContractTarget["type"],
    nameEn: row.nameEn,
    nameKa: row.nameKa,
    descriptionEn: row.descriptionEn,
    descriptionKa: row.descriptionKa,
    positionSource: row.positionSource as ContractTarget["positionSource"],
    coordinates:
      row.positionSource === "FIXED" &&
      row.rightAscensionHours !== null &&
      row.declinationDegrees !== null
        ? {
            raHours: row.rightAscensionHours,
            decDegrees: row.declinationDegrees,
            epoch: "J2000",
          }
        : null,
    solarSystemBody: row.solarSystemBody as ContractTarget["solarSystemBody"],
    angularSizeArcmin: row.angularSizeArcmin,
    magnitude: row.magnitude,
    opticalConfig: row.opticalConfig as ContractTarget["opticalConfig"],
    imagingProfile: row.imagingProfile as ContractTarget["imagingProfile"],
    minAltitudeDegrees: row.minAltitudeDegrees,
    expectedMissionMinutes: row.expectedMissionMinutes,
    previewImageUrl: row.previewImageUrl,
    enabled: row.enabled,
  };
}
