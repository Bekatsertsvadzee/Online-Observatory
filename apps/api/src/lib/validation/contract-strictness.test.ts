import { describe, expect, it } from "vitest";

import {
  zAgentToCloudMessage,
  zCreateBookingBody,
  zCommandEnvelope,
} from "@darkview/contracts/zod";

/**
 * `additionalProperties: false` in the contract means the validator rejects.
 *
 * It did not, for the whole life of the repository up to #15. The zod plugin
 * emitted a plain `z.object`, which *strips* unknown keys, so anyone reading
 * `additionalProperties: false` in `contracts/openapi.yaml` was reading a
 * guarantee that was not in force anywhere.
 *
 * It is enforced now by a resolver in `packages/contracts/openapi-ts.config.ts`.
 * That is generator configuration, and a generator upgrade could silently stop
 * honouring it -- generation would still succeed and every validator would go
 * quietly back to stripping. So the behaviour is asserted here rather than
 * assumed from the config file's continued existence.
 *
 * It lives in `apps/api` because that is where a test runner already is. What it
 * tests is the generated artifact both services share, not this app.
 */
describe("generated validators enforce what the contract declares", () => {
  it("rejects an undeclared field on an HTTP request schema", () => {
    const declared = {
      observatoryId: "00000000-0000-4000-8000-000000000010",
      targetId: "00000000-0000-4000-8000-000000000101",
      slotStartAt: "2026-12-15T18:00:00.000Z",
      durationMinutes: 30,
    };

    expect(zCreateBookingBody.safeParse(declared).success).toBe(true);
    expect(zCreateBookingBody.safeParse({ ...declared, priceMinor: 1 }).success).toBe(
      false,
    );
  });

  it("rejects an undeclared field on a message crossing the observatory link", () => {
    const hello = {
      type: "AGENT_HELLO",
      messageId: "11111111-1111-4111-8111-111111111111",
      sentAt: "2026-12-15T20:00:00.000Z",
      protocolVersion: "1",
      observatoryId: "22222222-2222-4222-8222-222222222222",
      agentVersion: "0.1.0",
      mode: "SIMULATED",
      bootedAt: "2026-12-15T19:00:00.000Z",
    };

    expect(zAgentToCloudMessage.safeParse(hello).success).toBe(true);
    expect(
      zAgentToCloudMessage.safeParse({ ...hello, elevationOverride: 90 }).success,
    ).toBe(false);
  });

  it("rejects an undeclared field on a command envelope", () => {
    const envelope = {
      commandId: "33333333-3333-4333-8333-333333333333",
      missionId: "44444444-4444-4444-8444-444444444444",
      sessionId: "55555555-5555-4555-8555-555555555555",
      userId: "66666666-6666-4666-8666-666666666666",
      issuedAt: "2026-12-15T20:00:00.000Z",
      expiresAt: "2026-12-15T20:00:30.000Z",
      type: "NUDGE",
      payload: {
        kind: "NUDGE",
        axis: "ALTITUDE",
        direction: "POSITIVE",
        stepArcminutes: 3,
      },
    };

    expect(zCommandEnvelope.safeParse(envelope).success).toBe(true);
    // A field the agent's safety check would not know to look at must not be
    // able to ride along inside a command the cloud signed off.
    expect(
      zCommandEnvelope.safeParse({ ...envelope, skipSafetyCheck: true }).success,
    ).toBe(false);
  });
});
