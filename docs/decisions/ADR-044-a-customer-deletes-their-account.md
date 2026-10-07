# ADR-044 — A customer deletes their account

- **Date:** 2026-10-07
- **Status:** APPROVED
- **Approved:** 2026-10-07, as written
- **Decided by:** project maintainer. The four policy answers below were given on
  2026-10-07; the implementation shape is this record's proposal.
- **Settles:** issue #173, the clients' platform request
  `docs/platform-requests/account-deletion.md`
- **Amends:** `ADR-016-http-authentication-boundary.md`, which left account deletion
  undecided

## Context

Nothing in the contract deleted, or asked to delete, a `User`. Deletion is a
personal-data obligation, and the clients' profile page (roadmap C4) needs it. The privacy
page's "Your rights over your data" section is marked pending until it exists.

The maintainer answered the request's four questions on 2026-10-07:

1. **Captures** are deleted with the account, at once. Shared and watch links stop
   working.
2. **Payment and booking records** are kept, with the name and email replaced; everything
   else is deleted. How long they are kept is the lawyer's answer (roadmap F3).
3. **The audit log** keeps the user id and nothing that names the person. It stays
   append-only.
4. **Deletion happens at once**, behind the current password. No grace period, no undo.

## Decision

`DELETE /me` with `{ currentPassword }`, following ADR-016: the exact Origin check, no
token in a response, and an `AuthEventType` audit row.

| Answer | When                                                                       |
| ------ | -------------------------------------------------------------------------- |
| 204    | Deleted. Every session ends and the cookies are cleared, as `signOut` does |
| 409    | `CONFLICT` with `details.blockers`, a list of `AccountDeletionBlocker`     |
| 422    | Wrong current password, `details.fields: ["currentPassword"]`              |
| 429    | `AUTHENTICATION_POLICY` on the account, as `/me/password` is metered       |

1. **The row is anonymised, not deleted.** `Booking`, `Payment`, `Mission`,
   `ObserverPack`, `CreditLedger`, `PrivateSession` and `ObservatoryCommand` refuse to lose
   their owner, and answer 2 keeps the first two. So the `User` row stays with
   `name` "Deleted account", `email` `deleted-{id}@deleted.invalid`, `emailVerifiedAt`
   null and a new `deletedAt`. The address is free to register again at once.
2. **Deleted in the same transaction:** the password (`Account`), every session, every
   verification, reset and change link, the captures with their assets, accesses and
   Collection entries, the Collections, the loyalty account and its entries, mission
   presence and seats, and the email outbox. A gift voucher the customer bought keeps its
   row and loses its recipient's name, address and message.
3. **Kept:** bookings, payments, missions, entitlements, observer packs, the credit
   ledger, subscriptions and vouchers, all carrying the user id and nothing that names the
   person. The audit log gains an `ACCOUNT_DELETED` row with the id and no detail;
   earlier rows already identify an actor by id or by an HMAC of the address.
4. **Stored objects go after the commit, best effort.** A row that no longer names an
   object makes it an orphan, and the orphan sweep (#141) removes any object a failed
   delete leaves behind. Deleting objects inside the transaction would leave rows
   pointing at nothing when it rolled back.
5. **A deleted owner's watch view is a 404**, the same null a stranger gets.
6. **Nothing is deleted while something is unsettled.** The blockers are read inside the
   deleting transaction, which runs SERIALIZABLE so a booking made meanwhile fails one of
   the two; a serialization failure is 409 "try again".

   | Blocker            | When                                                                                                                                                                             |
   | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `LIVE_MISSION`     | A mission is not COMPLETE, CANCELLED or FAILED. A hold (WEATHER_HOLD, NOT_VISIBLE, HARDWARE_ERROR) counts only while its booked slot lasts; a hold with no booking always counts |
   | `UPCOMING_BOOKING` | A CONFIRMED booking whose slot has not ended                                                                                                                                     |
   | `HELD_BOOKING`     | A PENDING_PAYMENT booking whose hold has not lapsed                                                                                                                              |
   | `OPEN_ENTITLEMENT` | A refund or free slot is owed and not yet taken                                                                                                                                  |
   | `OBSERVER_SEAT`    | A pending or paid Observer Pack on a mission not yet over                                                                                                                        |
   | `SUBSCRIPTION`     | A subscription TRIALING, ACTIVE or PAUSED                                                                                                                                        |
   | `GIFT_VOUCHER`     | A voucher they bought is PENDING_PAYMENT or ACTIVE                                                                                                                               |
   | `NETWORK_NODE`     | They own a network node that is not SUSPENDED                                                                                                                                    |
   | `OPERATOR`         | The account is an operator's; another operator closes it                                                                                                                         |

## Where this departs from the request

- Wrong current password: 422 with the field named, not 401, as ADR-040 and ADR-042
  decided for the other two password-gated operations.
- The request asked for the account to be deleted. The row is anonymised instead (rule
  1), because answer 2 keeps records that cannot exist without it.
- The request listed three blockers. Rule 6 adds a held booking, an observer seat, a
  subscription, an unused gift voucher, a network node and an operator account, each
  being money or an obligation that would otherwise be left without an owner.

## Consequences

- The privacy page can describe deletion once the lawyer has set the retention period
  for the kept records (F3).
- A gift voucher whose `recipientEmail` is a deleted customer's address, bought by
  somebody else, keeps it: it is the buyer's record. F3 decides whether that stands.
- The demo seed and the operator console show "Deleted account" for such an owner.
- Undoing a deletion is impossible by design. Support cannot restore captures.
