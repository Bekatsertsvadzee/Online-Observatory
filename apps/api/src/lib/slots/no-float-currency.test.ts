import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../..");

/**
 * DV-054 criterion 4: no float currency value exists anywhere.
 *
 * Money is stored and sent in the minor unit of its currency -- tetri for the
 * lari -- as an integer. Never a float, and never a major-unit decimal.
 *
 * This is not fastidiousness. 0.1 + 0.2 is 0.30000000000000004 in binary floating
 * point, so a float price that survives a few additions stops matching what the
 * payment provider says was charged, and the difference has to be reconciled by
 * a human against a bank statement. Integers in the minor unit cannot drift.
 *
 * The guard scans rather than trusts, because the failure appears at settlement
 * rather than at the keyboard.
 */
const MONEY_FIELDS = /(priceMinor|amountMinor|priceTetri|amountTetri)/;

/** The same field bound to something with a decimal point. */
const FLOAT_MONEY = new RegExp(
  `["']?${MONEY_FIELDS.source}["']?\\s*[:=]\\s*[-+]?\\d+\\.\\d`,
);

/** A money-shaped name that is not in minor units at all. */
const MAJOR_UNIT_FIELD =
  /["']?(price|amount|cost|priceGel|amountGel)["']?\s*[:=]\s*[-+]?\d+\.\d/;

const SEARCHED_SUFFIXES = new Set([".ts", ".tsx", ".mjs", ".json", ".yaml", ".prisma", ".sql"]);
const SKIPPED = new Set([".git", ".next", "node_modules", ".venv", "generated", "__pycache__"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (SKIPPED.has(entry)) return [];
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return SEARCHED_SUFFIXES.has(path.extname(full)) ? [full] : [];
  });
}

function offences(pattern: RegExp): string[] {
  return sourceFiles(repositoryRoot).flatMap((file) => {
    const relative = path.relative(repositoryRoot, file);
    if (relative.includes("no-float-currency.test.ts")) return [];

    return readFileSync(file, "utf8")
      .split("\n")
      .map((line, index) => ({ line: index + 1, text: line }))
      .filter(({ text }) => pattern.test(text))
      .map(({ line, text }) => `${relative}:${line}: ${text.trim()}`);
  });
}

describe("currency never becomes a float", () => {
  it("scans the repository, so a pass means something", () => {
    const files = sourceFiles(repositoryRoot);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith("openapi.yaml"))).toBe(true);
    expect(files.some((f) => f.endsWith("schema.prisma"))).toBe(true);
  });

  it("finds no minor-unit field holding a decimal", () => {
    expect(offences(FLOAT_MONEY)).toEqual([]);
  });

  it("finds no major-unit money field holding a decimal", () => {
    expect(offences(MAJOR_UNIT_FIELD)).toEqual([]);
  });

  it("detects the mistake it is meant to catch", () => {
    // Guard the guard: a pattern that matches nothing would pass silently.
    expect(FLOAT_MONEY.test("priceMinor: 45.5")).toBe(true);
    expect(FLOAT_MONEY.test('"amountMinor": -0.5')).toBe(true);
    expect(MAJOR_UNIT_FIELD.test("price = 45.00")).toBe(true);

    expect(FLOAT_MONEY.test("priceMinor: 4500")).toBe(false);
    expect(MAJOR_UNIT_FIELD.test("amountMinor: 4500")).toBe(false);
  });

  it("keeps the money columns integer in the schema", () => {
    const schema = readFileSync(
      path.join(repositoryRoot, "packages/db/prisma/schema.prisma"),
      "utf8",
    );

    for (const line of schema.split("\n")) {
      if (/priceMinor|amountMinor/.test(line)) {
        expect(line, `${line.trim()} must be Int`).toMatch(/\bInt\b/);
      }
    }
  });
});
