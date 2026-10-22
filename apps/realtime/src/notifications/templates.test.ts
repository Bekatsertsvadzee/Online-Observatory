import { describe, expect, it } from "vitest";

import { renderEmail } from "@/notifications/templates";

const APP_URL = "https://stellar.example.test";
const target = { nameEn: "M13", nameKa: "M13 ბურთისებრი გროვა" };
const observatory = { nameEn: "Tbilisi Observatory", nameKa: "თბილისის ობსერვატორია", timezone: "Asia/Tbilisi" };
const booking = {
  bookingId: "11111111-1111-4111-8111-111111111111",
  slotStartAt: "2026-12-15T18:00:00.000Z",
  durationMinutes: 30,
  target,
  observatory,
};

/** One `data` per kind, as the dispatcher builds it. */
const DATA: Record<string, Record<string, unknown>> = {
  BOOKING_CONFIRMED: booking,
  SLOT_REMINDER: booking,
  WEATHER_HOLD: booking,
  ENTITLEMENT_AVAILABLE: {
    ...booking,
    entitlement: { cause: "WEATHER", minutesLost: 20, expiresAt: "2027-01-15T18:00:00.000Z" },
  },
  BOOKING_REFUNDED: { ...booking, refund: { priceMinor: 4500, currency: "GEL" } },
  SUBSCRIPTION_MINUTES_RETURNED: { ...booking, minutesReturned: 30 },
  CAPTURE_READY: {
    captureId: "22222222-2222-4222-8222-222222222222",
    capturedAt: "2026-12-15T18:20:00.000Z",
    simulated: true,
    target,
  },
  OBSERVER_PACK_REFUNDED: {
    observerPackId: "33333333-3333-4333-8333-333333333333",
    missionId: "44444444-4444-4444-8444-444444444444",
    target,
    observatory,
    refund: { refundedMinor: 1000, priceMinor: 1000, currency: "GEL" },
  },
  GIFT_VOUCHER_ISSUED: {
    voucherId: "55555555-5555-4555-8555-555555555555",
    durationMinutes: 30,
    expiresAt: "2027-12-15T18:00:00.000Z",
    code: "STEL-ABCD-EFGH",
    message: "Happy birthday <3",
    recipientName: "Nino",
    buyerName: "Gio",
  },
  GIFT_VOUCHER_RESTORED: {
    voucherId: "55555555-5555-4555-8555-555555555555",
    durationMinutes: 30,
    expiresAt: null,
    codeLast4: "EFGH",
  },
  CARD_PRIZE_WON: {
    cardPrizeId: "66666666-6666-4666-8666-666666666666",
    kind: "DISCOUNT",
    durationMinutes: null,
    percentOff: 20,
    expiresAt: "2026-11-21T10:00:00.000Z",
    observatory,
  },
};

describe("every outbox email (ADR-062)", () => {
  for (const [kind, data] of Object.entries(DATA)) {
    for (const locale of ["en", "ka"] as const) {
      it(`${kind} in ${locale} has a subject, a body and a link to the site`, () => {
        const email = renderEmail({ kind, locale, data, appUrl: APP_URL });
        expect(email.subject).toMatch(locale === "ka" ? /სტელარი$/ : /Stellar$/);
        expect(email.text).toContain(`${APP_URL}/${locale}/`);
        expect(email.html).toContain(`href="${APP_URL}/${locale}/`);
        expect(email.text).not.toMatch(/undefined|null|NaN|\[object/);
      });
    }
  }

  it("names the session in the observatory's time and language", () => {
    const en = renderEmail({ kind: "BOOKING_CONFIRMED", locale: "en", data: booking, appUrl: APP_URL });
    expect(en.text).toContain("M13, 30 minutes from 15 December 2026 at 22:00");
    const ka = renderEmail({ kind: "BOOKING_CONFIRMED", locale: "ka", data: booking, appUrl: APP_URL });
    expect(ka.text).toContain("M13 ბურთისებრი გროვა");
    expect(ka.text).toContain("22:00");
    expect(ka.text).toContain(`${APP_URL}/ka/app/bookings/${booking.bookingId}`);
  });

  it("says a simulated capture is simulated", () => {
    const email = renderEmail({ kind: "CAPTURE_READY", locale: "en", data: DATA.CAPTURE_READY, appUrl: APP_URL });
    expect(email.text).toContain("marked Simulated");
  });

  it("writes the gift code and escapes what a person typed", () => {
    const email = renderEmail({
      kind: "GIFT_VOUCHER_ISSUED",
      locale: "en",
      data: DATA.GIFT_VOUCHER_ISSUED,
      appUrl: APP_URL,
    });
    expect(email.text).toContain("STEL-ABCD-EFGH");
    expect(email.html).toContain("Happy birthday &lt;3");
    expect(email.html).not.toContain("<3");
  });

  it("names a card's prize, and leaves its code on the cards page", () => {
    const email = renderEmail({ kind: "CARD_PRIZE_WON", locale: "en", data: DATA.CARD_PRIZE_WON, appUrl: APP_URL });
    expect(email.subject).toContain("20% off one booking");
    expect(email.text).toContain("21 November 2026");
    expect(email.text).toContain(`${APP_URL}/en/app/cards`);
  });

  it("refuses a kind it has no words for", () => {
    expect(() => renderEmail({ kind: "SOMETHING_NEW", locale: "en", data: {}, appUrl: APP_URL })).toThrow();
  });
});
