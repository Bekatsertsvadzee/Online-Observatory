import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { CaptureAssetKind, CloudToAgentMessage, CommandEnvelope } from "@darkview/contracts";
import { captureObjectKey } from "@darkview/storage/keys";

import { AgentLink } from "@/link/agent-link";
import { FakeLinkStore } from "@/link/fake-store";
import { PROTOCOL_VERSION } from "@/link/protocol";
import type { ObservatoryRecord } from "@/link/store";
import { RecordingBroadcast } from "@/mission/fake-broadcast";
import { FAKE_STORAGE } from "@/link/fake-storage";

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
const TARGET = "88888888-8888-4888-8888-888888888888";

let store: FakeLinkStore;
let broadcast: RecordingBroadcast;
let sent: CloudToAgentMessage[];
let now: number;
let commandId: string;

function captureCommand(
  overrides: { missionId?: string; observatoryId?: string } = {},
): CommandEnvelope {
  return {
    commandId,
    missionId: overrides.missionId ?? MISSION,
    sessionId: SESSION,
    userId: OWNER,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
    type: "CAPTURE",
    payload: { kind: "CAPTURE" },
  } as CommandEnvelope;
}

/** The key a grant for this capture would have derived. */
function grantedKey(
  kind: CaptureAssetKind,
  ids: { missionId?: string; commandId?: string; observatoryId?: string } = {},
) {
  return captureObjectKey({
    observatoryId: ids.observatoryId ?? observatory.id,
    missionId: ids.missionId ?? MISSION,
    commandId: ids.commandId ?? commandId,
    kind,
  });
}

/**
 * A capture report whose keys are the ones its own grants would have derived.
 *
 * Derived from the message's final mission and command, not from the defaults, so
 * a test that points a capture at another mission is refused by the check it is
 * about -- the mission's owner, the command's scope -- and not incidentally by
 * the key check (DV-065) firing first.
 */
function captureReady(overrides: Record<string, unknown> = {}) {
  const ids = {
    missionId: (overrides.missionId as string | undefined) ?? MISSION,
    commandId: (overrides.commandId as string | undefined) ?? commandId,
  };
  return JSON.stringify({
    type: "AGENT_CAPTURE_READY",
    messageId: randomUUID(),
    sentAt: new Date(now).toISOString(),
    missionId: MISSION,
    commandId,
    capturedAt: new Date(now).toISOString(),
    imagingProfile: "GLOBULAR_CLUSTER",
    opticalConfig: "F10_NATIVE",
    exposureMilliseconds: 4000,
    gain: 250,
    framesStacked: 40,
    integrationSeconds: 160,
    imageStorageKey: grantedKey("IMAGE", ids),
    unmarkedStorageKey: null,
    fitsStorageKey: null,
    solvedFocalLengthMm: 1500,
    widthPx: 3840,
    heightPx: 2160,
    mode: "SIMULATED",
    ...overrides,
  });
}

async function online(record: ObservatoryRecord = observatory) {
  const link = new AgentLink(
    record,
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
      observatoryId: record.id,
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

beforeEach(() => {
  store = new FakeLinkStore();
  broadcast = new RecordingBroadcast();
  sent = [];
  now = Date.parse("2026-09-08T21:00:00.000Z");
  commandId = randomUUID();

  store.addMission(MISSION, {
    observatoryId: observatory.id,
    state: "CAPTURING",
    userId: OWNER,
    targetId: TARGET,
  });
  store.addCommand({ observatoryId: observatory.id, envelope: captureCommand() });
});

describe("a capture entering the Collection", () => {
  it("records it and tells the mission's subscribers", async () => {
    const link = await online();

    await link.receive(captureReady());

    expect(store.captures.size).toBe(1);
    expect(broadcast.captures).toHaveLength(1);
    expect(broadcast.captures[0]).toMatchObject({
      missionId: MISSION,
      userId: OWNER,
      targetId: TARGET,
      framesStacked: 40,
      integrationSeconds: 160,
      visibility: "PRIVATE",
    });
  });

  it("gives it to the mission's owner, not to whoever reported it", async () => {
    // ADR-007: an observer "receives mission state and the live view and nothing
    // else -- nothing from this mission enters the observer's Collection". The
    // owner is read from the mission row; the agent has no say in it.
    const link = await online();

    await link.receive(captureReady());

    expect(store.captures.get(commandId)?.ownerId).toBe(OWNER);
    expect(broadcast.captures[0].userId).toBe(OWNER);
  });

  it("marks a simulated mission's capture SIMULATED whatever the agent claims", async () => {
    // A capture produced by the simulator is permanently marked SIMULATED and is
    // never presented as telescope output. An agent able to set this could file
    // simulator output as a photograph of the sky.
    const link = await online();

    await link.receive(captureReady({ mode: "REAL" }));

    expect(broadcast.captures[0].mode).toBe("SIMULATED");
  });

  it("marks a real mission's capture REAL", async () => {
    store.addMission(OTHER_MISSION, {
      observatoryId: observatory.id,
      state: "CAPTURING",
      mode: "REAL",
      userId: OWNER,
    });
    store.addCommand({
      observatoryId: observatory.id,
      envelope: captureCommand({ missionId: OTHER_MISSION }),
    });
    const link = await online();

    await link.receive(captureReady({ missionId: OTHER_MISSION }));

    expect(broadcast.captures[0].mode).toBe("REAL");
  });

  it("reports FITS as available only when a FITS object was written", async () => {
    // Derived from the assets, never from a flag. A true with no object behind it
    // is a download button that 404s.
    const link = await online();

    await link.receive(captureReady());
    expect(broadcast.captures[0].fitsAvailable).toBe(false);

    const second = randomUUID();
    commandId = second;
    store.addCommand({ observatoryId: observatory.id, envelope: captureCommand() });
    await link.receive(captureReady({ fitsStorageKey: grantedKey("FITS") }));

    expect(broadcast.captures[1].fitsAvailable).toBe(true);
  });

  it("carries no thumbnail URL, even when a thumbnail was written", async () => {
    // A signed, short-expiry URL is minted against a caller. This is a push, so
    // there is no caller, and a stored path would be a public bucket URL. The
    // client reads the Collection for it.
    const link = await online();

    await link.receive(captureReady({ thumbnailStorageKey: grantedKey("THUMBNAIL") }));

    expect(broadcast.captures[0].thumbnailUrl).toBeNull();
  });

  // DV-065: the agent can now say it wrote one, so the cloud can sign it later.
  it("records a THUMBNAIL asset when the agent reports one", async () => {
    const link = await online();

    await link.receive(captureReady({ thumbnailStorageKey: grantedKey("THUMBNAIL") }));

    expect(store.captures.get(commandId)?.assets).toEqual([
      { kind: "IMAGE", storageKey: grantedKey("IMAGE") },
      { kind: "THUMBNAIL", storageKey: grantedKey("THUMBNAIL") },
    ]);
  });

  it("records no THUMBNAIL when an older agent sends none", async () => {
    // The field is optional, so an agent that predates DV-065 is still valid and
    // its capture still lands -- with no thumbnail rather than a broken one.
    const link = await online();
    const message = JSON.parse(captureReady()) as Record<string, unknown>;
    delete message.thumbnailStorageKey;

    await link.receive(JSON.stringify(message));

    expect(store.captures.get(commandId)?.assets.map((asset) => asset.kind)).toEqual([
      "IMAGE",
    ]);
  });
});

describe("what is not recorded twice", () => {
  it("ignores the agent replaying its queue", async () => {
    // Same messageId: the outage path. The message is acknowledged, stored once,
    // applied once.
    const link = await online();
    const message = captureReady();

    await link.receive(message);
    await link.receive(message);

    expect(store.captures.size).toBe(1);
    expect(broadcast.captures).toHaveLength(1);
  });

  it("ignores a capture re-sent under a fresh messageId", async () => {
    // The messageId guard cannot catch this one. The commandId is a unique index,
    // and the customer must not be shown a second image that is the same image.
    const link = await online();

    await link.receive(captureReady());
    await link.receive(captureReady({ messageId: randomUUID() }));

    expect(store.captures.size).toBe(1);
    expect(broadcast.captures).toHaveLength(1);
  });
});

describe("what is refused", () => {
  it("refuses a capture for a mission this observatory does not own", async () => {
    store.addMission(OTHER_MISSION, {
      observatoryId: OTHER_OBSERVATORY,
      state: "CAPTURING",
    });
    const link = await online();

    await link.receive(captureReady({ missionId: OTHER_MISSION }));

    expect(store.captures.size).toBe(0);
    expect(broadcast.captures).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ type: "CLOUD_ERROR", code: "FORBIDDEN" });
  });

  it("refuses a capture for a mission that does not exist", async () => {
    const link = await online();

    await link.receive(captureReady({ missionId: randomUUID() }));

    expect(store.captures.size).toBe(0);
    expect(sent.at(-1)).toMatchObject({ type: "CLOUD_ERROR", code: "FORBIDDEN" });
  });

  it("refuses a capture filed against a command the cloud never minted", async () => {
    // The commandId is the idempotency key. An agent that could name an arbitrary
    // command could occupy somebody else's row in Capture_command_unique and stop
    // their capture ever being recorded.
    const link = await online();

    await link.receive(captureReady({ commandId: randomUUID() }));

    expect(store.captures.size).toBe(0);
    expect(broadcast.captures).toEqual([]);
  });

  it("refuses a capture whose command belongs to a different mission", async () => {
    store.addMission(OTHER_MISSION, {
      observatoryId: observatory.id,
      state: "CAPTURING",
      userId: OWNER,
    });
    const link = await online();

    await link.receive(captureReady({ missionId: OTHER_MISSION }));

    expect(store.captures.size).toBe(0);
    expect(broadcast.captures).toEqual([]);
  });

  /**
   * DV-065. The grant derives every key cloud-side so an agent cannot choose one;
   * until this check, the report of what was written took the agent's word for it.
   * Under ADR-013 the agent may be a stranger's, and a key it could choose is a key
   * to another customer's object: the API signs downloads of whatever is recorded.
   */
  // Thunks, not values: the table is built when the file loads, before
  // beforeEach has chosen this test's command.
  it.each<[string, () => Record<string, unknown>]>([
    [
      "an IMAGE that is another observatory's object",
      () => ({ imageStorageKey: grantedKey("IMAGE", { observatoryId: OTHER_OBSERVATORY }) }),
    ],
    [
      "an IMAGE that is another mission's object",
      () => ({ imageStorageKey: grantedKey("IMAGE", { missionId: OTHER_MISSION }) }),
    ],
    [
      "a THUMBNAIL that is another capture's object",
      () => ({ thumbnailStorageKey: grantedKey("THUMBNAIL", { commandId: randomUUID() }) }),
    ],
    [
      "one kind's key reported as another kind",
      () => ({ unmarkedStorageKey: grantedKey("IMAGE") }),
    ],
    [
      "a key that is not a derived key at all",
      () => ({ imageStorageKey: "captures/anything.jpg" }),
    ],
  ])("refuses a capture reporting %s", async (_label, overrides) => {
    const link = await online();

    await link.receive(captureReady(overrides()));

    expect(store.captures.size).toBe(0);
    expect(broadcast.captures).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ type: "CLOUD_ERROR", code: "FORBIDDEN" });
  });

  it("ignores a capture that arrives before the hello", async () => {
    const link = new AgentLink(
      observatory,
      store,
      (message) => sent.push(message),
      () => {},
      broadcast,
      FAKE_STORAGE,
      () => now,
    );

    await link.receive(captureReady());

    expect(store.captures.size).toBe(0);
  });
});
