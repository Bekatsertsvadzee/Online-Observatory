#!/usr/bin/env node
// Takes a verified backup of the Darkview database.
//
// A backup nobody has read back is a hope, not a backup, so this does not finish
// until `pg_restore --list` has read the file it just wrote and found the tables
// that matter in it. The exit code is the whole interface: zero means a file
// exists and is readable as a dump, and anything else means there is no backup.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Query parameters Prisma understands and libpq does not.
 *
 * `postgresql://.../darkview?schema=public` is a valid Prisma URL and not a valid
 * libpq one -- psql answers `invalid URI query parameter: "schema"` -- so the
 * same string that runs the application cannot be handed to pg_dump unchanged.
 * Stripping the known Prisma-only keys is deliberate rather than filtering to an
 * allow-list: an unrecognised parameter is more likely to be a libpq one this
 * list has not met than a Prisma one, and dropping it silently would change the
 * connection without saying so.
 */
const PRISMA_ONLY_PARAMETERS = [
  "schema",
  "connection_limit",
  "pool_timeout",
  "pgbouncer",
  "socket_timeout",
];

/**
 * Tables whose absence means the dump is not of this database.
 *
 * A custom-format dump lists a TABLE DATA entry for every table it holds, empty
 * or not, so this catches a dump taken against the wrong database or one taken
 * before the migrations ran. It does not catch a dump of an empty Darkview
 * database, which is a legitimate thing to have on day one.
 */
const REQUIRED_TABLES = ["User", "Mission", "Booking", "Capture", "AuditLog", "Observatory"];

function fail(message) {
  console.error(`backup: ${message}`);
  process.exit(1);
}

/**
 * A connection URL with the Prisma-only parameters removed, and a label safe to
 * print. The URL itself carries the password and is never logged.
 */
function connection(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("DATABASE_URL is not a URL.");
  }

  for (const parameter of PRISMA_ONLY_PARAMETERS) url.searchParams.delete(parameter);

  const database = url.pathname.replace(/^\//, "");
  if (!database) fail("DATABASE_URL names no database.");

  return { url: url.toString(), label: `${url.host}/${database}`, database };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options });
}

/**
 * Refuse to dump a server newer than the client.
 *
 * pg_dump reads the catalogue directly, so a client older than the server does
 * not merely warn -- it can miss objects it has no concept of, and the failure
 * surfaces at restore time, which is the worst moment to discover it. pg_dump
 * itself refuses outright in most such pairings; this checks first so the
 * message says what to do about it.
 */
function assertClientIsNotOlder(url, label) {
  const clientMajor = Number(run("pg_dump", ["--version"]).match(/(\d+)/)[1]);
  const serverVersion = run("psql", [url, "-tAc", "SHOW server_version"]).trim();
  const serverMajor = Number(serverVersion.match(/(\d+)/)[1]);

  if (clientMajor < serverMajor) {
    fail(
      `pg_dump is version ${clientMajor} and ${label} is PostgreSQL ${serverMajor}. ` +
        `A dump taken by an older client can be silently incomplete. ` +
        `Install a PostgreSQL ${serverMajor} client and run this again.`,
    );
  }

  return { clientMajor, serverMajor };
}

/**
 * Read the dump back and prove it is one.
 *
 * `pg_restore --list` parses the archive's table of contents, so it fails on a
 * truncated or corrupt file rather than on a merely empty one -- which is the
 * distinction that matters here.
 */
function verify(file) {
  let toc;
  try {
    toc = run("pg_restore", ["--list", file]);
  } catch {
    fail(`wrote ${file} but pg_restore could not read it back. There is no backup.`);
  }

  const missing = REQUIRED_TABLES.filter(
    (table) => !toc.includes(`TABLE DATA public ${table}`),
  );

  if (missing.length > 0) {
    fail(
      `${file} is readable but holds no data entry for: ${missing.join(", ")}. ` +
        `That is not a dump of a migrated Darkview database.`,
    );
  }

  return toc.split("\n").filter((line) => line.includes("TABLE DATA")).length;
}

const outputDirectory = process.argv[2] ?? "backups";
const raw = process.env.DATABASE_URL;
if (!raw) fail("DATABASE_URL is not set.");

const { url, label, database } = connection(raw);
const { serverMajor } = assertClientIsNotOlder(url, label);

// The system clock, never a value chosen to look tidy. A backup filename is the
// only record of when it was taken, and a backdated one is worse than none.
const takenAt = new Date().toISOString().replace(/[:.]/g, "-");
const file = path.join(outputDirectory, `${database}-${takenAt}.dump`);

fs.mkdirSync(outputDirectory, { recursive: true });

try {
  // --no-owner and --no-privileges so the dump restores into a database whose
  // roles are named differently, which is the normal case when recovering onto
  // new infrastructure. Custom format because it is the only one pg_restore can
  // read selectively and the only one this script can verify without applying.
  run("pg_dump", [
    url,
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    `--file=${file}`,
  ]);
} catch (error) {
  fail(`pg_dump failed against ${label}: ${error.stderr ?? error.message}`);
}

const tables = verify(file);
const bytes = fs.statSync(file).size;

console.log(`backup: ${label} (PostgreSQL ${serverMajor})`);
console.log(`backup: ${file}`);
console.log(`backup: ${tables} tables, ${bytes} bytes, verified readable by pg_restore`);
