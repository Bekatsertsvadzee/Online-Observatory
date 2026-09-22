import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { StoredObject } from "@darkview/storage/objects";
import { captureObjectKey } from "@darkview/storage/keys";

import { parseDerivedKey, sweepOrphans, type SweepDependencies } from "@/ops/orphan-sweep";

const NOW = new Date("2026-09-22T12:00:00.000Z");

function derivedKey(kind: "IMAGE" | "THUMBNAIL" | "FITS" | "UNMARKED" = "IMAGE") {
  return captureObjectKey({
    observatoryId: randomUUID(),
    missionId: randomUUID(),
    commandId: randomUUID(),
    kind,
  });
}

function object(key: string, ageHours: number, size = 1000): StoredObject {
  return { key, size, lastModified: new Date(NOW.getTime() - ageHours * 3_600_000) };
}

/** A bucket and a table, in memory, and a record of what the sweep did to them. */
function world(objects: StoredObject[], named: string[] = []) {
  const rows = new Set(named);
  const removed: string[] = [];
  const audited: string[] = [];
  const dependencies: SweepDependencies = {
    list: async function* () {
      yield* objects;
    },
    referenced: async (keys) => new Set(keys.filter((key) => rows.has(key))),
    remove: async (key) => {
      removed.push(key);
    },
    audit: async (stored) => {
      audited.push(stored.key);
    },
    now: NOW,
    graceHours: 24,
  };
  return { dependencies, rows, removed, audited };
}

describe("what counts as an orphan", () => {
  it("is an unreferenced, derived key older than the grace period", async () => {
    const orphan = derivedKey();
    const { dependencies } = world([object(orphan, 48)]);

    const report = await sweepOrphans(dependencies, { remove: false });

    expect(report.orphans.map((each) => each.key)).toEqual([orphan]);
  });

  it("is never a key a capture row names", async () => {
    const kept = derivedKey();
    const { dependencies } = world([object(kept, 48)], [kept]);

    const report = await sweepOrphans(dependencies, { remove: false });

    expect(report.orphans).toEqual([]);
    expect(report.referenced).toBe(1);
  });

  it("is never an object younger than the grace period", async () => {
    const { dependencies } = world([object(derivedKey(), 23)]);

    const report = await sweepOrphans(dependencies, { remove: false });

    expect(report.orphans).toEqual([]);
    expect(report.withinGrace).toBe(1);
  });

  it("is never a key the cloud could not have derived", async () => {
    const strays = [
      "captures/readme.txt",
      `captures/${randomUUID()}/${randomUUID()}/${randomUUID()}/image`,
      `captures/${randomUUID().toUpperCase()}/${randomUUID()}/${randomUUID()}/IMAGE`,
      `captures/${randomUUID()}/${randomUUID()}/${randomUUID()}/IMAGE/extra`,
      "somewhere-else/object",
    ];
    const { dependencies, removed } = world(strays.map((key) => object(key, 500)));

    const report = await sweepOrphans(dependencies, { remove: true });

    expect(report.unrecognised.map((each) => each.key)).toEqual(strays);
    expect(report.orphans).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("recognises every kind the derivation writes", () => {
    for (const kind of ["IMAGE", "THUMBNAIL", "FITS", "UNMARKED"] as const) {
      expect(parseDerivedKey(derivedKey(kind))?.kind).toBe(kind);
    }
  });
});

describe("deleting", () => {
  it("deletes nothing unless asked", async () => {
    const { dependencies, removed, audited } = world([object(derivedKey(), 48)]);

    await sweepOrphans(dependencies, { remove: false });

    expect(removed).toEqual([]);
    expect(audited).toEqual([]);
  });

  it("deletes each orphan and audits each deletion", async () => {
    const first = derivedKey();
    const second = derivedKey("THUMBNAIL");
    const { dependencies, removed, audited } = world([
      object(first, 48),
      object(second, 72),
    ]);

    const report = await sweepOrphans(dependencies, { remove: true });

    expect(removed).toEqual([first, second]);
    expect(audited).toEqual([first, second]);
    expect(report.deleted).toHaveLength(2);
  });

  it("spares an orphan a capture claims between the listing and the delete", async () => {
    const claimed = derivedKey();
    const { dependencies, rows, removed } = world([object(claimed, 48)]);
    const listing = dependencies.referenced;
    let calls = 0;
    dependencies.referenced = async (keys) => {
      calls += 1;
      // The capture is reported after the listing's check and before the delete's.
      if (calls === 2) rows.add(claimed);
      return listing(keys);
    };

    const report = await sweepOrphans(dependencies, { remove: true });

    expect(removed).toEqual([]);
    expect(report.spared.map((each) => each.key)).toEqual([claimed]);
  });

  it("checks a long bucket in batches and misses nothing", async () => {
    const orphans = Array.from({ length: 1234 }, () => derivedKey());
    const { dependencies } = world(orphans.map((key) => object(key, 48)));

    const report = await sweepOrphans(dependencies, { remove: false });

    expect(report.scanned).toBe(1234);
    expect(report.orphans).toHaveLength(1234);
  });
});
