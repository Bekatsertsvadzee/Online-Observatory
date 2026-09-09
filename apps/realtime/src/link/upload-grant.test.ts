import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { CloudToAgentMessage, CommandEnvelope } from "@darkview/contracts";

import { AgentLink } from "@/link/agent-link";
import { FAKE_STORAGE } from "@/link/fake-storage";
import { FakeLinkStore } from "@/link/fake-store";
import { PROTOCOL_VERSION } from "@/link/protocol";
import type { ObservatoryRecord } from "@/link/store";
import { RecordingBroadcast } from "@/mission/fake-broadcast";

/**
 * ADR-012, the upload half: the agent asks for somewhere to put a capture and
 * the cloud answers with permission to write exactly one object.
 *
 * The property under test is *authority*, not signing. What must be true is that
 * the key is the cloud's, that a grant is only ever issued for a command this
 * observatory actually holds, and that a refusal is a refusal rather than a
 * message shaped like permission.
 */
const observatory: ObservatoryRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "tbilisi",
  mode: "SIMULATED",
};

const MISSION = "22222222-2222-4222-8222-222222222222";
const OTHER_MISSION = "55555555-5555-4555-8555-555555555555";
const OTHER_OBSERVATORY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "33333333-3333-4333-8333-333333333333";
const SESSION = "77777777-7777-4777-8777-777777777777";

let store: FakeLinkStore;
let broadcast: RecordingBroadcast;
let sent: CloudToAgentMessage[];
let now: number;
let commandId: string;

function captureEnvelope(missionId = MISSION): CommandEnvelope {
  return {
    commandId,
    missionId,
    sessionId: SESSION,
    userId: OWNER,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
    type: "CAPTURE",
    payload: { kind: "CAPTURE" },
  } as CommandEnvelope;
}

function grantRequest(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "AGENT_UPLOAD_GRANT_REQUEST",
    messageId: randomUUID(),
    sentAt: new Date(now).toISOString(),
    missionId: MISSION,
    commandId,
    kind: "IMAGE",
    ...overrides,
  });
}

async function online() {
  const link = new AgentLink(
    observatory,
    store,
    (message) => sent.push(message),
    () => {},
    broadcast,
    FAKE_STORAGE,
    () => now,
  );
  await link.receive(
    JSON.stringify({
      type: "AGENT_HELLO",
      messageId: randomUUID(),
      sentAt: new Date(now).toISOString(),
      protocolVersion: PROTOCOL_VERSION,
      observatoryId: observatory.id,
      agentVersion: "0.1.0",
      mode: "SIMULATED",
      bootedAt: new Date(now).toISOString(),
      safetyEnvelopeConfigured: false,
      resumeMissionId: null,
    }),
  );
  sent.length = 0;
  return link;
}

const grants = () => sent.filter((message) => message.type === "CLOUD_UPLOAD_GRANT");
const errors = () => sent.filter((message) => message.type === "CLOUD_ERROR");

beforeEach(() => {
  store = new FakeLinkStore();
  broadcast = new RecordingBroadcast();
  sent = [];
  now = Date.parse("2026-12-15T20:00:00.000Z");
  commandId = randomUUID();
  store.addMission(MISSION, { observatoryId: observatory.id });
});

describe("granting somewhere to put a capture", () => {
  it("answers with one object, one method and an expiry", async () => {
    store.addCommand({ observatoryId: observatory.id, envelope: captureEnvelope() });
    const link = await online();

    await link.receive(grantRequest());

    expect(grants()).toHaveLength(1);
    const grant = grants()[0];
    if (grant.type !== "CLOUD_UPLOAD_GRANT") return;

    expect(grant.method).toBe("PUT");
    expect(grant.kind).toBe("IMAGE");
    expect(grant.missionId).toBe(MISSION);
    expect(grant.commandId).toBe(commandId);
    expect(new Date(grant.expiresAt).getTime()).toBeGreaterThan(now);
  });

  it("derives the key itself, and the URL names that key", async () => {
    // ADR-012: the agent never proposes a key. Deriving it cloud-side is what
    // stops a compromised agent writing over another customer's object, and it
    // is also what makes `CaptureAsset.storageKey` trustworthy later.
    store.addCommand({ observatoryId: observatory.id, envelope: captureEnvelope() });
    const link = await online();

    await link.receive(grantRequest());

    const grant = grants()[0];
    if (grant.type !== "CLOUD_UPLOAD_GRANT") return;

    expect(grant.storageKey).toBe(
      `captures/${observatory.id}/${MISSION}/${commandId}/IMAGE`,
    );
    expect(new URL(grant.url).pathname).toBe(`/${grant.storageKey}`);
  });

  it("ignores any key the agent might have hoped for", async () => {
    // The request carries no key field at all -- the contract does not have one.
    // An agent sending one anyway is refused by the generated validator before
    // this code runs, which is the strictness `additionalProperties: false` buys.
    store.addCommand({ observatoryId: observatory.id, envelope: captureEnvelope() });
    const link = await online();

    await link.receive(grantRequest({ storageKey: "captures/somebody-else/IMAGE" }));

    expect(grants()).toHaveLength(0);
    expect(errors()).toHaveLength(1);
  });

  it("grants a different object for each asset kind", async () => {
    store.addCommand({ observatoryId: observatory.id, envelope: captureEnvelope() });
    const link = await online();

    await link.receive(grantRequest());
    await link.receive(grantRequest({ kind: "FITS" }));

    const keys = grants().map((grant) =>
      grant.type === "CLOUD_UPLOAD_GRANT" ? grant.storageKey : "",
    );
    expect(new Set(keys).size).toBe(2);
  });
});

describe("what will not be granted", () => {
  it("refuses a command the cloud never minted", async () => {
    const link = await online();

    await link.receive(grantRequest());

    expect(grants()).toHaveLength(0);
    expect(errors()).toHaveLength(1);
  });

  it("refuses a command that belongs to another observatory", async () => {
    // The authority check. A device token is scoped to one observatory, and a
    // grant is a write into a bucket -- so a valid token must not be able to
    // obtain permission to write another site's object.
    store.addCommand({ observatoryId: OTHER_OBSERVATORY, envelope: captureEnvelope() });
    const link = await online();

    await link.receive(grantRequest());

    expect(grants()).toHaveLength(0);
    expect(errors()).toHaveLength(1);
  });

  it("refuses a real command cited against the wrong mission", async () => {
    // The command exists and is this observatory's, but the request names a
    // different mission. Granting would derive a key under a mission the command
    // has nothing to do with.
    store.addCommand({
      observatoryId: observatory.id,
      envelope: captureEnvelope(OTHER_MISSION),
    });
    const link = await online();

    await link.receive(grantRequest());

    expect(grants()).toHaveLength(0);
    expect(errors()).toHaveLength(1);
  });

  it("words every refusal identically", async () => {
    // A probing agent must not be able to tell "no such command" from "not
    // yours" from "wrong mission". Three different refusals would be three
    // different facts about somebody else's observatory.
    //
    // Each wording is captured immediately, because `online()` clears `sent` --
    // written first without that and it compared a set of one against itself.
    const wordingOf = async () => {
      const link = await online();
      await link.receive(grantRequest());
      const refusal = sent.find((message) => message.type === "CLOUD_ERROR");
      return refusal?.type === "CLOUD_ERROR" ? refusal.message : "no refusal";
    };

    const noSuchCommand = await wordingOf();

    store.addCommand({ observatoryId: OTHER_OBSERVATORY, envelope: captureEnvelope() });
    const notOurs = await wordingOf();

    store.addCommand({
      observatoryId: observatory.id,
      envelope: captureEnvelope(OTHER_MISSION),
    });
    const wrongMission = await wordingOf();

    expect(new Set([noSuchCommand, notOurs, wrongMission])).toEqual(
      new Set([noSuchCommand]),
    );
    expect(noSuchCommand).not.toBe("no refusal");
  });

  it("refuses with an error rather than a grant carrying no URL", async () => {
    // A message shaped like permission is a message some future agent build will
    // treat as permission.
    const link = await online();

    await link.receive(grantRequest());

    expect(sent.every((message) => message.type !== "CLOUD_UPLOAD_GRANT")).toBe(true);
  });
});
