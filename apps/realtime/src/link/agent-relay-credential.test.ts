import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { AgentLink } from "@/link/agent-link";
import { AgentRelay } from "@/link/agent-relay";
import { FAKE_STORAGE } from "@/link/fake-storage";
import { FakeLinkStore } from "@/link/fake-store";
import { PROTOCOL_VERSION } from "@/link/protocol";
import { AgentLinkRegistry } from "@/link/registry";
import type { ObservatoryRecord } from "@/link/store";
import { RecordingBroadcast } from "@/mission/fake-broadcast";

/**
 * ADR-020: a rotated or revoked device token ends the link it was admitted with.
 *
 * The token is checked only at the handshake. Without this, revoking a token would
 * stop the next connection and leave the current one -- the agent an operator is
 * trying to remove -- connected for as long as it keeps sending heartbeats.
 */
const observatory: ObservatoryRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "tbilisi",
  mode: "SIMULATED",
};
const other: ObservatoryRecord = {
  id: "55555555-5555-4555-8555-555555555555",
  slug: "santiago",
  mode: "SIMULATED",
};

const NOW = new Date("2026-12-15T20:00:00.000Z");

let registry: AgentLinkRegistry;
let relay: AgentRelay;
let closed: Map<string, string>;

async function connect(record: ObservatoryRecord): Promise<AgentLink> {
  const link = new AgentLink(
    record,
    new FakeLinkStore(),
    () => undefined,
    (reason) => closed.set(record.id, reason),
    new RecordingBroadcast(),
    FAKE_STORAGE,
    () => NOW.getTime(),
  );
  await link.receive(
    JSON.stringify({
      type: "AGENT_HELLO",
      messageId: randomUUID(),
      sentAt: NOW.toISOString(),
      protocolVersion: PROTOCOL_VERSION,
      observatoryId: record.id,
      agentVersion: "0.1.0",
      mode: "SIMULATED",
      posture: "SIMULATED",
      bootedAt: NOW.toISOString(),
      safetyEnvelopeConfigured: false,
      resumeMissionId: null,
    }),
  );
  registry.admit(record.id, link);
  return link;
}

const credentialChanged = (observatoryId: string) =>
  JSON.stringify({ kind: "CREDENTIAL", observatoryId });

beforeEach(() => {
  registry = new AgentLinkRegistry();
  relay = new AgentRelay(new FakeLinkStore(), registry, () => NOW);
  closed = new Map();
});

describe("a device token that changed", () => {
  it("closes the observatory's link", async () => {
    const link = await connect(observatory);

    await expect(relay.handle(credentialChanged(observatory.id))).resolves.toBe("SENT");

    expect(link.currentState).toBe("CLOSED");
    expect(closed.get(observatory.id)).toBe("device token changed");
  });

  it("leaves every other observatory's link alone", async () => {
    await connect(observatory);
    const untouched = await connect(other);

    await relay.handle(credentialChanged(observatory.id));

    expect(untouched.currentState).toBe("ONLINE");
    expect(closed.has(other.id)).toBe(false);
  });

  it("closes a link that has not finished its hello", async () => {
    // Admitted on the handshake, before any message. A revoked token must not be
    // able to hold a connection open by never saying hello.
    const link = new AgentLink(
      observatory,
      new FakeLinkStore(),
      () => undefined,
      (reason) => closed.set(observatory.id, reason),
      new RecordingBroadcast(),
      FAKE_STORAGE,
      () => NOW.getTime(),
    );
    registry.admit(observatory.id, link);

    await expect(relay.handle(credentialChanged(observatory.id))).resolves.toBe("SENT");
    expect(closed.get(observatory.id)).toBe("device token changed");
  });

  it("reports that nothing was connected", async () => {
    await expect(relay.handle(credentialChanged(observatory.id))).resolves.toBe("NO_LINK");
  });
});
