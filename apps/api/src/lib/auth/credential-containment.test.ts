import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../..");
const contract = readFileSync(
  path.join(repositoryRoot, "contracts/openapi.yaml"),
  "utf8",
);
const sourceRoot = path.resolve(import.meta.dirname, "../..");

/** Field names that would mean a secret is crossing a boundary. */
const CREDENTIAL_LIKE = /token|secret|password|credential|cookie|csrf|apikey|bearer/i;

function propertiesOf(schemaName: string): string[] {
  const lines = contract.split("\n");
  const start = lines.findIndex((line) => line === `    ${schemaName}:`);
  if (start === -1) throw new Error(`${schemaName} is not in the contract`);

  const properties: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^ {4}[A-Za-z]/.test(line)) break;
    const match = line.match(/^ {8}([a-zA-Z][a-zA-Z0-9]*):$/);
    if (match) properties.push(match[1]);
  }
  return properties;
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return filesUnder(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/**
 * DV-051 criterion 3: no session credential is ever sent to the observatory or
 * included in any agent-link payload.
 *
 * The agent authenticates itself with its own credential when it dials out. It is
 * never handed a customer's. It receives sessionId and userId -- identifiers, so
 * it can enforce "one session owner at a time" independently -- and an identifier
 * is not a credential: holding one grants nothing.
 */
describe("no customer credential reaches the observatory", () => {
  const agentBound = [
    "CloudWelcome",
    "CloudCommand",
    "CloudHeartbeatAck",
    "CloudSessionUpdate",
    "CloudSafetyEnvelopeUpdate",
    "CloudError",
    "CommandEnvelope",
  ];

  it.each(agentBound)("%s declares no credential-shaped field", (schemaName) => {
    const offending = propertiesOf(schemaName).filter((property) =>
      CREDENTIAL_LIKE.test(property),
    );
    expect(offending).toEqual([]);
  });

  it("still passes the identifiers the agent needs to enforce ownership", () => {
    expect(propertiesOf("CommandEnvelope")).toEqual(
      expect.arrayContaining(["sessionId", "userId", "expiresAt", "commandId"]),
    );
  });
});

/**
 * DV-051 criterion 4: passwords and tokens never appear in logs.
 *
 * There is no logging in this app yet, so this is a tripwire rather than a repair:
 * it fails the moment someone logs a variable whose name says it is a secret.
 */
describe("no credential is written to a log", () => {
  const sources = filesUnder(sourceRoot).filter((file) => !file.endsWith(".test.ts"));

  it("has no console call that names a credential", () => {
    const offending = sources.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return text
        .split("\n")
        .map((line, index) => ({ file, line: index + 1, text: line }))
        .filter(
          ({ text: line }) => /console\.\w+\(/.test(line) && CREDENTIAL_LIKE.test(line),
        )
        .map(({ file: f, line }) => `${path.relative(sourceRoot, f)}:${line}`);
    });

    expect(offending).toEqual([]);
  });

  it("records the audit actor as a hash, never in the clear", () => {
    const audit = readFileSync(path.join(sourceRoot, "lib/auth/audit.ts"), "utf8");
    expect(audit).toContain("hashAuditActor(options.actor)");
    // the raw actor assigned straight to the column, rather than through the hash
    expect(audit).not.toMatch(/actorHash:\s*options\.actor\s*[,}]/);
  });
});
