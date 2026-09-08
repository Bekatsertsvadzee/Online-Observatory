import type { CommandPayload, CommandType, OperatorOverrideRequest } from "@darkview/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { overrideIsExemptFromMetering } = await import("@/features/admin/override");

/**
 * The one place a rate limiter is not allowed to say no.
 *
 * An operator watching a mount misbehave reaches for Park, and by then they have
 * usually been pressing things. A meter that had been counting those presses
 * would refuse the one command that resolves the situation, which is why the
 * exemption exists at all -- and why it is worth a test of its own rather than a
 * line inside a route.
 */
const request = (type: CommandType, kind: CommandPayload["kind"]): OperatorOverrideRequest =>
  ({
    missionId: null,
    type,
    payload: { kind } as CommandPayload,
    reason: "mount is not tracking",
  }) as OperatorOverrideRequest;

describe("what an override may skip the meter for", () => {
  it("never meters a Park", () => {
    expect(overrideIsExemptFromMetering(request("PARK", "PARK"))).toBe(true);
  });

  it("never meters an Abort", () => {
    expect(overrideIsExemptFromMetering(request("ABORT", "ABORT"))).toBe(true);
  });

  it("meters a slew", () => {
    expect(overrideIsExemptFromMetering(request("GOTO", "GOTO"))).toBe(false);
  });

  it("meters a capture", () => {
    expect(overrideIsExemptFromMetering(request("CAPTURE", "CAPTURE"))).toBe(false);
  });

  it("meters a request whose payload claims Park but whose type does not", () => {
    // The two halves disagreeing does not make this a Park. It makes it a
    // malformed request that `issueOperatorOverride` refuses with 422 -- and an
    // unmetered path offering unlimited attempts at a refusal is exactly what
    // the meter is for. The safety pre-check reads the payload because the
    // payload says where the telescope ends up; this reads both, because it is
    // deciding whether to skip a check and must fail the other way.
    expect(overrideIsExemptFromMetering(request("GOTO", "PARK"))).toBe(false);
  });

  it("meters a request whose type claims Park but whose payload does not", () => {
    // The mirror image, and the shape of the bug DV-063 found by injection: a
    // Park's name carrying a slew's payload. Exempting it would hand an attacker
    // an unmetered path by typing one word.
    expect(overrideIsExemptFromMetering(request("PARK", "GOTO"))).toBe(false);
  });
});

const { weatherHoldIsExemptFromMetering } = await import("@/features/admin/observatory");

describe("what a weather-hold change may skip the meter for", () => {
  it("never meters declaring the weather unsafe", () => {
    // Phase 1 has no sky sensor, so an operator looking out of a window is the
    // only thing that can stop a mission for weather. A meter able to delay that
    // is a meter standing between a telescope and the rain.
    expect(weatherHoldIsExemptFromMetering({ holdActive: true, status: "UNSAFE" })).toBe(
      true,
    );
  });

  it("meters clearing a hold", () => {
    // The direction that puts a telescope back under the sky waits its turn.
    expect(weatherHoldIsExemptFromMetering({ holdActive: false, status: "CLEAR" })).toBe(
      false,
    );
  });
});
