import "server-only";

import type { SlotTargetList, SlotVisibility } from "@darkview/contracts";

import {
  findBookableObservatory,
  type BookableObservatory,
} from "@/features/booking/observatories";
import { toContractTarget, type TargetRow } from "@/features/targets/projection";
import { getDatabase } from "@/lib/db/client";
import { evaluateSlotVisibility } from "@/lib/ephemeris/slot-visibility";
import { evaluateVisibility, type VisibilityInput } from "@/lib/ephemeris/visibility";
import { loadSafetyEnvelope, siteOf } from "@/lib/safety/store";

type EnvelopeOf = Awaited<ReturnType<typeof loadSafetyEnvelope>>;

function judge(
  observatory: BookableObservatory,
  envelope: EnvelopeOf,
  target: VisibilityInput["target"],
  startAt: Date,
  durationMinutes: number,
): SlotVisibility {
  return evaluateSlotVisibility({
    target,
    site: siteOf(observatory),
    // Admitted for the observatory's mode (ADR-032), as the mission start loads it.
    envelope,
    observatory: {
      online: observatory.status === "ONLINE",
      weatherHold: observatory.weatherHold,
    },
    startAt,
    durationMinutes,
  });
}

/**
 * GET /targets/visibility: the catalogue judged across one slot (#151).
 *
 * Every target appears, as on `GET /targets/tonight`, each with the reasons it
 * cannot be delivered. Null when the observatory is not bookable.
 */
export async function listSlotTargets(
  observatoryId: string,
  startAt: Date,
  durationMinutes: number,
): Promise<SlotTargetList | null> {
  const observatory = await findBookableObservatory(observatoryId);
  if (!observatory) return null;

  const envelope = await loadSafetyEnvelope(observatory.id);
  const targets = await getDatabase().target.findMany({ orderBy: { slug: "asc" } });

  return {
    observatoryId: observatory.id,
    startAt: startAt.toISOString(),
    durationMinutes,
    items: targets.map((row) => ({
      target: toContractTarget(row as unknown as TargetRow),
      visibility: judge(observatory, envelope, row, startAt, durationMinutes),
    })),
  };
}

/**
 * Whether one target can be delivered in a slot being booked. The same judgement
 * `GET /targets/visibility` shows, so the list and the booking cannot disagree.
 */
export async function slotVisibilityForBooking(
  observatory: BookableObservatory,
  target: VisibilityInput["target"],
  startAt: Date,
  durationMinutes: number,
): Promise<SlotVisibility> {
  const envelope = await loadSafetyEnvelope(observatory.id);
  return judge(observatory, envelope, target, startAt, durationMinutes);
}

/**
 * The target the platform assigns when a booking names none: of the enabled targets
 * that fit the slot's length and that `GET /targets/visibility` judges observable
 * across the whole slot, the one highest above the horizon at mid-slot. Ties go to
 * the earlier slug, the catalogue's order, so the same slot always gets the same
 * answer. Null when nothing qualifies.
 */
export async function bestTargetForSlot(
  observatory: BookableObservatory,
  startAt: Date,
  durationMinutes: number,
) {
  const envelope = await loadSafetyEnvelope(observatory.id);
  const targets = await getDatabase().target.findMany({
    where: { enabled: true, expectedMissionMinutes: { lte: durationMinutes } },
    orderBy: { slug: "asc" },
  });
  const midSlot = new Date(startAt.getTime() + (durationMinutes * 60_000) / 2);

  let best: { target: (typeof targets)[number]; altitude: number } | null = null;
  for (const target of targets) {
    const visibility = judge(observatory, envelope, target, startAt, durationMinutes);
    if (!visibility.observable) continue;
    const altitude = evaluateVisibility({
      target,
      site: siteOf(observatory),
      envelope,
      observatory: {
        online: observatory.status === "ONLINE",
        weatherHold: observatory.weatherHold,
      },
      at: midSlot,
    }).horizontal.altitudeDegrees;
    if (!best || altitude > best.altitude) best = { target, altitude };
  }
  return best?.target ?? null;
}
