// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { collectPluginMigrationRegistry } from "../generate-plugin-migrations.js";
import { compileAuthoringBackendManifest } from "./backend-manifest.js";
import { isPosixSafePattern } from "./field-value-checks.js";

const FIXTURE_DIR = join(import.meta.dir, "__fixtures__", "rowaccess");

function compileFixture(slug: string) {
  const manifest = compileAuthoringBackendManifest(FIXTURE_DIR, {
    mode: "promote",
    entityAllowlist: [slug],
    schemaByModule: { core: "erp" },
  });
  return { manifest, table: manifest.tables.find((table) => table.source?.authoringEntitySlug === slug)! };
}

describe("authored value contracts reach the database", () => {
  it("renders a numeric default, and keeps the string and boolean branches", () => {
    const { table } = compileFixture("value-contract");
    const byName = new Map(table.columns.map((column) => [column.name, column]));
    expect(byName.get("quantity")).toMatchObject({ type: "numeric", required: true, default: "1" });
    expect(byName.get("status")?.default).toBe("'open'");
  });

  it("fails the build on a default the column cannot carry", () => {
    expect(() => compileFixture("value-contract-bad-default")).toThrow(
      /quantity declares defaultValue "one", which cannot be rendered as a SQL default for numeric column quantity/,
    );
  });

  it("emits a CHECK for static options and POSIX-safe patterns on scalar text columns only", () => {
    const { manifest, table } = compileFixture("value-contract");
    expect(table.constraints).toEqual([
      {
        compilerOwned: true,
        replaceExisting: true,
        version: expect.stringMatching(/^0001_field-options-erp-value-contracts-status-options-check-[0-9a-f]{12}$/),
        name: "value_contracts_status_options_check",
        kind: "check",
        expression: `"status" IN ('open', 'closed')`,
      },
      {
        compilerOwned: true,
        replaceExisting: true,
        version: expect.stringMatching(/^0001_field-pattern-erp-value-contracts-locale-pattern-check-[0-9a-f]{12}$/),
        name: "value_contracts_locale_pattern_check",
        kind: "check",
        expression: `"locale" ~ '^[a-z]{2}(-[A-Z]{2})?$'`,
      },
    ]);
    // The ECMA-only `slug` pattern (a lookahead) and the collection `tags`
    // options are left to the runtime validator.
    expect(table.constraints?.some((constraint) => constraint.name.includes("slug"))).toBe(false);
    expect(table.constraints?.some((constraint) => constraint.name.includes("tags"))).toBe(false);

    // Rendered through the compiler-owned repeatable migration: drop the
    // previous same-name CHECK, add the current one.
    const registry = collectPluginMigrationRegistry(manifest, []);
    const migration = registry.migrations.find((entry) => entry.version.includes("status-options-check"));
    expect(migration).toMatchObject({ plugin: "osf-compiler", repeatable: true });
    expect(migration?.sql).toBe(
      `ALTER TABLE "erp"."value_contracts" DROP CONSTRAINT IF EXISTS "value_contracts_status_options_check";\n` +
      `ALTER TABLE "erp"."value_contracts"\n  ADD CONSTRAINT "value_contracts_status_options_check" CHECK ("status" IN ('open', 'closed'));\n`,
    );
  });

  it("classifies patterns by whether PostgreSQL reads them the way ECMA-262 does", () => {
    for (const safe of ["^[a-z][a-zA-Z0-9]*$", "^[A-Z]{2}[0-9]{2}[A-Z0-9]{4,30}$", "^\\d+(\\.\\d{1,2})?$", "^(foo|bar)$", "^[^@\\s]+@[^@\\s]+$"]) {
      expect(isPosixSafePattern(safe)).toBe(true);
    }
    for (const unsafe of ["^(?!-)[a-z-]+$", "(?<year>\\d{4})", "\\bword\\b", "^\\p{L}+$", "(a)\\1", "^[a-z]+?$", "^\\u00e9$", "[[:alpha:]]", "^(a", "a)b"]) {
      expect(isPosixSafePattern(unsafe)).toBe(false);
    }
  });
});
