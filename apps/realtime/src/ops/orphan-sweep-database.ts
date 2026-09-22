import type { PrismaClient } from "@darkview/db";
import { recordAuditEvent } from "@darkview/db/audit";

import type { SweepDependencies } from "@/ops/orphan-sweep";

/**
 * The sweep's two questions of the database, apart from the command line so the
 * integration suite exercises exactly what an operator runs.
 */
export function databaseDependencies(
  database: PrismaClient,
): Pick<SweepDependencies, "referenced" | "audit"> {
  return {
    async referenced(keys) {
      const rows = await database.captureAsset.findMany({
        where: { storageKey: { in: keys } },
        select: { storageKey: true },
      });
      return new Set(rows.map((row) => row.storageKey));
    },

    async audit(object, key, ageHours) {
      // The mission is named in the detail, not the missionId column: that column
      // is a foreign key, and a sweep must never fail to record a deletion it has
      // already made because of what the key happens to name.
      await recordAuditEvent(
        {
          category: "MISSION",
          action: "CAPTURE_OBJECT_DELETED",
          entityType: "CaptureObject",
          detail: {
            key: object.key,
            bytes: object.size,
            ageHours: Math.round(ageHours),
            observatoryId: key.observatoryId,
            missionId: key.missionId,
            commandId: key.commandId,
            kind: key.kind,
          },
        },
        database,
      );
    },
  };
}
