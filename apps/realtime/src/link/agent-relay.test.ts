import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { CloudToAgentMessage, CommandEnvelope } from "@darkview/contracts";

import { AgentLink } from "@/link/agent-link";
import { AgentRelay } from "@/link/agent-relay";
import { FakeLinkStore } from "@/link/fake-store";
import { AgentLinkRegistry } from "@/link/registry";
import { PROTOCOL_VERSION } from "@/link/protocol";
import type { ObservatoryRecord, RelayableCommand } from "@/link/store";

/**
 * ADR-009's cloud half: a notification becomes a message on the agent socket.
 *
 * The relay decides nothing. `docs/architecture.md` §2 -- "The orchestrator
 * decides; realtime transports." So what is worth proving here is that it
 * transports faithfully, and that it never marks a command sent that did not go.
 */
const observatory: ObservatoryRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "tbilisi",
  mode: "SIMULATED",
};

const MISSION_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";

const NOW = new Date("2026-12-15T20:00:00.000Z");
const EXPIRES_AT = new Date("2026-12-15T20:30:00.000Z");

function liveSession() {
  return {
    sessionId: SESSION_ID,
    missionId: MISSION_ID,
    userId: USER_ID,
    expiresAt: EXPIRES_AT,
  };
}

function sessionNotification(sessionId: string | null): string {
  return JSON.stringify({
    kind: "SESSION",
    observatoryId: observatory.id,
    missionId: MISSION_ID,
    sessionId,
  });
}

let store: FakeLinkStore;
let registry: AgentLinkRegistry;
let relay: AgentRelay;
let sent: CloudToAgentMessage[];

function envelopeFor(commandId = randomUUID()): CommandEnvelope {
  return {
    commandId,
    missionId: MISSION_ID,
    sessionId: SESSION_ID,
    userId: USER_ID,
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
    type: "NUDGE",
    payload: {
      kind: "NUDGE",
      axis: "ALTITUDE",
      direction: "POSITIVE",
      stepArcminutes: 3,
    },
  };
}

function storedCommand(envelope: CommandEnvelope): RelayableCommand {
  return { observatoryId: observatory.id, envelope };
}

/** A link that has said hello, so it is somewhere a command can be sent. */
async function connectAgent(): Promise<AgentLink> {
  const link = new AgentLink(
    observatory,
    store,
    (message) => sent.push(message),
    () => undefined,
    () => NOW.getTime(),
  );

  await link.receive(
    JSON.stringify({
      type: "AGENT_HELLO",
      messageId: randomUUID(),
      sentAt: NOW.toISOString(),
      protocolVersion: PROTOCOL_VERSION,
      observatoryId: observatory.id,
      agentVersion: "0.1.0",
      mode: "SIMULATED",
      bootedAt: NOW.toISOString(),
      safetyEnvelopeConfigured: false,
      resumeMissionId: null,
    }),
  );

  registry.admit(observatory.id, link);
  sent.length = 0;
  return link;
}

beforeEach(() => {
  store = new FakeLinkStore();
  registry = new AgentLinkRegistry();
  relay = new AgentRelay(store, registry, () => NOW);
  sent = [];
});

describe("relaying a command", () => {
  it("sends the envelope the orchestrator minted, unaltered", async () => {
    await connectAgent();
    const envelope = envelopeFor();
    store.addCommand(storedCommand(envelope));

    const outcome = await relay.relayCommand(envelope.commandId);

    expect(outcome).toBe("SENT");
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("CLOUD_COMMAND");

    // Byte-for-byte the envelope from the row. Anything rewritten in transit
    // would not be the command the audit row says was sent.
    expect((sent[0] as { command: CommandEnvelope }).command).toEqual(envelope);
  });

  it("marks the command relayed once it is on the wire", async () => {
    await connectAgent();
    const envelope = envelopeFor();
    store.addCommand(storedCommand(envelope));

    await relay.relayCommand(envelope.commandId);

    expect(store.relayed.get(envelope.commandId)).toEqual(NOW);
  });

  it("does not mark a command relayed when no agent is connected", async () => {
    const envelope = envelopeFor();
    store.addCommand(storedCommand(envelope));

    const outcome = await relay.relayCommand(envelope.commandId);

    expect(outcome).toBe("NO_LINK");
    // The sweep exists to find this row later. Marking it sent would hide it.
    expect(store.relayed.has(envelope.commandId)).toBe(false);
  });

  it("does not send to an agent that has not finished its hello", async () => {
    const link = new AgentLink(
      observatory,
      store,
      (message) => sent.push(message),
      () => undefined,
      () => NOW.getTime(),
    );
    registry.admit(observatory.id, link);

    const envelope = envelopeFor();
    store.addCommand(storedCommand(envelope));

    const outcome = await relay.relayCommand(envelope.commandId);

    expect(outcome).toBe("NO_LINK");
    expect(sent).toHaveLength(0);
    expect(store.relayed.has(envelope.commandId)).toBe(false);
  });

  it("reports an unknown commandId rather than inventing one", async () => {
    await connectAgent();
    expect(await relay.relayCommand(randomUUID())).toBe("NOT_FOUND");
    expect(sent).toHaveLength(0);
  });
});

describe("handling a raw notification", () => {
  it("relays a COMMAND notification", async () => {
    await connectAgent();
    const envelope = envelopeFor();
    store.addCommand(storedCommand(envelope));

    const outcome = await relay.handle(
      JSON.stringify({
        kind: "COMMAND",
        commandId: envelope.commandId,
        observatoryId: observatory.id,
      }),
    );

    expect(outcome).toBe("SENT");
    expect(sent).toHaveLength(1);
  });

  it("tells the agent who owns the mission, and which user", async () => {
    await connectAgent();
    store.setActiveSession(observatory.id, liveSession());

    const outcome = await relay.handle(sessionNotification(SESSION_ID));

    expect(outcome).toBe("SENT");
    // userId is the part that matters. The agent refuses any command whose
    // userId does not match the session owner, so an update without one leaves
    // it holding no owner and refusing everything.
    expect(sent[0]).toMatchObject({
      type: "CLOUD_SESSION_UPDATE",
      missionId: MISSION_ID,
      sessionId: SESSION_ID,
      userId: USER_ID,
      expiresAt: EXPIRES_AT.toISOString(),
    });
  });

  it("revokes a session with a null sessionId", async () => {
    await connectAgent();

    await relay.handle(sessionNotification(null));

    // Null is the revoke. The agent then accepts no client command for the
    // mission at all, which is what stops a stale browser tab.
    expect(sent[0]).toMatchObject({
      type: "CLOUD_SESSION_UPDATE",
      sessionId: null,
      userId: null,
    });
  });

  it("revokes when the session was revoked between the notify and the read", async () => {
    await connectAgent();
    store.setActiveSession(observatory.id, liveSession());
    store.revokeSession(SESSION_ID);

    await relay.handle(sessionNotification(SESSION_ID));

    // The notification said "grant". The row says the session is gone, and the
    // row is what the agent is told -- ADR-009's rule, applied to the case where
    // trusting the payload would hand a revoked customer the telescope.
    expect(sent[0]).toMatchObject({ type: "CLOUD_SESSION_UPDATE", sessionId: null });
  });

  it("refuses to hand one mission a session that belongs to another", async () => {
    await connectAgent();
    store.setActiveSession(observatory.id, liveSession());

    await relay.handle(
      JSON.stringify({
        kind: "SESSION",
        observatoryId: observatory.id,
        missionId: "55555555-5555-4555-8555-555555555555",
        sessionId: SESSION_ID,
      }),
    );

    expect(sent[0]).toMatchObject({ sessionId: null });
  });

  it("survives a payload that is not the shape it expects", async () => {
    await connectAgent();

    expect(await relay.handle("not json")).toBe("MALFORMED");
    expect(await relay.handle(JSON.stringify({ kind: "SOMETHING_ELSE" }))).toBe(
      "MALFORMED",
    );
    expect(sent).toHaveLength(0);
  });

  it("acts on the database, never on the notification's contents", async () => {
    await connectAgent();
    const envelope = envelopeFor();
    store.addCommand(storedCommand(envelope));

    // A notification claiming a different observatory changes nothing: the row
    // says which observatory it belongs to, and the row is what is read.
    await relay.handle(
      JSON.stringify({
        kind: "COMMAND",
        commandId: envelope.commandId,
        observatoryId: "99999999-9999-4999-8999-999999999999",
      }),
    );

    expect((sent[0] as { command: CommandEnvelope }).command).toEqual(envelope);
  });
});

describe("sweeping what the notification missed", () => {
  it("sends every unrelayed command for the observatory", async () => {
    await connectAgent();
    const first = envelopeFor();
    const second = envelopeFor();
    store.addCommand(storedCommand(first));
    store.addCommand(storedCommand(second));

    const sentCount = await relay.sweep(observatory.id);

    expect(sentCount).toBe(2);
    expect(sent).toHaveLength(2);
  });

  it("skips one that has already gone", async () => {
    await connectAgent();
    const envelope = envelopeFor();
    store.addCommand(storedCommand(envelope));

    await relay.relayCommand(envelope.commandId);
    sent.length = 0;

    expect(await relay.sweep(observatory.id)).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("skips an expired command rather than relaying a refusal", async () => {
    await connectAgent();
    const expired = envelopeFor();
    expired.expiresAt = new Date(NOW.getTime() - 1_000).toISOString();
    store.addCommand(storedCommand(expired));

    // The agent would refuse it as COMMAND_EXPIRED. Sending it would produce an
    // ack that reads like a fault when it is only the sweep being late.
    expect(await relay.sweep(observatory.id)).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("leaves everything pending when the agent is not there", async () => {
    const envelope = envelopeFor();
    store.addCommand(storedCommand(envelope));

    expect(await relay.sweep(observatory.id)).toBe(0);
    expect(store.relayed.has(envelope.commandId)).toBe(false);
  });

  it("re-asserts who owns the mission before sending it any command", async () => {
    await connectAgent();
    store.setActiveSession(observatory.id, liveSession());
    store.addCommand(storedCommand(envelopeFor()));

    await relay.sweep(observatory.id);

    // Ownership lives in the agent's memory, so an agent that restarted has
    // forgotten it and would refuse the command below with NO_ACTIVE_MISSION.
    // The order is the point: told who owns it, then given the command.
    expect(sent.map((message) => message.type)).toEqual([
      "CLOUD_SESSION_UPDATE",
      "CLOUD_COMMAND",
    ]);
    expect(sent[0]).toMatchObject({ sessionId: SESSION_ID, userId: USER_ID });
  });

  it("says nothing about ownership when no session is live", async () => {
    await connectAgent();

    await relay.sweep(observatory.id);

    // Not a revocation. The agent came back holding no owner, and there is
    // nothing to revoke.
    expect(sent).toHaveLength(0);
  });

  it("does not re-assert a session that has already lapsed", async () => {
    await connectAgent();
    store.setActiveSession(observatory.id, {
      ...liveSession(),
      expiresAt: new Date(NOW.getTime() - 1_000),
    });

    await relay.sweep(observatory.id);

    expect(sent).toHaveLength(0);
  });
});
