import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@darkview/db";

/**
 * The drill.
 *
 * A backup nobody has restored is a hope, and a restore procedure nobody has run
 * is a document. This takes a real dump of a real database, restores it into a
 * scratch one, and asks whether what came back is the same database -- every
 * table, every index definition, the rows, and the partial unique indexes that
 * DV-055 and ADR-007 depend on to be correctness rather than convention.
 *
 * It runs in CI on every pull request, which is the only thing that keeps it
 * true. `docs/RUNBOOK.md` §8 points at this file for exactly that reason.
 */
const SOURCE_URL =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/darkview_test";

const SCRATCH_DATABASE = "darkview_restore_drill";

/** An existing but unmigrated database, for the guards that need a real target. */
const EMPTY_DATABASE = "darkview_backup_guard";

/** A libpq URL: the Prisma-only parameters are not valid here. See scripts/backup.mjs. */
function libpq(raw: string) {
  const url = new URL(raw);
  for (const parameter of ["schema", "connection_limit", "pool_timeout", "pgbouncer"]) {
    url.searchParams.delete(parameter);
  }
  return url;
}

const sourceUrl = libpq(SOURCE_URL);
const scratchUrl = new URL(sourceUrl.toString());
scratchUrl.pathname = `/${SCRATCH_DATABASE}`;

/**
 * The maintenance connection.
 *
 * Creating and dropping a database cannot be done from inside it, so this points
 * at `postgres`, which every server has.
 */
const maintenanceUrl = new URL(sourceUrl.toString());
maintenanceUrl.pathname = "/postgres";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../..");

function psql(url: URL, statement: string) {
  return execFileSync("psql", [url.toString(), "-v", "ON_ERROR_STOP=1", "-tAc", statement], {
    encoding: "utf8",
  });
}

function node(script: string, args: string[], environment: Record<string, string> = {}) {
  return execFileSync("node", [path.join(repositoryRoot, "scripts", script), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

/**
 * The schema as the database itself reports it.
 *
 * Index definitions rather than index names, because a name surviving proves
 * nothing: `Mission_active_per_observatory_unique` is only worth anything if the
 * `WHERE` clause that makes it partial came back with it.
 */
function schemaOf(url: URL) {
  const tables = psql(
    url,
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const indexes = psql(
    url,
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`,
  );
  return { tables: tables.trim(), indexes: indexes.trim() };
}

const emptyUrl = new URL(sourceUrl.toString());
emptyUrl.pathname = `/${EMPTY_DATABASE}`;

const MARKER_USER_ID = "0dd11114-0000-4000-8000-00000000d114";
const MARKER_EMAIL = "restore-drill@darkview.test";
const MARKER_SESSION_ID = "0dd11114-0000-4000-8000-00000000d115";

let source: PrismaClient;
let backupDirectory: string;

beforeAll(async () => {
  source = new PrismaClient({
    adapter: new PrismaPg({ connectionString: sourceUrl.toString() }),
  });
  await source.$queryRaw`SELECT 1`;

  await source.session.deleteMany({ where: { id: MARKER_SESSION_ID } });
  await source.user.deleteMany({ where: { id: MARKER_USER_ID } });

  // A row and a credential, so the drill can tell "the data came back" from
  // "the session came back", which are meant to have different answers.
  await source.user.create({
    data: {
      id: MARKER_USER_ID,
      email: MARKER_EMAIL,
      name: "Restore Drill",
      sessions: {
        create: {
          id: MARKER_SESSION_ID,
          tokenHash: "restore-drill-token-hash",
          csrfTokenHash: "restore-drill-csrf-hash",
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        },
      },
    },
  });

  backupDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "darkview-drill-"));

  psql(maintenanceUrl, `DROP DATABASE IF EXISTS "${EMPTY_DATABASE}" WITH (FORCE)`);
  psql(maintenanceUrl, `CREATE DATABASE "${EMPTY_DATABASE}"`);
});

afterAll(async () => {
  await source?.session.deleteMany({ where: { id: MARKER_SESSION_ID } });
  await source?.user.deleteMany({ where: { id: MARKER_USER_ID } });
  await source?.$disconnect();

  psql(maintenanceUrl, `DROP DATABASE IF EXISTS "${SCRATCH_DATABASE}" WITH (FORCE)`);
  psql(maintenanceUrl, `DROP DATABASE IF EXISTS "${EMPTY_DATABASE}" WITH (FORCE)`);
  if (backupDirectory) fs.rmSync(backupDirectory, { recursive: true, force: true });
});

describe("a backup restores into an empty database", () => {
  let dumpFile: string;
  let restored: PrismaClient;

  it("takes a verified backup", () => {
    const output = node("backup.mjs", [backupDirectory], {
      DATABASE_URL: sourceUrl.toString(),
    });

    expect(output).toContain("verified readable by pg_restore");

    const written = fs.readdirSync(backupDirectory);
    expect(written).toHaveLength(1);
    dumpFile = path.join(backupDirectory, written[0]);
  });

  it("refuses a restore whose --confirm disagrees with its --to", () => {
    // The one guard standing between a recovery and a second disaster.
    //
    // Aimed at a database that *exists*, deliberately. Written first against one
    // that did not, where pg_restore failed for its own reasons and the test
    // passed with the guard deleted -- it was proving that you cannot restore
    // into a database nobody created, which is not the claim.
    expect(() =>
      node("restore.mjs", [
        "--from",
        dumpFile,
        "--to",
        emptyUrl.toString(),
        "--confirm",
        "some-other-database",
      ]),
    ).toThrow(/--confirm says/);

    // And it refused before touching anything: the target is still unmigrated.
    const tables = psql(
      emptyUrl,
      `SELECT count(*) FROM pg_tables WHERE schemaname = 'public'`,
    ).trim();
    expect(tables).toBe("0");
  });

  it("restores into a scratch database", () => {
    psql(maintenanceUrl, `CREATE DATABASE "${SCRATCH_DATABASE}"`);

    const output = node("restore.mjs", [
      "--from",
      dumpFile,
      "--to",
      scratchUrl.toString(),
      "--confirm",
      SCRATCH_DATABASE,
    ]);

    expect(output).toContain("restored.");
  });

  it("brings back every table and every index definition", () => {
    // Definitions, not names. A partial unique index whose WHERE clause did not
    // survive has the same name and none of the meaning: DV-055's one-booking
    // rule and ADR-007's seat cap are those WHERE clauses.
    expect(schemaOf(scratchUrl)).toEqual(schemaOf(sourceUrl));
  });

  it("brings back the partial unique indexes, WHERE clauses and all", async () => {
    // The strongest thing this drill can assert about correctness. These three
    // are not conventions the application maintains -- they are what stops two
    // people booking the same half hour (DV-055), two sessions owning one
    // mission, and a mission holding an observatory twice over. A dump that
    // brought back their names without their WHERE clauses would restore a
    // database that looks right and double-books.
    restored = new PrismaClient({
      adapter: new PrismaPg({ connectionString: scratchUrl.toString() }),
    });

    const partial = await restored.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexdef LIKE '%WHERE%'
      ORDER BY indexname
    `;

    expect(partial.map((index) => index.indexname)).toEqual([
      "Booking_held_slot_unique",
      "MissionSession_active_owner_unique",
      "Mission_active_per_observatory_unique",
    ]);

    for (const index of partial) {
      expect(index.indexdef).toMatch(/UNIQUE INDEX .* WHERE /);
    }
  });

  it("brings back the data", async () => {
    const user = await restored.user.findUnique({ where: { id: MARKER_USER_ID } });

    expect(user?.email).toBe(MARKER_EMAIL);
  });

  it("does not bring back a usable session", async () => {
    // A restored Session row is a live cookie from a past moment. Recovery is
    // exactly the situation where that must not be true.
    const session = await restored.session.findUnique({ where: { id: MARKER_SESSION_ID } });

    expect(session).toBeNull();
    await restored.$disconnect();
  });
});

describe("what the scripts refuse to do", () => {
  it("refuses to call a dump of an unmigrated database a backup", () => {
    // The failure this guards against is quiet: point the backup at a database
    // that exists but was never migrated -- a fresh instance after a rebuild,
    // say -- and pg_dump succeeds, writes a valid archive, and leaves a file
    // that looks exactly like a backup and holds nothing.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "darkview-empty-"));

    try {
      expect(() =>
        node("backup.mjs", [directory], { DATABASE_URL: emptyUrl.toString() }),
      ).toThrow(/holds no data entry for/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads the archive before it touches the target", () => {
    // Order matters more than the refusal does. --clean drops the schema, so
    // discovering an unreadable archive afterwards turns a database that could
    // have been left alone into an empty one.
    const corrupt = path.join(backupDirectory, "not-really-a-dump.dump");
    fs.writeFileSync(corrupt, "this is not a pg_dump archive");

    expect(() =>
      node("restore.mjs", [
        "--from",
        corrupt,
        "--to",
        emptyUrl.toString(),
        "--confirm",
        EMPTY_DATABASE,
      ]),
    ).toThrow(/The target was not touched/);
  });
});
