import "server-only";

import { createHmac } from "node:crypto";
import { headers } from "next/headers";

import type { AuditCategory } from "@darkview/db/enums";
import { recordAuditEvent } from "@darkview/db/audit";
import { consumeRateLimit, type RateLimitPolicy } from "@darkview/db/rate-limit";

import { getDatabase } from "@/lib/db/client";
import { apiError } from "@/lib/http/api-error";
import { getServerEnvironment } from "@/lib/validation/env";

/**
 * What this API meters, and how hard.
 *
 * The decision itself lives in `@darkview/db/rate-limit`, because the realtime
 * service meters its own surface with the same statement. What lives here is
 * everything that is about *this* service: who the caller is, which policy
 * applies, and what a refusal looks like on the wire.
 *
 * None of these numbers are safety values. Nothing in this file can move a
 * mount, and nothing here is a substitute for the checks that can: an override
 * carrying a Park is exempt from metering entirely, on the grounds that a
 * limiter able to delay an emergency stop would be a regression dressed as
 * hardening.
 */

/**
 * Failed sign-in and registration attempts.
 *
 * Unchanged from the values this limiter shipped with, deliberately: five
 * attempts in fifteen minutes is a password-guessing budget, and widening it
 * because the file moved would be a security change disguised as a refactor.
 */
export const AUTHENTICATION_POLICY: RateLimitPolicy = {
  limit: 5,
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
};

/**
 * Reservations, per account.
 *
 * A booking takes a half hour of the only telescope out of everyone else's
 * reach until it is paid for or expires, which makes this the one customer
 * action that can deny the whole night's inventory. Ten in an hour is far more
 * than a person books and far fewer than a script needs.
 */
export const BOOKING_POLICY: RateLimitPolicy = {
  limit: 10,
  windowMs: 60 * 60 * 1000,
  blockMs: 60 * 60 * 1000,
};

/**
 * Mission commands, per account.
 *
 * The block is one minute rather than the window-length blocks above, and that
 * asymmetry is the point: the account being metered here is usually a paying
 * customer in the middle of their observation, and locking them out of their own
 * telescope for fifteen minutes would do more damage than the flood would. Two
 * commands a second sustained for a minute is already well past what a person
 * pressing a nudge control produces.
 */
export const COMMAND_POLICY: RateLimitPolicy = {
  limit: 120,
  windowMs: 60 * 1000,
  blockMs: 60 * 1000,
};

/**
 * Observer seat churn, per account.
 *
 * ADR-007 caps a mission at five seats. Taking and releasing in a loop is how
 * you would hold that cap against other people without ever exceeding it, so the
 * churn is metered even though the capacity already is.
 */
export const OBSERVER_SEAT_POLICY: RateLimitPolicy = {
  limit: 20,
  windowMs: 10 * 60 * 1000,
  blockMs: 10 * 60 * 1000,
};

/**
 * Accounts created from one address.
 *
 * `AUTHENTICATION_POLICY` meters registration by address *and* email, so a fresh
 * email address is a fresh bucket: it caps attempts at one account, not the
 * number of accounts one client may create. This caps that.
 *
 * It applies only where the address is trustworthy. Keyed on `UNATTRIBUTED` it
 * would be a single bucket shared by every customer in the world, and the
 * eleventh person to register anywhere would be told to come back in an hour.
 * So an unconfigured `TRUSTED_PROXY_HOPS` leaves this check off rather than
 * turning it into an outage, and the runbook says to set it.
 */
export const REGISTRATION_ORIGIN_POLICY: RateLimitPolicy = {
  limit: 10,
  windowMs: 60 * 60 * 1000,
  blockMs: 60 * 60 * 1000,
};

/**
 * Opening a mission session and changing who may watch it, per account.
 *
 * Neither is expensive on its own; both are session-state churn on a live
 * observation, and twenty in ten minutes is far past anything a person does with
 * one telescope.
 */
export const MISSION_SESSION_POLICY: RateLimitPolicy = {
  limit: 20,
  windowMs: 10 * 60 * 1000,
  blockMs: 10 * 60 * 1000,
};

/**
 * Operator writes other than an override, per account.
 *
 * Deliberately loose. Operators are trusted and this is not trying to pace their
 * work -- it is a ceiling on what one stolen operator session can do before
 * somebody notices, and every refusal under it leaves an audit row saying so.
 *
 * The exemptions are the same shape everywhere in this file: anything that stops
 * the telescope is never metered, anything that starts or widens it is. So
 * declaring a weather hold and cancelling a stuck mission go through unmetered,
 * while clearing a hold, changing mode and retuning the catalogue do not.
 */
export const ADMIN_MUTATION_POLICY: RateLimitPolicy = {
  limit: 60,
  windowMs: 5 * 60 * 1000,
  blockMs: 5 * 60 * 1000,
};

/**
 * Operator overrides that are not recovery commands.
 *
 * Operators are trusted; a stolen operator session is not. This meters the blast
 * radius of one without touching the emergency stop -- see
 * `overrideIsExemptFromMetering`.
 */
export const OPERATOR_OVERRIDE_POLICY: RateLimitPolicy = {
  limit: 30,
  windowMs: 5 * 60 * 1000,
  blockMs: 5 * 60 * 1000,
};

/**
 * The actor of a request that arrived without a trustworthy address.
 *
 * Exported because callers have to be able to ask. A per-address limit keyed on
 * this value is not a per-address limit -- it is one bucket shared by the whole
 * internet, and imposing one would lock every customer out the first time
 * anybody exceeded it.
 */
export const UNATTRIBUTED = "unattributed";

/**
 * Who is asking, for rate-limiting purposes.
 *
 * `X-Forwarded-For` is a list the client starts and each proxy appends to, so the
 * leftmost entry is whatever the caller typed. Reading from that end lets anyone
 * mint a fresh rate-limit bucket per request by varying one header, which is the
 * same as having no limit at all.
 *
 * So the header is read from the right, and only as far as `TRUSTED_PROXY_HOPS`
 * says we actually have proxies. The default is zero: an unconfigured deployment
 * trusts nothing and falls back to a constant, which limits by account rather
 * than by address. That is deliberately the cautious direction -- it throttles a
 * real attack, at the cost of being able to throttle one abusive client
 * separately from everyone else. Set the variable once the proxy in front of this
 * is known.
 */
export async function requestActor() {
  const requestHeaders = await headers();
  const { TRUSTED_PROXY_HOPS } = getServerEnvironment();

  if (TRUSTED_PROXY_HOPS > 0) {
    const chain =
      requestHeaders
        .get("x-forwarded-for")
        ?.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean) ?? [];

    // The last hop is our own proxy; the one it saw is TRUSTED_PROXY_HOPS from
    // the end. A chain too short to contain it means the request did not arrive
    // the way we were told it would, so nothing in it is trusted.
    const client = chain[chain.length - TRUSTED_PROXY_HOPS];
    if (client) return client.slice(0, 128);
  }

  return UNATTRIBUTED;
}

/**
 * The bucket key.
 *
 * HMAC rather than plain text: the identity is often an email address or an
 * account id, and `RateLimitBucket` is an operational table that is dumped,
 * backed up and read during incidents. The scope stays in the clear so a key is
 * still legible enough to reason about.
 */
function rateLimitKey(scope: string, identity: string) {
  return `${scope}:${createHmac("sha256", getServerEnvironment().AUTH_SECRET)
    .update(identity)
    .digest("base64url")}`;
}

/**
 * Count one attempt and say whether it may proceed.
 *
 * The base client, never a transaction: a limiter enrolled in a transaction
 * forgets every attempt that rolls back, and an attempt that fails is exactly
 * the attempt worth remembering.
 */
export async function consumeLimit(
  policy: RateLimitPolicy,
  scope: string,
  identity: string,
  now = new Date(),
): Promise<boolean> {
  return consumeRateLimit(
    { key: rateLimitKey(scope, identity), policy, now },
    getDatabase(),
  );
}

/**
 * Count one registration against the address it came from.
 *
 * Returns true when the attempt may proceed, and always true for an
 * unattributed one -- see `REGISTRATION_ORIGIN_POLICY`. The check lives here
 * rather than as a condition at the call site so that the reason it is skipped
 * is testable: keyed on `UNATTRIBUTED` this would be one bucket shared by every
 * customer in the world, and the eleventh person to register anywhere would be
 * locked out for an hour.
 */
export async function consumeRegistrationOriginLimit(actor: string, now = new Date()) {
  if (actor === UNATTRIBUTED) return true;
  return consumeLimit(REGISTRATION_ORIGIN_POLICY, "register-origin", actor, now);
}

/**
 * The refusal, in the contract's own words.
 *
 * `RATE_LIMITED` is already an `ErrorCode`, so this needed no contract change.
 * The message says nothing about how much budget is left or when it returns: a
 * limiter that reports its own state is a limiter that can be measured, and an
 * attacker who can measure one can schedule around it.
 */
export function rateLimited() {
  return apiError(429, "RATE_LIMITED", "Too many requests. Try again later.");
}

/**
 * Meter one attempt at a route, and refuse it if the budget is spent.
 *
 * Returns the response to send, or `null` to carry on -- so a route reads:
 *
 *   const limited = await meterRequest({ ... });
 *   if (limited) return limited;
 *
 * The audit row is written here rather than at the call sites because a refusal
 * that leaves nothing behind is invisible: a customer locked out of their own
 * observation and a script being turned away look identical in the logs, and an
 * operator asked about either has nothing to read. `docs/backlog.md` recorded
 * exactly this gap when DV-063 deferred it.
 *
 * It is written outside a transaction and says so: the refusal changes nothing
 * else, so there is no other write for the row to share a fate with. The bucket
 * update it describes has already committed on its own statement.
 */
export async function meterRequest({
  policy,
  scope,
  identity,
  category,
  actorUserId = null,
  missionId = null,
  now = new Date(),
}: {
  policy: RateLimitPolicy;
  scope: string;
  identity: string;
  category: AuditCategory;
  actorUserId?: string | null;
  missionId?: string | null;
  now?: Date;
}) {
  if (await consumeLimit(policy, scope, identity, now)) return null;

  await recordAuditEvent(
    { category, action: "RATE_LIMITED", actorUserId, missionId, detail: { scope } },
    getDatabase(),
  );

  return rateLimited();
}
