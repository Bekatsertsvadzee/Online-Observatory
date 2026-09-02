#!/usr/bin/env node
// Regenerates every cross-boundary artifact from contracts/openapi.yaml.
// contracts/openapi.yaml is the single source of truth; nothing here is edited by hand.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pydanticGenerator = path.join(repositoryRoot, "agent/.venv/bin/datamodel-codegen");

export function generateTypeScript(outputDirectory) {
  execFileSync(path.join(repositoryRoot, "node_modules/.bin/openapi-ts"), {
    cwd: path.join(repositoryRoot, "packages/contracts"),
    env: outputDirectory
      ? { ...process.env, DARKVIEW_CONTRACTS_OUT: outputDirectory }
      : process.env,
    stdio: "inherit",
  });
}

export function generatePydantic(outputFile) {
  if (!fs.existsSync(pydanticGenerator)) {
    throw new Error(
      "agent/.venv/bin/datamodel-codegen is missing.\n" +
        "Create the agent environment first:\n" +
        "  python3.12 -m venv agent/.venv\n" +
        "  agent/.venv/bin/pip install -r agent/requirements-dev.txt",
    );
  }

  execFileSync(
    pydanticGenerator,
    [
      "--input", path.join(repositoryRoot, "contracts/openapi.yaml"),
      "--input-file-type", "openapi",
      "--output", outputFile ?? path.join(repositoryRoot, "agent/contracts/models.py"),
      "--output-model-type", "pydantic_v2.BaseModel",
      "--target-python-version", "3.12",
      "--use-standard-collections",
      "--use-union-operator",
      "--enum-field-as-literal", "one",
      "--use-schema-description",
      "--field-constraints",
      "--snake-case-field",
      "--formatters", "black",
      "--formatters", "isort",
      "--disable-timestamp",
    ],
    { cwd: repositoryRoot, stdio: ["ignore", "inherit", "pipe"] },
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateTypeScript();
  generatePydantic();
  console.log("\ncontracts: TypeScript + Zod  -> packages/contracts/generated");
  console.log("contracts: Pydantic models   -> agent/contracts/models.py");
}
