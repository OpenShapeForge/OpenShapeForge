// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import manifest from "../../generated/db/manifest.json" with { type: "json" };

/**
 * Every pattern CHECK the compiler emits must be one PostgreSQL parses as an
 * advanced regular expression AND reads the way ECMA-262 does, since the
 * runtime validator (ajv) speaks ECMA-262 and the two must agree on a value.
 * Probes are matched on both sides; a disagreement or a parse error fails.
 */
const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const probes = ["", "a", "abc", "ab-cd", "AB12", "NL91ABNA0417164300", "en-GB", "en", "12.50", "x--y", "a b", "_", "@", "é"];

function emittedPatterns(): Array<{ name: string; pattern: string }> {
  return (manifest as { tables: Array<{ constraints?: Array<{ name: string; kind: string; expression: string }> }> }).tables
    .flatMap((table) => table.constraints ?? [])
    .filter((constraint) => constraint.kind === "check" && constraint.name.endsWith("_pattern_check"))
    .map((constraint) => {
      const match = /~ '((?:[^']|'')*)'$/.exec(constraint.expression);
      if (!match) throw new Error(`${constraint.name} is not a pattern CHECK: ${constraint.expression}`);
      return { name: constraint.name, pattern: match[1]!.replaceAll("''", "'") };
    });
}

describe("emitted pattern CHECKs", () => {
  let sql: SQL;
  beforeAll(() => { sql = new SQL(adminUrl, { max: 1 }); });
  afterAll(async () => { await sql?.close(); });

  test("the shipped manifest carries pattern CHECKs", () => {
    expect(emittedPatterns().length).toBeGreaterThan(0);
  });

  for (const { name, pattern } of emittedPatterns()) {
    test(`${name}: PostgreSQL accepts ${pattern} and agrees with ECMA-262 on every probe`, async () => {
      const ecma = new RegExp(pattern, "u");
      for (const probe of probes) {
        const rows = await sql`select ${probe}::text ~ ${pattern}::text as matched`;
        expect({ probe, matched: rows[0].matched }).toEqual({ probe, matched: ecma.test(probe) });
      }
    });
  }
});
