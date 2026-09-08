#!/usr/bin/env node
// Restores a Darkview backup into a database, and revokes every session it
// brings back with it.
//
// This is the destructive half of DV-114 and its defaults say so: there is no
// default target, the target's database name has to be typed out, and nothing is
// read from DATABASE_URL. A restore script that quietly targets the configured
// database is one keystroke away from being the disaster rather than the
// recovery.
//
// Running this against production is a maintainer action, taken deliberately in
// a session where the maintainer asked for it. Nothing here should be automated.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const PRISMA_ONLY_PARAMETERS = [
  "schema",
  "connection_limit",
  "pool_timeout",
  "pgbouncer",
  "socket_timeout",
];

/**
 * Tables holding a bearer credential that was valid when the backup was taken.
 *
 * A restored `Session` row is a live cookie from a past moment: whoever held it
 * then holds it again now, including anyone who held one because the incident
 * being recovered from handed it to them. Restoring is exactly when that must
 * not be true, so every one of these is emptied unless the operator says
 * otherwise -- and the flag that says otherwise is named for what it does.
 */
const CREDENTIAL_TABLES = ["Session", "EmailVerificationToken"];

function fail(message) {
  console.error(`restore: ${message}`);
  process.exit(1);
}

function usage() {
  console.error(
    [
      "restore: usage",
      "  node scripts/restore.mjs --from <file.dump> --to <url> --confirm <database>",
      "",
      "  --confirm must equal the database named in --to. It exists so that",
      "  restoring over a database is something typed rather than something",
      "  a shell history repeats.",
      "",
      "  --keep-restored-sessions leaves the backup's sessions valid. Do not use",
      "  it while recovering from anything that might have leaked one.",
    ].join("\n"),
  );
  process.exit(1);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const file = argument("--from");
const target = argument("--to");
const confirm = argument("--confirm");
const keepSessions = process.argv.includes("--keep-restored-sessions");

if (!file || !target || !confirm) usage();
if (!fs.existsSync(file)) fail(`no such file: ${file}`);

let url;
try {
  url = new URL(target);
} catch {
  fail("--to is not a URL.");
}

for (const parameter of PRISMA_ONLY_PARAMETERS) url.searchParams.delete(parameter);

const database = url.pathname.replace(/^\//, "");
if (!database) fail("--to names no database.");

if (confirm !== database) {
  fail(
    `--confirm says "${confirm}" and --to names "${database}". ` +
      `Refusing, because the two disagreeing is the shape of a restore aimed at ` +
      `the wrong database.`,
  );
}

const connectionString = url.toString();
const label = `${url.host}/${database}`;

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8" });
}

// Read the archive before touching the target. A file that cannot be listed
// cannot be restored, and finding that out after --clean has dropped the schema
// would turn a recoverable situation into an empty database.
try {
  run("pg_restore", ["--list", file]);
} catch {
  fail(`${file} is not a readable pg_dump archive. The target was not touched.`);
}

console.log(`restore: ${file} -> ${label}`);

try {
  // --clean --if-exists so a restore over an existing schema replaces it rather
  // than colliding with it; --exit-on-error so a partial restore is a failure
  // and not a database that looks recovered.
  run("pg_restore", [
    "--dbname",
    connectionString,
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    "--exit-on-error",
    file,
  ]);
} catch (error) {
  fail(`pg_restore failed against ${label}: ${error.stderr ?? error.message}`);
}

if (keepSessions) {
  console.log(
    "restore: sessions from the backup are still valid (--keep-restored-sessions).",
  );
} else {
  const statements = CREDENTIAL_TABLES.map((table) => `DELETE FROM "${table}";`).join(" ");
  run("psql", [connectionString, "-v", "ON_ERROR_STOP=1", "-c", statements]);
  console.log(`restore: cleared ${CREDENTIAL_TABLES.join(", ")}; everyone signs in again.`);
}

console.log(`restore: ${label} restored.`);
