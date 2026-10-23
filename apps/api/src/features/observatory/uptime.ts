import "server-only";

import type { ObservatoryUptime, ObservatoryUptimeIncident } from "@darkview/contracts";

import { findBookableObservatory } from "@/features/booking/observatories";
import { getDatabase } from "@/lib/db/client";
import { localWallClockToUtc } from "@/lib/slots/darkness";

/**
 * Thirty days of the agent link's uptime (Phase 6.0), from the link's own audit
 * trail. Nothing is recorded to answer it: the realtime service already writes
 * AGENT_LINK_UP on every accepted hello and AGENT_LINK_LOST on every loss.
 */

export const UPTIME_DAYS = 30;
const MAX_INCIDENTS = 20;

export type LinkEvent = { at: Date; up: boolean };

function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function shiftDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function percent(online: number, measured: number): number | null {
  return measured === 0 ? null : Math.round((online / measured) * 10_000) / 100;
}

/**
 * Pure. `before` is the last event earlier than the window, or null when the link
 * had none: then time before the first event in the window is unmeasured.
 * `events` are the window's events in time order.
 */
export function computeUptime(input: {
  observatoryId: string;
  timeZone: string;
  now: Date;
  before: LinkEvent | null;
  events: LinkEvent[];
}): ObservatoryUptime {
  const { observatoryId, timeZone, now, before, events } = input;
  const today = localDate(now, timeZone);
  const dates = Array.from({ length: UPTIME_DAYS }, (_, index) =>
    shiftDate(today, index - (UPTIME_DAYS - 1)),
  );
  const starts = dates.map((date) => localWallClockToUtc(date, 0, timeZone).getTime());
  const from = starts[0];
  const end = now.getTime();

  // The window as runs of a known state: [start, end) up or down.
  const runs: { start: number; end: number; up: boolean }[] = [];
  let state: boolean | null = before ? before.up : null;
  let cursor = from;
  for (const event of events) {
    const at = Math.min(Math.max(event.at.getTime(), from), end);
    if (state !== null && at > cursor) runs.push({ start: cursor, end: at, up: state });
    state = event.up;
    cursor = Math.max(cursor, at);
  }
  if (state !== null && end > cursor) runs.push({ start: cursor, end, up: state });

  const days = dates.map((date, index) => {
    const dayStart = starts[index];
    const dayEnd = Math.min(
      index + 1 < starts.length ? starts[index + 1] : Infinity,
      end,
    );
    let measured = 0;
    let online = 0;
    for (const run of runs) {
      const overlap = Math.min(run.end, dayEnd) - Math.max(run.start, dayStart);
      if (overlap <= 0) continue;
      measured += overlap;
      if (run.up) online += overlap;
    }
    const measuredSeconds = Math.round(measured / 1000);
    const onlineSeconds = Math.round(online / 1000);
    return {
      date,
      measuredSeconds,
      onlineSeconds,
      uptimePercent: percent(onlineSeconds, measuredSeconds),
    };
  });

  const incidents: ObservatoryUptimeIncident[] = [];
  let lostAt: Date | null = before && !before.up ? before.at : null;
  for (const event of events) {
    if (!event.up && lostAt === null) lostAt = event.at;
    if (event.up && lostAt !== null) {
      incidents.push({
        lostAt: lostAt.toISOString(),
        restoredAt: event.at.toISOString(),
      });
      lostAt = null;
    }
  }
  if (lostAt !== null) incidents.push({ lostAt: lostAt.toISOString(), restoredAt: null });

  const measured = days.reduce((sum, day) => sum + day.measuredSeconds, 0);
  const online = days.reduce((sum, day) => sum + day.onlineSeconds, 0);

  return {
    observatoryId,
    timezone: timeZone,
    from: new Date(from).toISOString(),
    to: now.toISOString(),
    uptimePercent: percent(online, measured),
    days,
    incidents: incidents.reverse().slice(0, MAX_INCIDENTS),
  };
}

const LINK_ACTIONS = ["AGENT_LINK_UP", "AGENT_LINK_LOST"];

/** Null when the observatory is not bookable, which the route answers with 404. */
export async function readObservatoryUptime(
  observatoryId: string,
  now: Date,
): Promise<ObservatoryUptime | null> {
  const observatory = await findBookableObservatory(observatoryId);
  if (!observatory) return null;

  const timeZone = observatory.timezone;
  const today = localDate(now, timeZone);
  const from = localWallClockToUtc(shiftDate(today, -(UPTIME_DAYS - 1)), 0, timeZone);
  const where = {
    category: "AGENT_LINK" as const,
    action: { in: LINK_ACTIONS },
    entityType: "Observatory",
    entityId: observatory.id,
  };

  const database = getDatabase();
  const [before, rows] = await Promise.all([
    database.auditLog.findFirst({
      where: { ...where, createdAt: { lt: from } },
      orderBy: { createdAt: "desc" },
      select: { action: true, createdAt: true },
    }),
    database.auditLog.findMany({
      where: { ...where, createdAt: { gte: from, lte: now } },
      orderBy: { createdAt: "asc" },
      select: { action: true, createdAt: true },
    }),
  ]);

  const toEvent = (row: { action: string; createdAt: Date }): LinkEvent => ({
    at: row.createdAt,
    up: row.action === "AGENT_LINK_UP",
  });

  return computeUptime({
    observatoryId: observatory.id,
    timeZone,
    now,
    before: before ? toEvent(before) : null,
    events: rows.map(toEvent),
  });
}
