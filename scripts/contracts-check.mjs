#!/usr/bin/env node
// Fails if any committed generated artifact has drifted from contracts/openapi.yaml.
// Generates into a scratch directory and compares; never mutates the committed output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generatePydantic, generateTypeScript } from "./contracts-generate.mjs";

const repositoryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const committedDirectory = path.join(repositoryRoot, "packages/contracts/generated");
const committedPydantic = path.join(repositoryRoot, "agent/contracts/models.py");

function readTree(directory) {
  if (!fs.existsSync(directory)) return new Map();
  return new Map(
    fs
      .readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const absolute = path.join(entry.parentPath, entry.name);
        return [path.relative(directory, absolute), fs.readFileSync(absolute, "utf8")];
      }),
  );
}

const scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "darkview-contracts-"));

try {
  generateTypeScript(scratchDirectory);

  const expected = readTree(scratchDirectory);
  const committed = readTree(committedDirectory);
  const drifted = [];

  for (const [file, contents] of expected) {
    if (!committed.has(file)) drifted.push(`missing:  packages/contracts/generated/${file}`);
    else if (committed.get(file) !== contents)
      drifted.push(`stale:    packages/contracts/generated/${file}`);
  }
  for (const file of committed.keys()) {
    if (!expected.has(file)) drifted.push(`orphaned: packages/contracts/generated/${file}`);
  }

  generatePydantic(path.join(scratchDirectory, "models.py"));
  const expectedPydantic = fs.readFileSync(path.join(scratchDirectory, "models.py"), "utf8");
  if (!fs.existsSync(committedPydantic)) {
    drifted.push("missing:  agent/contracts/models.py");
  } else if (fs.readFileSync(committedPydantic, "utf8") !== expectedPydantic) {
    drifted.push("stale:    agent/contracts/models.py");
  }

  if (drifted.length > 0) {
    console.error("Generated contract artifacts have drifted from contracts/openapi.yaml:\n");
    for (const line of drifted) console.error(`  ${line}`);
    console.error("\nRun `npm run contracts:generate` and commit the result.");
    process.exit(1);
  }

  console.log(`contracts: ${expected.size + 1} generated artifacts match contracts/openapi.yaml`);
} finally {
  fs.rmSync(scratchDirectory, { recursive: true, force: true });
}
