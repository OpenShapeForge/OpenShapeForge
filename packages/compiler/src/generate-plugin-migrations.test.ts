// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { CompilerPlugin } from "./plugins.js";
import {
  collectPluginMigrationRegistry,
  renderPluginMigrationRegistry,
} from "./generate-plugin-migrations.js";
import type { PlatformSchemaManifest, TableDefinition } from "./schema.js";

const idColumn = {
  name: "id",
  type: "uuid",
  required: true,
} as const;

function table(
  name: string,
  overrides: Partial<TableDefinition> = {},
): TableDefinition {
  return {
    schema: "cpq",
    name,
    tenantScoped: true,
    columns: [idColumn],
    pluginOwner: "cpq",
    ...overrides,
  };
}

function registry(
  tables: TableDefinition[],
  plugins: CompilerPlugin[] = [{ name: "cpq" }],
) {
  const manifest: PlatformSchemaManifest = { version: 1, tables };
  return collectPluginMigrationRegistry(manifest, plugins);
}

describe("plugin schema migrations", () => {
  test("renders named compound constraints and raw DDL in plugin-local order", () => {
    const result = registry(
      [
        table("requests", {
          columns: [idColumn, { name: "revision", type: "integer", required: true }],
          constraints: [
            {
              version: "0001_request-key",
              name: "requests_id_revision_key",
              kind: "unique",
              columns: ["id", "revision"],
            },
          ],
        }),
      ],
      [
        {
          name: "cpq",
          schemaMigrations: [
            {
              version: "0002_install-trigger",
              sql: "CREATE FUNCTION cpq.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;",
            },
          ],
        },
      ],
    );

    expect(result.migrations.map(({ plugin, version }) => [plugin, version])).toEqual([
      ["cpq", "0001_request-key"],
      ["cpq", "0002_install-trigger"],
    ]);
    expect(result.migrations[0]!.sql).toContain(
      'ADD CONSTRAINT "requests_id_revision_key" UNIQUE ("id", "revision")',
    );
    expect(result.migrations.every((migration) => /^[0-9a-f]{64}$/.test(migration.checksum))).toBe(true);
    expect(JSON.parse(renderPluginMigrationRegistry(result))).toEqual(result);
  });

  test("validates foreign-key targets before emitting SQL", () => {
    expect(() =>
      registry([
        table("lines", {
          constraints: [
            {
              version: "0001_request-fk",
              name: "lines_request_fk",
              kind: "foreignKey",
              columns: ["id"],
              references: { schema: "cpq", table: "missing", columns: ["id"] },
            },
          ],
        }),
      ]),
    ).toThrow(/unknown table cpq\.missing/);
  });

  test("renders deferred compound foreign keys explicitly", () => {
    const result = registry([
      table("requests", {
        constraints: [
          {
            version: "0001_request-key",
            name: "requests_id_key",
            kind: "unique",
            columns: ["id"],
          },
        ],
      }),
      table("lines", {
        constraints: [
          {
            version: "0002_request-fk",
            name: "lines_request_fk",
            kind: "foreignKey",
            columns: ["id"],
            references: { schema: "cpq", table: "requests", columns: ["id"] },
            deferrable: true,
            initiallyDeferred: true,
          },
        ],
      }),
    ]);
    expect(result.migrations[1]!.sql).toContain(
      'REFERENCES "cpq"."requests" ("id") DEFERRABLE INITIALLY DEFERRED',
    );
  });

  test("rejects duplicate versions across constraints and raw DDL", () => {
    expect(() =>
      registry(
        [
          table("requests", {
            constraints: [
              {
                version: "0001_request-check",
                name: "requests_id_check",
                kind: "check",
                expression: "id IS NOT NULL",
              },
            ],
          }),
        ],
        [
          {
            name: "cpq",
            schemaMigrations: [
              { version: "0001_request-check", sql: "SELECT 1;" },
            ],
          },
        ],
      ),
    ).toThrow(/Duplicate plugin schema migration/);
  });

  test("keeps structured checks to one expression", () => {
    expect(() =>
      registry([
        table("requests", {
          constraints: [
            {
              version: "0001_request-check",
              name: "requests_id_check",
              kind: "check",
              expression: "id IS NOT NULL; DROP TABLE cpq.requests",
            },
          ],
        }),
      ]),
    ).toThrow(/Use schemaMigrations for free-form SQL/);

    expect(() =>
      registry([
        table("requests", {
          constraints: [
            {
              version: "0001_request-check",
              name: "requests_id_check",
              kind: "check",
              expression: "id IS NOT NULL), ADD COLUMN backdoor text CHECK (true",
            },
          ],
        }),
      ]),
    ).toThrow(/closes the compiler-owned CHECK expression/);

    expect(() =>
      registry([
        table("requests", {
          constraints: [
            {
              version: "0001_request-check",
              name: "requests_id_check",
              kind: "check",
              expression: "id::text <> ')'",
            },
          ],
        }),
      ]),
    ).not.toThrow();
  });

  test("rejects schema-wide backing-index collisions and multiple primary keys", () => {
    expect(() =>
      registry([
        table("a", {
          constraints: [
            { version: "0001_a-key", name: "shared_key", kind: "unique", columns: ["id"] },
          ],
        }),
        table("b", {
          constraints: [
            { version: "0002_b-key", name: "shared_key", kind: "unique", columns: ["id"] },
          ],
        }),
      ]),
    ).toThrow(/backing index.*collides/);

    expect(() =>
      registry([
        table("requests", {
          columns: [{ ...idColumn, primaryKey: true }],
          constraints: [
            { version: "0001_other-pk", name: "requests_other_pk", kind: "primaryKey", columns: ["id"] },
          ],
        }),
      ]),
    ).toThrow(/multiple primary keys/);
  });

  test("rejects a foreign key ordered before its cross-plugin target key", () => {
    expect(() =>
      registry(
        [
          table("child", {
            pluginOwner: "aaa",
            constraints: [
              {
                version: "0001_parent-fk",
                name: "child_parent_fk",
                kind: "foreignKey",
                columns: ["id"],
                references: { schema: "cpq", table: "parent", columns: ["id"] },
              },
            ],
          }),
          table("parent", {
            pluginOwner: "zzz",
            constraints: [
              { version: "0001_parent-key", name: "parent_id_key", kind: "unique", columns: ["id"] },
            ],
          }),
        ],
        [{ name: "aaa" }, { name: "zzz" }],
      ),
    ).toThrow(/ordered before target key/);
  });

  test("gates raw schema migrations on the shared plugin context", () => {
    const plugin: CompilerPlugin = {
      name: "cpq",
      schemaMigrations: (context) =>
        context.webPresent
          ? [{ version: "0001_web-trigger", sql: "SELECT 1;" }]
          : [],
    };
    const manifest: PlatformSchemaManifest = { version: 1, tables: [] };
    const baseContext = { repoRoot: "/repo", authoringDir: "/repo/authoring" };
    expect(
      collectPluginMigrationRegistry(manifest, [plugin], {
        ...baseContext,
        webPresent: false,
      }).migrations,
    ).toEqual([]);
    expect(
      collectPluginMigrationRegistry(manifest, [plugin], {
        ...baseContext,
        webPresent: true,
      }).migrations.map((migration) => migration.version),
    ).toEqual(["0001_web-trigger"]);
  });

  test("sorts prefixed plugin names tuple-wise for the API loader", () => {
    const result = registry(
      [],
      ["cpq", "cpq-extra"].map((name) => ({
        name,
        schemaMigrations: [
          { version: "0001_install-trigger", sql: `SELECT '${name}';` },
        ],
      })),
    );
    expect(result.migrations.map(({ plugin, version }) => [plugin, version])).toEqual([
      ["cpq", "0001_install-trigger"],
      ["cpq-extra", "0001_install-trigger"],
    ]);
  });
});

// Issue #509. The compiler keys a tenant-scoped table on (tenant_id, id), so
// `id` alone is no longer a key. A hand-written plugin constraint that names it
// alone therefore has nothing to attach to, and must be refused here rather
// than reintroducing an RLS-bypassing cross-tenant reference at migrate time.
describe("plugin foreign keys into tenant-scoped tables", () => {
  const parent = (tenantScoped: boolean): TableDefinition =>
    table("products", {
      tenantScoped,
      columns: [
        { name: "id", type: "uuid", primaryKey: true, required: true },
        { name: "tenant_id", type: "uuid", required: true },
      ],
    });

  const child = (columns: string[], references: string[]): TableDefinition =>
    table("product_lines", {
      columns: [
        { name: "id", type: "uuid", primaryKey: true, required: true },
        { name: "tenant_id", type: "uuid", required: true },
        { name: "product_id", type: "uuid", required: true },
      ],
      constraints: [
        {
          version: "0002_product-lines-product-fkey",
          name: "product_lines_product_id_fkey",
          kind: "foreignKey",
          columns,
          references: { schema: "cpq", table: "products", columns: references },
        },
      ],
    });

  test("refuses a single-column reference to a tenant-scoped identity", () => {
    expect(() => registry([parent(true), child(["product_id"], ["id"])])).toThrow(
      /no matching primary key or unique constraint/,
    );
  });

  test("accepts the tenant-consistent pair", () => {
    const result = registry([
      parent(true),
      child(["tenant_id", "product_id"], ["tenant_id", "id"]),
    ]);
    expect(
      result.migrations.some((migration) =>
        migration.sql.includes('FOREIGN KEY ("tenant_id", "product_id")'),
      ),
    ).toBe(true);
  });

  test("still accepts a single-column reference into a global table", () => {
    const result = registry([parent(false), child(["product_id"], ["id"])]);
    expect(
      result.migrations.some((migration) =>
        migration.sql.includes('FOREIGN KEY ("product_id")'),
      ),
    ).toBe(true);
  });
});
