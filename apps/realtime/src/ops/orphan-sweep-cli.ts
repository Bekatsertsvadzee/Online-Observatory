import { parseArgs } from "node:util";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@darkview/db";
import { getStorageConfiguration } from "@darkview/storage/config";
import { deleteObject, listObjects } from "@darkview/storage/objects";

import {
  CAPTURE_PREFIX,
  DEFAULT_GRACE_HOURS,
  sweepOrphans,
  type SweepReport,
} from "@/ops/orphan-sweep";
import { databaseDependencies } from "@/ops/orphan-sweep-database";

/**
 * The operator's orphan sweep (ADR-012, #141). Run by hand; nothing schedules it.
 *
 *     npm run storage:orphans                                  report only
 *     npm run storage:orphans -- --delete --confirm <bucket>   delete what it reports
 *     npm run storage:orphans -- --older-than 72               a longer grace, in hours
 *
 * Reports by default. Deleting takes `--confirm` naming the configured bucket, for
 * the reason `scripts/restore.mjs` asks for its target: the two disagreeing is the
 * shape of a command aimed somewhere it was not meant to be.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      delete: { type: "boolean", default: false },
      confirm: { type: "string" },
      "older-than": { type: "string" },
    },
    strict: true,
  });

  const graceHours =
    values["older-than"] === undefined ? DEFAULT_GRACE_HOURS : Number(values["older-than"]);
  if (!Number.isFinite(graceHours) || graceHours < DEFAULT_GRACE_HOURS) {
    console.error(
      `--older-than must be a number of hours, at least ${DEFAULT_GRACE_HOURS} (ADR-012).`,
    );
    return 2;
  }

  let storage;
  try {
    storage = getStorageConfiguration();
  } catch (error) {
    // Names the missing variables and never their values; see config.ts.
    console.error((error as Error).message);
    return 2;
  }
  if (values.delete && values.confirm !== storage.S3_BUCKET) {
    console.error(
      "Refusing to delete: --confirm must name the configured bucket exactly. " +
        "Run without --delete first and read the report.",
    );
    return 2;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set.");
    return 2;
  }

  const database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const now = new Date();

  try {
    const report = await sweepOrphans(
      {
        ...databaseDependencies(database),
        list: () => listObjects(storage, CAPTURE_PREFIX, now),
        remove: (key) => deleteObject(storage, key, new Date()),
        now,
        graceHours,
      },
      { remove: values.delete },
    );
    print(report, values.delete, graceHours);
    return 0;
  } finally {
    await database.$disconnect();
  }
}

function print(report: SweepReport, deleting: boolean, graceHours: number) {
  const bytes = (objects: { size: number }[]) =>
    objects.reduce((total, object) => total + object.size, 0);

  console.log(`Scanned ${report.scanned} object(s) under ${CAPTURE_PREFIX}`);
  console.log(`  referenced by a capture:     ${report.referenced}`);
  console.log(`  younger than ${graceHours}h (kept):     ${report.withinGrace}`);
  console.log(`  unrecognised (never deleted): ${report.unrecognised.length}`);
  console.log(
    `  orphans:                     ${report.orphans.length} (${bytes(report.orphans)} bytes)`,
  );

  for (const orphan of report.orphans) {
    console.log(`    ${orphan.key}  ${orphan.size} B  ${Math.round(orphan.ageHours)}h old`);
  }
  for (const object of report.unrecognised) {
    console.log(`    unrecognised: ${object.key}`);
  }

  if (!deleting) {
    console.log("Report only. Nothing was deleted.");
    return;
  }
  console.log(`Deleted ${report.deleted.length}, each with an audit row.`);
  if (report.spared.length > 0) {
    console.log(`Spared ${report.spared.length}: a capture claimed them during the sweep.`);
  }
}

process.exitCode = await main();
