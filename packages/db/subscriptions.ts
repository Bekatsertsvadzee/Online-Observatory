/**
 * The shape of a subscription period (ADR-022).
 *
 * Shared because the API opens the first period when the customer subscribes and
 * the realtime sweep opens every one after it, and a month that means two
 * different things on the two sides would put a renewal a day out from the
 * expiry it is supposed to replace.
 */

/**
 * One calendar month after `from`, clamped to the end of the month it lands in.
 *
 * Calendar months, not thirty days: a customer who subscribes on the 3rd renews
 * on the 3rd. The clamp is why this is not `setUTCMonth(+1)` -- that overflows,
 * so the 31st of January would become the 3rd of March and February would be
 * charged for twice. Clamped, it becomes the 28th.
 *
 * A clamped date does not spring back: a subscription that starts on the 31st
 * renews on the 28th from February onwards, because each period is measured
 * from the one before it. That is a day or three of sky in the customer's
 * favour once, and the alternative is storing an anchor day nothing else needs.
 */
export function nextPeriodEnd(from: Date): Date {
  const day = from.getUTCDate();
  const end = new Date(from);
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0),
  ).getUTCDate();
  end.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return end;
}
