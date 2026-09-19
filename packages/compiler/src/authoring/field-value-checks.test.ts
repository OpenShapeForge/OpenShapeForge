// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { collectPluginMigrationRegistry } from "../generate-plugin-migrations.js";
import { renderConstraintSql } from "../render-constraint-sql.js";
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
        version: expect.stringMatching(/^0001_field-options-erp-value-contracts-status-options-check-[0-9a-f]{12}$/),
        name: "value_contracts_status_options_check",
        kind: "check",
        expression: `"status" IN ('open', 'closed')`,
      },
      {
        compilerOwned: true,
        version: expect.stringMatching(/^0001_field-pattern-erp-value-contracts-locale-pattern-check-[0-9a-f]{12}$/),
        name: "value_contracts_locale_pattern_check",
        kind: "check",
        expression: `"locale" ~ '^[a-z]{2}(-[A-Z]{2})?$'`,
      },
      // `{ min: 0, max: 1 }` is still a single value; `--` inside a quoted
      // literal is text, not a SQL comment.
      {
        compilerOwned: true,
        version: expect.stringMatching(/^0001_field-options-erp-value-contracts-segment-options-check-[0-9a-f]{12}$/),
        name: "value_contracts_segment_options_check",
        kind: "check",
        expression: `"segment" IN ('non--food', 'fresh--food')`,
      },
      {
        compilerOwned: true,
        version: expect.stringMatching(/^0001_field-pattern-erp-value-contracts-segment-pattern-check-[0-9a-f]{12}$/),
        name: "value_contracts_segment_pattern_check",
        kind: "check",
        expression: `"segment" ~ '^[a-z]+--[a-z]+$'`,
      },
    ]);
    // The ECMA-only `slug` pattern (a lookahead) and the collection `tags`
    // options are left to the runtime validator.
    expect(table.constraints?.some((constraint) => constraint.name.includes("slug"))).toBe(false);
    expect(table.constraints?.some((constraint) => constraint.name.includes("tags"))).toBe(false);

    // Rendered through the compiler-owned registry as name-guarded DDL; a
    // `--` inside the quoted literal must not be read as a comment.
    const registry = collectPluginMigrationRegistry(manifest, []);
    const migration = registry.migrations.find((entry) => entry.version.includes("segment-options-check"));
    expect(migration).toMatchObject({ plugin: "osf-compiler" });
    expect(migration?.sql).toContain(
      `ADD CONSTRAINT "value_contracts_segment_options_check" CHECK ("segment" IN ('non--food', 'fresh--food'));`,
    );
    expect(migration?.sql).toContain(`AND conname = 'value_contracts_segment_options_check'`);
    expect(registry.migrations.find((entry) => entry.version.includes("segment-pattern-check"))?.sql)
      .toContain(`CHECK ("segment" ~ '^[a-z]+--[a-z]+$');`);
  });

  it("still refuses a terminator or comment outside a quoted span", () => {
    const table = { schema: "erp", name: "value_contracts", tenantScoped: true, columns: [] };
    const check = (expression: string) => () => renderConstraintSql(table as never, {
      compilerOwned: true, version: "0001_x", name: "value_contracts_x_check", kind: "check", expression,
    });
    expect(check(`"segment" = 'a--b'`)).not.toThrow();
    expect(check(`"segment" = 'a' -- b`)).toThrow(/statement terminator or comment/);
    expect(check(`"segment" = 'a'; drop table x`)).toThrow(/statement terminator or comment/);
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
