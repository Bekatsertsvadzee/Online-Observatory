import "server-only";

import type { AdminObservatoryList } from "@darkview/contracts";

import { realHardwareAllowedInDemo } from "@/lib/deployment";
import { getDatabase } from "@/lib/db/client";
import { getServerEnvironment } from "@/lib/validation/env";

/**
 * GET /admin/observatories (ADR-074): every observatory, bookable or not, oldest
 * first, so the operator console can reach the demo's hardware test observatory.
 */
export async function listObservatoriesForOperator(): Promise<AdminObservatoryList> {
  const hardwareTestId = getServerEnvironment().DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID;
  const rows = await getDatabase().observatory.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      slug: true,
      nameEn: true,
      nameKa: true,
      mode: true,
      isDemo: true,
      networkNode: { select: { kind: true, approvalStatus: true } },
    },
  });

  return {
    items: rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      nameEn: row.nameEn,
      nameKa: row.nameKa,
      mode: row.mode,
      isDemo: row.isDemo,
      hardwareTest: realHardwareAllowedInDemo(row.id, hardwareTestId),
      kind: row.networkNode?.kind ?? null,
      approvalStatus: row.networkNode?.approvalStatus ?? null,
    })),
  };
}
