import { createHmac } from "node:crypto";

import type { PrismaClient } from "@darkview/db";
import { queueEmail } from "@darkview/db/notifications";

/**
 * DV-064: delivering the email outbox, and queueing slot reminders.
 *
 * Here because this is the only long-lived process. Both jobs run on timers and
 * both are safe to run twice: a reminder is deduplicated by its key, and a
 * delivery is claimed with a conditional update before it is attempted.
 *
 * The outbox row carries ids, never message text. What is sent is read from the
 * database at the moment of sending, so a customer who changed their address or
 * locale gets the email at the new one, and a booking cancelled after its
 * reminder was queued is not reminded about.
 */

/** Maintainer decision, 2026-09-15: one reminder, two hours before the slot. */
export const REMINDER_LEAD_MINUTES = 120;

/** After this many failed deliveries an email is given up on, never retried forever. */
export const MAX_ATTEMPTS = 8;

/** How long a claimed delivery is held before another pass may try it again. */
const CLAIM_LEASE_MS = 5 * 60_000;
const DELIVERY_TIMEOUT_MS = 5_000;
const BATCH_SIZE = 25;

export type EmailWebhook = { url: string; secret: string };

export type DispatchSummary = { sent: number; retrying: number; failed: number; skipped: number };

/** Minutes before the nth retry: 1, 2, 4, ... capped at an hour. */
export function retryDelayMs(attempt: number): number {
  return Math.min(2 ** Math.max(attempt - 1, 0), 60) * 60_000;
}

export async function queueSlotReminders(database: PrismaClient, now: Date): Promise<number> {
  const bookings = await database.booking.findMany({
    where: {
      status: "CONFIRMED",
      slotStartAt: { gt: now, lte: new Date(now.getTime() + REMINDER_LEAD_MINUTES * 60_000) },
    },
    select: { id: true, userId: true },
  });

  let queued = 0;
  for (const booking of bookings) {
    const created = await queueEmail(database, {
      userId: booking.userId,
      kind: "SLOT_REMINDER",
      dedupeKey: `slot-reminder:${booking.id}`,
      payload: { bookingId: booking.id },
    });
    if (created) queued += 1;
  }
  return queued;
}

/**
 * What the email says, read now. Null when it no longer applies.
 *
 * Both names are sent and the mail service picks by locale, so the template --
 * not this code -- owns the wording in Georgian and English.
 */
async function describe(
  database: PrismaClient,
  kind: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (kind === "CAPTURE_READY") {
    const capture = await database.capture.findUnique({
      where: { id: String(payload.captureId) },
      select: {
        id: true,
        capturedAt: true,
        mode: true,
        target: { select: { nameEn: true, nameKa: true } },
      },
    });
    if (!capture) return null;
    return {
      captureId: capture.id,
      capturedAt: capture.capturedAt.toISOString(),
      // A simulator capture says so in the email as well as in the Collection.
      simulated: capture.mode === "SIMULATED",
      target: capture.target,
    };
  }

  const booking = await database.booking.findUnique({
    where: { id: String(payload.bookingId) },
    select: {
      id: true,
      status: true,
      slotStartAt: true,
      durationMinutes: true,
      target: { select: { nameEn: true, nameKa: true } },
      observatory: { select: { nameEn: true, nameKa: true, timezone: true } },
    },
  });
  if (!booking || booking.status !== "CONFIRMED") return null;

  return {
    bookingId: booking.id,
    slotStartAt: booking.slotStartAt.toISOString(),
    durationMinutes: booking.durationMinutes,
    target: booking.target,
    observatory: booking.observatory,
  };
}

export async function dispatchPendingEmails(input: {
  database: PrismaClient;
  webhook: EmailWebhook;
  now: Date;
  fetchImpl?: typeof fetch;
}): Promise<DispatchSummary> {
  const { database, webhook, now } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const summary: DispatchSummary = { sent: 0, retrying: 0, failed: 0, skipped: 0 };

  const due = await database.emailNotification.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: now } },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
    select: {
      id: true,
      kind: true,
      payload: true,
      attempts: true,
      user: { select: { email: true, name: true, locale: true, emailVerifiedAt: true } },
    },
  });

  for (const row of due) {
    // Claimed before it is attempted. A second pass running at the same moment
    // finds the row already moved on and leaves it, so nobody gets two emails.
    const { count } = await database.emailNotification.updateMany({
      where: { id: row.id, status: "PENDING", attempts: row.attempts },
      data: {
        attempts: { increment: 1 },
        nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS),
      },
    });
    if (count === 0) continue;
    const attempt = row.attempts + 1;

    const data = row.user.emailVerifiedAt
      ? await describe(database, row.kind, row.payload as Record<string, unknown>)
      : null;
    if (!data) {
      await database.emailNotification.update({
        where: { id: row.id },
        data: { status: "SKIPPED" },
      });
      summary.skipped += 1;
      continue;
    }

    const body = JSON.stringify({
      notificationId: row.id,
      kind: row.kind,
      locale: row.user.locale,
      recipient: { email: row.user.email, name: row.user.name },
      data,
    });

    try {
      const response = await fetchImpl(webhook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-darkview-signature": createHmac("sha256", webhook.secret)
            .update(body)
            .digest("base64url"),
          // The mail service deduplicates on this. A delivery that succeeded but
          // whose response was lost is retried with the same key.
          "idempotency-key": row.id,
        },
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`mail service answered ${response.status}`);

      await database.emailNotification.update({
        where: { id: row.id },
        data: { status: "SENT", sentAt: now, lastError: null },
      });
      summary.sent += 1;
    } catch (error) {
      const lastError = error instanceof Error ? error.message : String(error);
      const exhausted = attempt >= MAX_ATTEMPTS;
      await database.emailNotification.update({
        where: { id: row.id },
        data: exhausted
          ? { status: "FAILED", lastError }
          : { nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempt)), lastError },
      });
      if (exhausted) summary.failed += 1;
      else summary.retrying += 1;
    }
  }

  return summary;
}
