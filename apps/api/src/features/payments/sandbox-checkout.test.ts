import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ getDatabase: () => ({}) }));
vi.mock("@/lib/validation/env", () => ({
  getServerEnvironment: () => ({ APP_URL: "https://darkview.test/ignored/path" }),
}));

import { bookingReturnUrl, sandboxCheckoutUrl } from "@/features/payments/sandbox-checkout";

const PAYMENT_ID = "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e02";
const BOOKING_ID = "3f1f5b8e-1a2b-4c3d-8e4f-5a6b7c8d9e01";

describe("the sandbox checkout's URLs (#149)", () => {
  it("sends the customer to the API on the web client's origin (ADR-016 §4)", () => {
    expect(sandboxCheckoutUrl(PAYMENT_ID)).toBe(
      `https://darkview.test/api/payments/${PAYMENT_ID}/sandbox-checkout`,
    );
  });

  it("returns them to the booking's page in their language", () => {
    expect(bookingReturnUrl("en", BOOKING_ID)).toBe(
      `https://darkview.test/en/app/bookings/${BOOKING_ID}`,
    );
    expect(bookingReturnUrl("ka", BOOKING_ID)).toBe(
      `https://darkview.test/ka/app/bookings/${BOOKING_ID}`,
    );
  });

  it("cannot be steered off APP_URL's origin", () => {
    for (const locale of ["//evil.example", "https://evil.example", "\\\\evil.example", "@evil.example"]) {
      expect(new URL(bookingReturnUrl(locale, BOOKING_ID)).origin).toBe("https://darkview.test");
      expect(bookingReturnUrl(locale, BOOKING_ID)).toBe(
        `https://darkview.test/en/app/bookings/${BOOKING_ID}`,
      );
    }
  });
});
