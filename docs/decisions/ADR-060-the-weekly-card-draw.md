# ADR-060 — The weekly card draw

- **Date:** 2026-10-22
- **Status:** PROPOSED — built on the maintainer's approval of 2026-10-22 of the clients'
  ADR-058 ("A weekly card draw, in Skychaser's cards"), which asked for it in
  `docs/platform-requests/weekly-card-draw.md` there.
- **Decided by:** project maintainer
- **Number:** 060, not this repository's next free 051, because the two repositories share
  one sequence of records and the clients' half already runs to ADR-059.
- **Relates to:** ADR-007 and ADR-036 (observer seats), DV-111 (refunds and entitlements),
  DV-112 (gift vouchers), ADR-016 §3 (mutations), ADR-050 (the week), ADR-044 (deletion).

## Context

The clients' ADR-058 gives a verified account three face-down cards a week. It turns one,
and the other two then turn. A card's rarity names a prize: LEGENDARY a free Observation
Slot of the shortest length sold, EPIC a free observer seat, RARE a discount on one
booking, COMMON nothing. The odds and a weekly cap of two free slots are the maintainer's,
held on the platform. Prizes are vouchers bound to the winner, spent through the paths
that already spend vouchers, never cash, and expire thirty days after they are won.

The outcome has to be decided here: a page that decides a prize is a prize anyone can take.

## Decision

1. **The cards are decided when they are dealt.** The first `GET /card-draws/current` of
   the week deals three cards and writes what each holds (`CardDraw`, `CardDrawCard`).
   Every later read answers the same deal; the pick only turns a card already written.
   An unturned card says nothing but its position. Dealing on a GET follows `GET /loyalty`,
   which creates the caller's own row on first sight: it issues and takes nothing, so a
   cross-site request can at most deal the cards the account would be dealt anyway.
2. **One deal per account, per observatory, per week**, the week being ADR-050's: Monday
   to Sunday in the observatory's local calendar. A deal can be picked until the next
   Monday 00:00 there (`opensNextAt`); after it, `CARD_DRAW_CLOSED`.
3. **First-party observatories only.** A partner's telescope time is not Stellar's to
   give away, so a partner observatory deals no cards (404). A prize is spent only at the
   observatory of its deal.
4. **The odds are data.** `CardDrawScheme`, one row, changed by an UPDATE: chances in
   basis points per card (free slot 100, seat 1000, discount 2500, nothing the rest), two
   free slots a week, 20% off, thirty days. `GET /card-draws/odds` publishes them without
   an account, for the page and the Terms.
5. **The weekly cap holds while deals race.** A dealt free-slot card takes one of the
   week's slots by a conditional increment on `CardDrawWeek`; when none is left it holds a
   discount instead (ADR-058 §4). The pick gives back every free slot it left on a card
   nobody chose, so at most two are won and an unchosen one is not wasted.
6. **The pick is once, and atomic.** `POST /card-draws/{drawId}/pick` locks the deal, turns
   the card, issues its prize and writes the audit row in one transaction. A second pick is
   `CARD_ALREADY_PICKED`; a retry carrying the first pick's `Idempotency-Key` gets the
   first pick's answer. It names the deal rather than "the current week", so a pick sent a
   moment before Monday never deals and turns next week's in one go.
7. **A prize is a voucher only its winner can spend** (`CardPrize`). Its code is an HMAC
   of its id under `VOUCHER_CODE_SECRET` with its own prefix, never stored, shown to its
   winner while it is ACTIVE. Any other account sending it gets the answer an unknown code
   gets.
   - **FREE_SLOT** on `POST /bookings` `voucherCode`: the booking is confirmed at no
     charge, exactly as DV-112 does it.
   - **DISCOUNT** on `POST /bookings` `voucherCode`: its percentage comes off after the
     tier discount, and the booking is held and paid as any cash booking. It is still the
     booking's one price reduction.
   - **OBSERVER_SEAT** on `POST /missions/{id}/observer-pack`, whose new optional body
     carries `voucherCode`: the pack is PAID at no price with no payment, inside the
     purchase's mission lock, so the ten-seat cap holds. `ObserverPack_paid_has_payment`
     now allows a paid pack with no payment only at price zero.
8. **A prize comes back when what it paid for does not happen.** A lapsed hold, a failed
   payment and a cancelled hold give a discount prize back unchanged. A refunded booking
   restores a free-slot or discount prize as DV-111 restores a gift voucher, with at least
   thirty days left; a discount's money is refunded beside it. A seat a prize paid for has
   no price, so an ADR-036 close refunds nothing for it, and the prize stays spent.
9. **Audited.** A new category, `CARD_DRAW`: `CARD_DRAW_DEALT` (with each card's rarity),
   `CARD_DRAW_PICKED`, `CARD_PRIZE_REDEEMED`, `CARD_PRIZE_RESTORED`. Never a code.
10. **Unverified accounts** cannot hold a session, so they reach none of this (401), and
   no route needs its own `EMAIL_UNVERIFIED` check.

## Consequences

- Contract: `GET /card-draws/odds`, `GET /card-draws/current`, `POST /card-draws/{drawId}/pick`,
  `GET /prizes`; schemas `CardDraw`, `CardDrawCard`, `CardDrawOdds`, `CardDrawOddsEntry`,
  `CardPrize`, `CardPrizeList`, `CardRarity`, `CardPrizeKind`, `CardPrizeStatus`,
  `PickCardRequest`, `PurchaseObserverPackRequest`; error codes `CARD_ALREADY_PICKED` and
  `CARD_DRAW_CLOSED`; audit category `CARD_DRAW`; `ObserverPackWithPaymentIntent.paymentIntent`
  is nullable; the `cards` tag.
- Database: tables `CardDrawScheme`, `CardDraw`, `CardDrawCard`, `CardDrawWeek`,
  `CardPrize`; migration `20261022120000_adr060_weekly_card_draw`, which also inserts the
  approved odds.
- The pick is not rate-limited: it is once per deal under a row lock, and a flood wins
  nothing a first pick did not. A prize code on the observer-pack route is metered as a
  voucher redemption, as on `POST /bookings`.
- No email is sent for a prize won or restored; the page shows them.
- **For the maintainer before production:** the Georgian rules on prize promotions
  (ADR-058); whether partner observatories should ever deal cards; whether a seat prize
  should come back when the owner closes the session.
