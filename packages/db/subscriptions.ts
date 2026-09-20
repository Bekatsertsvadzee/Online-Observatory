/**
 * The shape of a subscription period (ADR-022).
 *
 * Shared because the API opens the first period when the customer subscribes and
 * the realtime sweep opens every one after it, and a month that means two
 * different things on the two sides would put a renewal a day out from the
 * expiry it is supposed to replace.
 */

/**
 * Where a billing month is a month.
 *
 * Darkview sells from Tbilisi and its customers live there, so "the 1st" means
 * the 1st in Georgia. Doing the arithmetic in UTC looks identical for most of
 * the day and is wrong for the four hours after local midnight: a subscription
 * taken at 02:00 on 1 February is 22:00 on 31 January in UTC, and a UTC
 * calendar renews it on the 31st, then the 28th, then the 28th -- three
 * different days, none of them the day the customer chose.
 */
export const BILLING_TIME_ZONE = "Asia/Tbilisi";

type LocalParts = { year: number; month: number; day: number };

/**
 * Formatters are cached per zone. Building one costs about as much as the
 * arithmetic it serves, and the renewal sweep calls this once per subscription
 * it is renewing.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function localPartsOf(at: Date, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(at);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

/** How far this zone is from UTC at this instant, in milliseconds. */
function offsetAt(at: Date, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(at);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour") % 24,
    value("minute"),
    value("second"),
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant at which the zone's calendar reads this local date, keeping the
 * time of day `from` had.
 *
 * Two passes: the offset is read at an approximate instant and then re-read at
 * the answer, because a zone's offset is itself a function of the moment. Georgia
 * has kept a fixed +4 since 2005 and the second pass changes nothing there --
 * but a shared billing calculation that is only correct in one country is the
 * kind of thing that is discovered by a customer.
 */
function instantOfLocalDate(local: LocalParts, from: Date, timeZone: string): Date {
  const timeOfDay = from.getTime() + offsetAt(from, timeZone);
  const millisecondsIntoDay =
    ((timeOfDay % 86_400_000) + 86_400_000) % 86_400_000;
  const localMidnight = Date.UTC(local.year, local.month - 1, local.day);
  const approximate = new Date(
    localMidnight + millisecondsIntoDay - offsetAt(from, timeZone),
  );
  return new Date(localMidnight + millisecondsIntoDay - offsetAt(approximate, timeZone));
}

/**
 * One calendar month after `from`, in the billing zone's calendar, clamped to
 * the end of the month it lands in.
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
export function nextPeriodEnd(from: Date, timeZone: string = BILLING_TIME_ZONE): Date {
  const local = localPartsOf(from, timeZone);
  const target = local.month === 12
    ? { year: local.year + 1, month: 1 }
    : { year: local.year, month: local.month + 1 };
  const lastDayOfTargetMonth = new Date(
    Date.UTC(target.year, target.month, 0),
  ).getUTCDate();

  return instantOfLocalDate(
    { ...target, day: Math.min(local.day, lastDayOfTargetMonth) },
    from,
    timeZone,
  );
}
