// Live mission check against a locally running stack, after scripts/stress-stack.mjs has
// booked and paid a slot: waits for the slot, starts the mission, subscribes to the
// channel, captures, and verifies the capture reaches storage and the Collection.
// Development tooling only; never a product component.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/realtime/package.json", import.meta.url));
const WebSocket = require("ws");

const API = "http://127.0.0.1:4000",
  RT = "ws://127.0.0.1:4001",
  ORIGIN = "http://localhost:3000";
const ctx = JSON.parse(readFileSync(new URL("./.mission-ctx.json", import.meta.url)));
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} [live] ${name}${detail ? " — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body, extra = {}) {
  const headers = {
    origin: ORIGIN,
    accept: "application/json",
    cookie: ctx.cookies,
    ...extra,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

// 1. wait for the slot
const startAt = new Date(ctx.slotStartAt).getTime();
const wait = startAt + 5_000 - Date.now();
console.log(
  `slot starts ${ctx.slotStartAt}; waiting ${Math.max(0, wait / 1000).toFixed(0)}s`,
);
if (wait > 0) await sleep(wait);

// 2. start the mission session
let session = null;
for (let i = 0; i < 20 && !session; i++) {
  const r = await call("POST", `/missions/${ctx.missionId}/start`, {});
  if (r.status === 200) session = r.json;
  else {
    console.log("  start:", r.status, JSON.stringify(r.json).slice(0, 160));
    await sleep(3000);
  }
}
record(
  "owner starts the mission once the slot begins",
  !!session,
  session
    ? `sessionId=${session.sessionId} channel=${session.missionChannelUrl} allowed=${(session.allowedCommands ?? []).join(",")}`
    : "never opened",
);
if (!session) process.exit(1);

// 3. mission channel
const events = [];
const states = [];
const channel = session.missionChannelUrl.startsWith("ws")
  ? session.missionChannelUrl
  : RT + session.missionChannelUrl;
const ws = new WebSocket(channel, { headers: { origin: ORIGIN, cookie: ctx.cookies } });
let opened = await new Promise((resolve) => {
  ws.on("open", () => resolve(true));
  ws.on("unexpected-response", (_, res) => {
    console.log("  channel refused", res.statusCode);
    resolve(false);
  });
  ws.on("error", (e) => {
    console.log("  channel error", e.message);
    resolve(false);
  });
});
record("mission channel opens for the session owner", opened, channel);
if (opened)
  ws.send(
    JSON.stringify({
      type: "CLIENT_SUBSCRIBE",
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      missionId: ctx.missionId,
      sessionId: session.sessionId,
    }),
  );
ws.on("message", (data, isBinary) => {
  if (isBinary) {
    events.push({ type: "BINARY", bytes: data.length });
    return;
  }
  try {
    const m = JSON.parse(data.toString());
    events.push(m);
    const s = m.type === "MISSION_STATE" ? (m.state ?? m.mission?.state) : undefined;
    if (s && states[states.length - 1] !== s) {
      states.push(s);
      console.log("  state ->", s);
    }
  } catch {
    events.push({ type: "TEXT", raw: String(data).slice(0, 80) });
  }
});

// 4. watch the mission reach OBSERVING through the API as well
let mission = null;
for (let i = 0; i < 60; i++) {
  const r = await call("GET", `/missions/${ctx.missionId}`);
  mission = r.json?.mission ?? r.json;
  if (
    mission?.state === "OBSERVING" ||
    ["FAILED", "HARDWARE_ERROR", "NOT_VISIBLE", "CANCELLED", "COMPLETE"].includes(
      mission?.state,
    )
  )
    break;
  await sleep(2000);
}
record(
  "mission reaches OBSERVING (slew, verify, centre on the simulator)",
  mission?.state === "OBSERVING",
  `state=${mission?.state} failure=${mission?.failureReason ?? ""} seen=${states.join(">")}`,
);

// 5. events trail
const trail = await call("GET", `/missions/${ctx.missionId}/events`);
const kinds = (trail.json?.items ?? trail.json?.events ?? [])
  .map((e) => e.type ?? e.kind ?? e.state)
  .slice(0, 20);
record(
  "mission events are recorded",
  trail.status === 200 && kinds.length > 0,
  kinds.join(","),
);

// 6. capture
const profileFor = {
  "m42-orion-nebula": "BRIGHT_NEBULA",
  albireo: "DOUBLE_STAR",
  saturn: "PLANETARY",
  jupiter: "PLANETARY",
  "m13-hercules-cluster": "GLOBULAR_CLUSTER",
  "m57-ring-nebula": "PLANETARY_NEBULA",
  "moon-terminator": "LUNAR",
};
const cmd = await call("POST", `/missions/${ctx.missionId}/command`, {
  type: "CAPTURE",
  capture: { kind: "CAPTURE", imagingProfile: profileFor[ctx.target] ?? "BRIGHT_NEBULA" },
});
record(
  "CAPTURE command accepted",
  cmd.status === 200 || cmd.status === 202,
  `status=${cmd.status} ${JSON.stringify(cmd.json).slice(0, 160)}`,
);
const dup = await call("POST", `/missions/${ctx.missionId}/command`, {
  type: "NUDGE",
  nudge: { kind: "NUDGE", axis: "ALTITUDE", direction: "POSITIVE", arcminutes: 1 },
});
console.log("  nudge:", dup.status, JSON.stringify(dup.json).slice(0, 160));

let captures = [];
for (let i = 0; i < 120; i++) {
  const r = await call("GET", "/captures");
  captures = (r.json?.items ?? []).filter((c) => c.missionId === ctx.missionId);
  if (captures.length) break;
  await sleep(2000);
}
record(
  "capture appears in the Collection",
  captures.length > 0,
  captures.length
    ? `id=${captures[0].id} frames=${captures[0].framesStacked} integration=${captures[0].integrationSeconds}s`
    : "none within 240s",
);

if (captures.length) {
  const d = await call("GET", `/captures/${captures[0].id}/download?kind=IMAGE`);
  const url = d.json?.url ?? d.json?.downloadUrl ?? d.headers.get("location");
  record(
    "download link is minted",
    (d.status === 200 || d.status === 302) && !!url,
    `status=${d.status} url=${String(url).slice(0, 90)}`,
  );
  if (url) {
    const obj = await fetch(url);
    record(
      "object is retrievable from storage",
      obj.status === 200 && Number(obj.headers.get("content-length")) > 0,
      `status=${obj.status} bytes=${obj.headers.get("content-length")} type=${obj.headers.get("content-type")}`,
    );
  }
}

// 7. abort cleanly and confirm Park
// A capture that finishes the slot's work ends the mission COMPLETE on its own; an
// ABORT after that is rightly refused with 409.
const before = (await call("GET", `/missions/${ctx.missionId}`)).json;
const beforeState = before?.mission?.state ?? before?.state;
const abort = await call("POST", `/missions/${ctx.missionId}/command`, {
  type: "ABORT",
  reason: "stress: end of live check",
});
record(
  "ABORT accepted while live, or refused once the mission is already over",
  beforeState === "COMPLETE"
    ? abort.status === 409
    : abort.status === 200 || abort.status === 202,
  `mission was ${beforeState}, abort status=${abort.status}`,
);
let final = null;
for (let i = 0; i < 30; i++) {
  const r = await call("GET", `/missions/${ctx.missionId}`);
  final = r.json?.mission ?? r.json;
  if (["COMPLETE", "CANCELLED", "FAILED"].includes(final?.state)) break;
  await sleep(2000);
}
record(
  "mission ends in a terminal state after ABORT",
  ["COMPLETE", "CANCELLED", "FAILED"].includes(final?.state),
  `state=${final?.state} failure=${final?.failureReason ?? ""}`,
);
const state = await call(
  "GET",
  `/observatories/00000000-0000-4000-8000-000000000040/state`,
);
record(
  "observatory is free again",
  state.json?.missionInProgress === false,
  JSON.stringify(state.json).slice(0, 120),
);

ws.close();
console.log(
  `channel events: ${events.length} (binary frames: ${events.filter((e) => e.type === "BINARY").length}); types: ${[...new Set(events.map((e) => e.type))].join(",")}`,
);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} live checks passed`);
process.exit(failed ? 1 : 0);
