import "server-only";

import type { WeekVote } from "@darkview/contracts";

import { findBookableObservatory, type BookableObservatory } from "@/features/booking/observatories";
import { getDatabase } from "@/lib/db/client";
import { evaluateVisibility } from "@/lib/ephemeris/visibility";
import { nightWindow } from "@/lib/slots/darkness";

/** The ballot locks on Sunday at this hour, UTC, as the source product locks its own. */
export const LOCK_HOUR_UTC = 13;

/** How far inside each night the sky is judged: the first and last half hour are twilight's edges. */
const EDGE_MINUTES = 30;

const DAY_MS = 24 * 60 * 60_000;

/** The observatory's local calendar date for an instant, YYYY-MM-DD. */
export function localDateOf(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** The Monday of the week a local date falls in, YYYY-MM-DD. Calendar arithmetic, no clock. */
export function weekOf(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - sinceMonday);
  return date.toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function isMonday(isoDate: string): boolean {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay() === 1;
}

/** Sunday 13:00 UTC of the week beginning on `week`. */
export function locksAtOf(week: string): Date {
  return new Date(Date.parse(`${addDays(week, 6)}T00:00:00Z`) + LOCK_HOUR_UTC * 3_600_000);
}

type TargetRow = Parameters<typeof evaluateVisibility>[0]["target"] & { id: string };

/**
 * The week's candidates: every catalogue target observable on at least one night
 * of the week at this observatory, judged across each night's astronomical darkness
 * at its first half hour, its middle and its last half hour. The observatory's
 * current state is left out on purpose -- a weather hold tonight is not a fact about
 * Saturday -- but its safety envelope is a fact about the instrument and stands: an
 * unmeasured envelope leaves the ballot empty, as it leaves every slot empty.
 */
export async function weekCandidateIds(
  observatory: BookableObservatory,
  week: string,
): Promise<string[]> {
  const database = getDatabase();
  const [targets, safetyEnvelope] = await Promise.all([
    database.target.findMany({ orderBy: { slug: "asc" } }),
    database.safetyEnvelope.findUnique({
      where: { observatoryId: observatory.id },
      select: { maxAltitudeDegrees: true, minAltitudeDegrees: true },
    }),
  ]);
  const site = {
    latitudeDegrees: observatory.latitude,
    longitudeDegrees: observatory.longitude,
  };
  const envelope = safetyEnvelope
    ? {
        maxAltitudeDegrees: safetyEnvelope.maxAltitudeDegrees,
        minAltitudeDegrees: safetyEnvelope.minAltitudeDegrees,
      }
    : null;

  const instants: Date[] = [];
  for (let day = 0; day < 7; day += 1) {
    const window = nightWindow(addDays(week, day), observatory.timezone, site);
    if (!window) continue;
    const dusk = window.duskAt.getTime();
    const dawn = window.dawnAt.getTime();
    const edge = Math.min(EDGE_MINUTES * 60_000, (dawn - dusk) / 2);
    instants.push(new Date(dusk + edge), new Date((dusk + dawn) / 2), new Date(dawn - edge));
  }

  const candidates: string[] = [];
  for (const row of targets as unknown as TargetRow[]) {
    const up = instants.some(
      (at) =>
        evaluateVisibility({
          target: row,
          site,
          envelope,
          observatory: { online: true, weatherHold: false },
          at,
        }).observable,
    );
    if (up) candidates.push(row.id);
  }
  return candidates;
}

async function ballot(
  observatory: BookableObservatory,
  week: string,
  callerId: string | null,
): Promise<WeekVote> {
  const database = getDatabase();
  const weekDate = new Date(`${week}T00:00:00Z`);
  const [candidateIds, counts, mine] = await Promise.all([
    weekCandidateIds(observatory, week),
    database.vote.groupBy({
      by: ["targetId"],
      where: { observatoryId: observatory.id, week: weekDate },
      _count: { _all: true },
    }),
    callerId
      ? database.vote.findUnique({
          where: {
            userId_observatoryId_week: {
              userId: callerId,
              observatoryId: observatory.id,
              week: weekDate,
            },
          },
          select: { targetId: true },
        })
      : Promise.resolve(null),
  ]);
  const votesOf = new Map(counts.map((row) => [row.targetId, row._count._all]));
  const candidates = candidateIds
    .map((targetId) => ({ targetId, votes: votesOf.get(targetId) ?? 0 }))
    .sort((a, b) => b.votes - a.votes);
  return {
    observatoryId: observatory.id,
    week,
    locksAt: locksAtOf(week).toISOString(),
    candidates,
    // A vote for a target that has since left the ballot is still the caller's vote.
    mine: mine?.targetId ?? null,
  };
}

export type WeekVoteRefusal =
  | { kind: "not-found" }
  | { kind: "not-monday" }
  | { kind: "locked" }
  | { kind: "not-a-candidate" };

export type WeekVoteResult = { ok: true; vote: WeekVote } | { ok: false; refusal: WeekVoteRefusal };

/** GET /votes: the week's ballot, with the caller's vote when there is a caller. */
export async function readWeekVote(input: {
  observatoryId: string;
  week?: string;
  callerId: string | null;
  now: Date;
}): Promise<WeekVoteResult> {
  const observatory = await findBookableObservatory(input.observatoryId);
  if (!observatory) return { ok: false, refusal: { kind: "not-found" } };
  const week = input.week ?? weekOf(localDateOf(input.now, observatory.timezone));
  if (!isMonday(week)) return { ok: false, refusal: { kind: "not-monday" } };
  return { ok: true, vote: await ballot(observatory, week, input.callerId) };
}

/** POST /votes: cast, or move, the caller's vote. Every customer's vote counts once. */
export async function castVote(input: {
  observatoryId: string;
  week: string;
  targetId: string;
  userId: string;
  now: Date;
}): Promise<WeekVoteResult> {
  const observatory = await findBookableObservatory(input.observatoryId);
  if (!observatory) return { ok: false, refusal: { kind: "not-found" } };
  if (!isMonday(input.week)) return { ok: false, refusal: { kind: "not-monday" } };
  if (input.now.getTime() >= locksAtOf(input.week).getTime())
    return { ok: false, refusal: { kind: "locked" } };

  const candidates = await weekCandidateIds(observatory, input.week);
  if (!candidates.includes(input.targetId))
    return { ok: false, refusal: { kind: "not-a-candidate" } };

  const week = new Date(`${input.week}T00:00:00Z`);
  await getDatabase().vote.upsert({
    where: {
      userId_observatoryId_week: {
        userId: input.userId,
        observatoryId: observatory.id,
        week,
      },
    },
    create: { userId: input.userId, observatoryId: observatory.id, week, targetId: input.targetId },
    update: { targetId: input.targetId },
  });

  return { ok: true, vote: await ballot(observatory, input.week, input.userId) };
}
