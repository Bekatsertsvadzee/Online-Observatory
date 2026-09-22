import type { CaptureAssetKind } from "@darkview/contracts";
import type { StoredObject } from "@darkview/storage/objects";

/**
 * Capture objects no row references (ADR-012, #141).
 *
 * An agent can upload an asset and lose its link before it reports the capture, and
 * the object is then in the bucket with no `CaptureAsset` naming it. This finds those
 * and, only when an operator asks, deletes them.
 *
 * Three conditions, all required, before anything is an orphan:
 *
 * - **The key has the derived shape**, `captures/<uuid>/<uuid>/<uuid>/<kind>`. The
 *   sweep removes only what the cloud could have minted. Anything else under the
 *   prefix is reported as unrecognised and left alone: it is a question for a
 *   person, not something to clean.
 * - **No row references it.** Checked per page, and again for each key immediately
 *   before it is deleted, so a capture reported while the sweep runs keeps its image.
 * - **It is older than the grace period.** A day by default, ADR-012's figure. An
 *   agent that uploaded a minute ago is most likely about to report.
 *
 * Deliberately transport-free. The bucket, the database and the audit are handed in,
 * so every rule is tested without either.
 */

export const CAPTURE_PREFIX = "captures/";
export const DEFAULT_GRACE_HOURS = 24;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KINDS: readonly CaptureAssetKind[] = ["IMAGE", "THUMBNAIL", "FITS", "UNMARKED"];
// Case-sensitive on purpose. The derivation writes lowercase UUIDs from the database
// and the enum's own spelling; a key in any other case was not written by it.
const DERIVED_KEY = new RegExp(
  `^captures/(${UUID})/(${UUID})/(${UUID})/(${KINDS.join("|")})$`,
);

export type DerivedKey = {
  observatoryId: string;
  missionId: string;
  commandId: string;
  kind: CaptureAssetKind;
};

export function parseDerivedKey(key: string): DerivedKey | null {
  const match = key.match(DERIVED_KEY);
  if (!match) return null;
  const [, observatoryId, missionId, commandId, kind] = match;
  return { observatoryId, missionId, commandId, kind: kind as CaptureAssetKind };
}

export type SweepDependencies = {
  list: () => AsyncIterable<StoredObject>;
  /** Which of these keys a CaptureAsset row names. */
  referenced: (keys: string[]) => Promise<Set<string>>;
  remove: (key: string) => Promise<void>;
  /** Written after each deletion. A bucket delete cannot be undone; its record can be kept. */
  audit: (object: StoredObject, key: DerivedKey, ageHours: number) => Promise<void>;
  now: Date;
  graceHours: number;
};

export type Orphan = StoredObject & { ageHours: number };

export type SweepReport = {
  scanned: number;
  referenced: number;
  withinGrace: number;
  unrecognised: StoredObject[];
  orphans: Orphan[];
  deleted: Orphan[];
  /** Orphans that gained a row between the listing and their deletion. */
  spared: Orphan[];
};

const PAGE = 500;

export async function sweepOrphans(
  dependencies: SweepDependencies,
  { remove }: { remove: boolean },
): Promise<SweepReport> {
  const report: SweepReport = {
    scanned: 0,
    referenced: 0,
    withinGrace: 0,
    unrecognised: [],
    orphans: [],
    deleted: [],
    spared: [],
  };

  let batch: StoredObject[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const named = await dependencies.referenced(batch.map((object) => object.key));
    for (const object of batch) {
      if (named.has(object.key)) {
        report.referenced += 1;
        continue;
      }
      const ageHours =
        (dependencies.now.getTime() - object.lastModified.getTime()) / 3_600_000;
      if (ageHours < dependencies.graceHours) {
        report.withinGrace += 1;
        continue;
      }
      report.orphans.push({ ...object, ageHours });
    }
    batch = [];
  };

  for await (const object of dependencies.list()) {
    report.scanned += 1;
    if (!object.key.startsWith(CAPTURE_PREFIX) || parseDerivedKey(object.key) === null) {
      report.unrecognised.push(object);
      continue;
    }
    batch.push(object);
    if (batch.length >= PAGE) await flush();
  }
  await flush();

  if (!remove) return report;

  for (const orphan of report.orphans) {
    // Again, one key at a time, immediately before the delete. The listing may be
    // minutes old by now, and a capture reported in the meantime owns this object.
    if ((await dependencies.referenced([orphan.key])).has(orphan.key)) {
      report.spared.push(orphan);
      continue;
    }
    await dependencies.remove(orphan.key);
    await dependencies.audit(orphan, parseDerivedKey(orphan.key)!, orphan.ageHours);
    report.deleted.push(orphan);
  }

  return report;
}
