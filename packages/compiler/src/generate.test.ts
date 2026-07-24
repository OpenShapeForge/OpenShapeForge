import { describe, expect, it } from "bun:test";
import { generateArtifacts } from "./generate.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadManifest } from "./load-manifest.js";
import type { PlatformSchemaManifest } from "./schema.js";

const manifest: PlatformSchemaManifest = {
  version: 1,
  tables: [
    {
      schema: "platform",
      name: "schema_migrations",
      tenantScoped: false,
      columns: [{ name: "version", type: "text", primaryKey: true }],
    },
    {
      schema: "erp",
      name: "cases",
      tenantScoped: true,
      columns: [
        { name: "id", type: "uuid", primaryKey: true, default: "gen_random_uuid()" },
        { name: "tenant_id", type: "uuid", required: true },
        { name: "title", type: "text", required: true },
      ],
      indexes: [
        {
          name: "cases_tenant_title_idx",
          columns: ["tenant_id", "title"],
        },
      ],
    },
  ],
};

describe("platform schema generator", () => {
  it("emits schema-qualified SQL with fail-closed RLS policies", () => {
    const sql = generateArtifacts(manifest).find((artifact) =>
      artifact.path.endsWith("schema.sql"),
    )?.contents;

    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "erp";');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "erp"."cases"');
    expect(sql).toContain('ALTER TABLE "erp"."cases" FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain(
      'USING (app.bypass_rls() OR (tenant_id = app.current_tenant()))',
    );
    expect(sql).toContain(
      'WITH CHECK (app.bypass_rls() OR (tenant_id = app.current_tenant()))',
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "cases_tenant_title_idx" ON "erp"."cases" ("tenant_id", "title");',
    );
  });

  it("emits Kysely DB types without old service surfaces", () => {
    const types = generateArtifacts(manifest).find((artifact) =>
      artifact.path.endsWith("types.ts"),
    )?.contents;

    expect(types).toContain('import type { ColumnType, Generated } from "kysely";');
    expect(types).toContain('"erp.cases": ErpCasesTable;');
    expect(types).toContain("export type DateOnly = ColumnType<string, string | Date, string | Date>;");
    expect(types).toContain("export type Numeric = ColumnType<string, string | number, string | number>;");
    expect(types).not.toContain("/ext/");
    expect(types).not.toContain("/erp/api/graphql");
  });

  it("emits cyclic foreign keys after tables are created", () => {
    const cyclicManifest: PlatformSchemaManifest = {
      version: 1,
      tables: [
        {
          schema: "erp",
          name: "relations",
          tenantScoped: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
            {
              name: "primary_group_id",
              type: "uuid",
              references: { schema: "erp", table: "relation_groups", column: "id" },
            },
          ],
        },
        {
          schema: "erp",
          name: "relation_groups",
          tenantScoped: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
            {
              name: "relation_id",
              type: "uuid",
              references: { schema: "erp", table: "relations", column: "id" },
            },
          ],
        },
      ],
    };
    const sql = generateArtifacts(cyclicManifest).find((artifact) =>
      artifact.path.endsWith("schema.sql"),
    )?.contents ?? "";

    expect(sql).not.toContain('"primary_group_id" uuid REFERENCES');
    expect(sql.indexOf('CREATE TABLE IF NOT EXISTS "erp"."relation_groups"')).toBeLessThan(
      sql.indexOf("-- OpenShapeForge generated foreign keys"),
    );
    expect(sql).toContain('ADD CONSTRAINT "relations_primary_group_id_fkey" FOREIGN KEY ("primary_group_id")');
    expect(sql).toContain('ADD CONSTRAINT "relation_groups_relation_id_fkey" FOREIGN KEY ("relation_id")');
  });

  it("emits multi-axis rowScope policy with OR-combined predicates and supporting indexes", () => {
    const rowScopeManifest: PlatformSchemaManifest = {
      version: 1,
      tables: [
        {
          schema: "erp",
          name: "cases",
          tenantScoped: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
            { name: "org_unit_id", type: "uuid" },
            { name: "assignee_id", type: "uuid" },
            { name: "owner_id", type: "uuid" },
          ],
          rowScope: {
            group: { column: "org_unit_id", expand: "descendants" },
            userColumns: ["assignee_id", "owner_id"],
            bypassRoles: ["Case.TenantAdmin"],
          },
        },
      ],
    };

    const sql =
      generateArtifacts(rowScopeManifest).find((artifact) =>
        artifact.path.endsWith("schema.sql"),
      )?.contents ?? "";

    expect(sql).toContain('CREATE POLICY "cases_row_scope" ON "erp"."cases"');
    expect(sql).toContain("app.bypass_rls() OR (tenant_id = app.current_tenant()");
    expect(sql).toContain("app.has_scope('tenant')");
    expect(sql).toContain('"org_unit_id" = ANY (app.current_groups())');
    expect(sql).toContain('"assignee_id" = app.current_user_id()');
    expect(sql).toContain('"owner_id" = app.current_user_id()');
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "cases_tenant_org_unit_id_idx" ON "erp"."cases" ("tenant_id", "org_unit_id");',
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "cases_tenant_assignee_id_idx" ON "erp"."cases" ("tenant_id", "assignee_id") WHERE "assignee_id" IS NOT NULL;',
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "cases_tenant_owner_id_idx" ON "erp"."cases" ("tenant_id", "owner_id") WHERE "owner_id" IS NOT NULL;',
    );
    // The plain tenant-isolation policy should NOT be emitted alongside the
    // row-scope policy; rowScope subsumes it.
    expect(sql).not.toContain('CREATE POLICY "cases_tenant_isolation"');
  });

  it("fails compile if a rowScope column is missing from the table", () => {
    const badManifest: PlatformSchemaManifest = {
      version: 1,
      tables: [
        {
          schema: "erp",
          name: "cases",
          tenantScoped: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
          ],
          rowScope: {
            group: { column: "org_unit_id" },
          },
        },
      ],
    };

    expect(() => generateArtifacts(badManifest)).toThrow(
      /rowScope.group.column "org_unit_id" but the column is not defined/,
    );
  });

  // ── §F.1 group-axis expand-mode emitter (Phase 2) ──

  const groupModeManifest = (
    expand: "descendants" | "ancestors" | "exact" | undefined,
  ): PlatformSchemaManifest => ({
    version: 1,
    tables: [
      {
        schema: "erp",
        name: "cases",
        tenantScoped: true,
        columns: [
          { name: "id", type: "uuid", primaryKey: true },
          { name: "tenant_id", type: "uuid", required: true },
          { name: "org_unit_id", type: "uuid" },
        ],
        rowScope: {
          group: expand ? { column: "org_unit_id", expand } : { column: "org_unit_id" },
        },
      },
    ],
  });

  const groupModeSql = (
    expand: "descendants" | "ancestors" | "exact" | undefined,
  ): string =>
    generateArtifacts(groupModeManifest(expand)).find((artifact) =>
      artifact.path.endsWith("schema.sql"),
    )?.contents ?? "";

  it("group descendants → = ANY (app.current_groups())", () => {
    const sql = groupModeSql("descendants");
    expect(sql).toContain('"org_unit_id" = ANY (app.current_groups())');
    expect(sql).not.toContain("app.current_groups_exact()");
    expect(sql).not.toContain("app.current_groups_ancestors()");
  });

  it("group expand defaults to descendants when unset → app.current_groups()", () => {
    const sql = groupModeSql(undefined);
    expect(sql).toContain('"org_unit_id" = ANY (app.current_groups())');
    expect(sql).not.toContain("app.current_groups_exact()");
    expect(sql).not.toContain("app.current_groups_ancestors()");
  });

  it("group exact → = ANY (app.current_groups_exact())", () => {
    const sql = groupModeSql("exact");
    expect(sql).toContain('"org_unit_id" = ANY (app.current_groups_exact())');
    // The default descendants reader must NOT be emitted for exact.
    expect(sql).not.toContain("ANY (app.current_groups())");
  });

  it("group ancestors → = ANY (app.current_groups_ancestors())", () => {
    const sql = groupModeSql("ancestors");
    expect(sql).toContain('"org_unit_id" = ANY (app.current_groups_ancestors())');
    expect(sql).not.toContain("ANY (app.current_groups())");
  });

  it("owner + group combined → both predicates OR-joined in one policy", () => {
    const manifest: PlatformSchemaManifest = {
      version: 1,
      tables: [
        {
          schema: "erp",
          name: "cases",
          tenantScoped: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
            { name: "org_unit_id", type: "uuid" },
            { name: "owner_id", type: "uuid" },
          ],
          rowScope: {
            group: { column: "org_unit_id", expand: "descendants" },
            userColumns: ["owner_id"],
          },
        },
      ],
    };
    const sql =
      generateArtifacts(manifest).find((artifact) =>
        artifact.path.endsWith("schema.sql"),
      )?.contents ?? "";
    // Both axes OR-joined inside the tenant-AND group.
    expect(sql).toContain(
      '"org_unit_id" = ANY (app.current_groups()) OR "owner_id" = app.current_user_id()',
    );
  });

  it("group empty:public adds an OR-NULL branch for the group column", () => {
    const manifest: PlatformSchemaManifest = {
      version: 1,
      tables: [
        {
          schema: "erp",
          name: "cases",
          tenantScoped: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
            { name: "org_unit_id", type: "uuid" },
          ],
          rowScope: {
            group: { column: "org_unit_id", expand: "descendants" },
            nullVisibleColumns: ["org_unit_id"],
          },
        },
      ],
    };
    const sql =
      generateArtifacts(manifest).find((artifact) =>
        artifact.path.endsWith("schema.sql"),
      )?.contents ?? "";
    expect(sql).toContain(
      '"org_unit_id" = ANY (app.current_groups()) OR "org_unit_id" IS NULL',
    );
  });

  // ── §F.1 owner-axis OR-NULL emitter (nullVisibleColumns) ──

  it("emits owner axis with OR-NULL branch for empty:public", () => {
    const ownerPublicManifest: PlatformSchemaManifest = {
      version: 1,
      tables: [
        {
          schema: "erp",
          name: "prefs",
          tenantScoped: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
            { name: "owner_id", type: "uuid" },
          ],
          rowScope: {
            userColumns: ["owner_id"],
            nullVisibleColumns: ["owner_id"],
          },
        },
      ],
    };

    const sql =
      generateArtifacts(ownerPublicManifest).find((artifact) =>
        artifact.path.endsWith("schema.sql"),
      )?.contents ?? "";

    expect(sql).toContain('CREATE POLICY "prefs_row_scope" ON "erp"."prefs"');
    // The exact OR-NULL predicate from §B.2.
    expect(sql).toContain(
      '"owner_id" = app.current_user_id() OR "owner_id" IS NULL',
    );
    expect(sql).not.toContain('CREATE POLICY "prefs_tenant_isolation"');
  });

  it("emits owner axis WITHOUT OR-NULL branch for empty:restricted", () => {
    const ownerRestrictedManifest: PlatformSchemaManifest = {
      version: 1,
      tables: [
        {
          schema: "erp",
          name: "prefs",
          tenantScoped: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
            { name: "owner_id", type: "uuid" },
          ],
          rowScope: {
            userColumns: ["owner_id"],
          },
        },
      ],
    };

    const sql =
      generateArtifacts(ownerRestrictedManifest).find((artifact) =>
        artifact.path.endsWith("schema.sql"),
      )?.contents ?? "";

    expect(sql).toContain('"owner_id" = app.current_user_id()');
    // No OR-NULL branch — NULL-owner rows are hidden.
    expect(sql).not.toContain('"owner_id" IS NULL');
  });

  it("fails compile if a nullVisibleColumns column is missing from the table", () => {
    const badNullManifest: PlatformSchemaManifest = {
      version: 1,
      tables: [
        {
          schema: "erp",
          name: "prefs",
          tenantScoped: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
            { name: "owner_id", type: "uuid" },
          ],
          rowScope: {
            userColumns: ["owner_id"],
            nullVisibleColumns: ["nope"],
          },
        },
      ],
    };

    expect(() => generateArtifacts(badNullManifest)).toThrow(
      /rowScope.nullVisibleColumns "nope" but the column is not defined/,
    );
  });

  it("determinism: the 3 shipped entities emit plain tenant-wide policies with bypass support", () => {
    // The committed generated schema.sql is the source of truth. The 3 shipped
    // entities declare rowAccess { enabled: true, empty: public } with no owner
    // and no group → deriveRowScope returns undefined → the emitter must take
    // the plain tenant-isolation branch. If any owner/nullVisible plumbing
    // leaked into these tables this assertion fails.
    const schemaSql = readFileSync(
      join(import.meta.dir, "../../../apps/api/src/generated/db/schema.sql"),
      "utf8",
    );

    for (const table of ["relations", "relation_groups", "contact_details"]) {
      expect(schemaSql).toContain(
        `CREATE POLICY "${table}_tenant_isolation" ON "erp"."${table}"`,
      );
      expect(schemaSql).toContain(
        `DROP POLICY IF EXISTS "${table}_tenant_isolation" ON "erp"."${table}";`,
      );
      // The row-scope policy variant must NOT be present for these tables.
      expect(schemaSql).not.toContain(
        `CREATE POLICY "${table}_row_scope" ON "erp"."${table}"`,
      );
      expect(schemaSql).toContain(
        `CREATE POLICY "${table}_tenant_isolation" ON "erp"."${table}"\n  USING (app.bypass_rls() OR (tenant_id = app.current_tenant()))\n  WITH CHECK (app.bypass_rls() OR (tenant_id = app.current_tenant()));`,
      );
    }
  });

  it("emits generated CRUD exposure metadata and closes domain internals", () => {
    const metadataManifest: PlatformSchemaManifest = {
      version: 1,
      tables: [
        {
          schema: "messaging",
          name: "mail_accounts",
          tenantScoped: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
          ],
        },
        {
          schema: "messaging",
          name: "mail_account_credentials",
          tenantScoped: true,
          domainInternal: true,
          generatedCrud: false,
          columns: [
            { name: "account_id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
            { name: "credentials_ciphertext", type: "text" },
          ],
        },
      ],
    };
    const manifestJson = generateArtifacts(metadataManifest).find((artifact) =>
      artifact.path.endsWith("manifest.json"),
    )?.contents;
    const manifestPayload = JSON.parse(manifestJson ?? "{}") as {
      tables: Array<{
        name: string;
        generatedCrud: boolean;
        domainInternal: boolean;
        primaryKey: string | null;
      }>;
    };

    expect(manifestPayload.tables).toContainEqual(
      expect.objectContaining({
        name: "messaging.mail_accounts",
        generatedCrud: true,
        domainInternal: false,
        primaryKey: "id",
      }),
    );
    expect(manifestPayload.tables).toContainEqual(
      expect.objectContaining({
        name: "messaging.mail_account_credentials",
        generatedCrud: false,
        domainInternal: true,
        primaryKey: "account_id",
      }),
    );
  });

  it("emits MCP capability metadata for generated entities", () => {
    const metadataManifest: PlatformSchemaManifest = {
      version: 1,
      tables: [
        {
          schema: "erp",
          name: "label_rules",
          tenantScoped: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
            { name: "name", type: "text", required: true, sourceField: "name" },
          ],
          source: {
            authoringEntitySlug: "label-rule",
            graphql: {
              typeName: "LabelRule",
              singleQueryName: "labelRule",
              listQueryName: "labelRules",
              createMutationName: "createLabelRule",
              updateMutationName: "updateLabelRule",
              deleteMutationName: "deleteLabelRule",
              relationships: [],
            },
          },
        },
        {
          schema: "messaging",
          name: "mail_account_credentials",
          tenantScoped: true,
          domainInternal: true,
          generatedCrud: false,
          columns: [
            { name: "account_id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
          ],
        },
      ],
    };
    const manifestJson = generateArtifacts(metadataManifest).find((artifact) =>
      artifact.path.endsWith("manifest.json"),
    )?.contents;
    const manifestPayload = JSON.parse(manifestJson ?? "{}") as {
      capabilities: {
        generatedEntities: Array<{
          slug: string;
          table: string;
          tenantScoped: boolean;
          primaryKey: string;
          graphql: {
            typeName: string;
            singleQueryName: string;
            listQueryName: string;
            createMutationName: string;
            updateMutationName: string;
            deleteMutationName: string;
          };
          fields: Array<{
            field: string;
            column: string;
            type: string;
            required: boolean;
            primaryKey: boolean;
          }>;
        }>;
      };
    };

    expect(manifestPayload.capabilities.generatedEntities).toEqual([
      {
        slug: "label-rule",
        table: "erp.label_rules",
        tenantScoped: true,
        primaryKey: "id",
        graphql: {
          typeName: "LabelRule",
          singleQueryName: "labelRule",
          listQueryName: "labelRules",
          createMutationName: "createLabelRule",
          updateMutationName: "updateLabelRule",
          deleteMutationName: "deleteLabelRule",
        },
        fields: [
          { field: "id", column: "id", type: "uuid", required: true, primaryKey: true },
          { field: "tenantId", column: "tenant_id", type: "uuid", required: true, primaryKey: false },
          { field: "name", column: "name", type: "text", required: true, primaryKey: false },
        ],
      },
    ]);
  });

  it("emits compiler-owned retention metadata without changing SQL output", () => {
    const metadataManifest: PlatformSchemaManifest = {
      version: 1,
      tables: [
        {
          schema: "erp",
          name: "cases",
          tenantScoped: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
            { name: "closed_at", type: "timestamptz" },
            { name: "registered_at", type: "timestamptz", required: true },
          ],
          retention: {
            clock: {
              column: "closed_at",
              fallbackColumns: ["registered_at"],
            },
            rules: [
              {
                id: "delete_closed_cases_after_7_years",
                after: { years: 7 },
                action: "delete",
                reason: "Reference assumption pending migrated compiler catalog policy.",
              },
            ],
            source: "compiler-retention-catalog",
          },
        },
      ],
    };
    const artifacts = generateArtifacts(metadataManifest);
    const sql = artifacts.find((artifact) => artifact.path.endsWith("schema.sql"))?.contents;
    const manifestJson = artifacts.find((artifact) =>
      artifact.path.endsWith("manifest.json"),
    )?.contents;
    const manifestPayload = JSON.parse(manifestJson ?? "{}") as {
      tables: Array<{
        name: string;
        retention?: {
          clock: { column: string; fallbackColumns?: string[] };
          rules: Array<{ id: string; after: { years: number }; action: string }>;
        };
      }>;
    };

    expect(sql).not.toContain("retention");
    expect(manifestPayload.tables).toContainEqual(
      expect.objectContaining({
        name: "erp.cases",
        retention: {
          clock: {
            column: "closed_at",
            fallbackColumns: ["registered_at"],
          },
          rules: [
            expect.objectContaining({
              id: "delete_closed_cases_after_7_years",
              after: { years: 7 },
              action: "delete",
            }),
          ],
          source: "compiler-retention-catalog",
        },
      }),
    );
  });

  it("rejects cross-module foreign keys that are not in the relationship register", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openshapeforge-service-compiler-"));
    const path = join(dir, "schema.yaml");
    await writeFile(
      path,
      `
version: 1
tables:
  - schema: erp
    name: cases
    tenantScoped: true
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
  - schema: messaging
    name: conversations
    tenantScoped: true
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
      - { name: case_id, type: uuid, references: { schema: erp, table: cases, column: id } }
`,
      "utf8",
    );

    try {
      await expect(loadManifest(path)).rejects.toThrow(/relationshipRegister/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("allows registered cross-module foreign keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openshapeforge-service-compiler-"));
    const path = join(dir, "schema.yaml");
    await writeFile(
      path,
      `
version: 1
relationshipRegister:
  - from: { schema: messaging, table: conversations, column: case_id }
    to: { schema: erp, table: cases, column: id }
tables:
  - schema: erp
    name: cases
    tenantScoped: true
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
  - schema: messaging
    name: conversations
    tenantScoped: true
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
      - { name: case_id, type: uuid, references: { schema: erp, table: cases, column: id } }
`,
      "utf8",
    );

    try {
      await expect(loadManifest(path)).resolves.toMatchObject({
        relationshipRegister: [
          {
            from: { schema: "messaging", table: "conversations", column: "case_id" },
            to: { schema: "erp", table: "cases", column: "id" },
          },
        ],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects retention clocks that reference unknown columns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openshapeforge-service-compiler-"));
    const path = join(dir, "schema.yaml");
    await writeFile(
      path,
      `
version: 1
tables:
  - schema: erp
    name: cases
    tenantScoped: true
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
      - { name: created_at, type: timestamptz, required: true }
    retention:
      clock: { column: closed_at, fallbackColumns: [created_at] }
      rules:
        - { id: delete_after_7_years, after: { years: 7 }, action: delete }
`,
      "utf8",
    );

    try {
      await expect(loadManifest(path)).rejects.toThrow(/retention\.clock\.column/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects retention clocks that reference non-timestamp columns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openshapeforge-service-compiler-"));
    const path = join(dir, "schema.yaml");
    await writeFile(
      path,
      `
version: 1
tables:
  - schema: messaging
    name: conversations
    tenantScoped: true
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
      - { name: status, type: text, required: true }
      - { name: created_at, type: timestamptz, required: true }
    retention:
      clock: { column: status, fallbackColumns: [created_at] }
      rules:
        - { id: delete_after_2_years, after: { years: 2 }, action: delete }
`,
      "utf8",
    );

    try {
      await expect(loadManifest(path)).rejects.toThrow(/timestamptz/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects retention fallback clocks that reference non-timestamp columns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openshapeforge-service-compiler-"));
    const path = join(dir, "schema.yaml");
    await writeFile(
      path,
      `
version: 1
tables:
  - schema: erp
    name: cases
    tenantScoped: true
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
      - { name: closed_at, type: timestamptz }
      - { name: status, type: text, required: true }
    retention:
      clock: { column: closed_at, fallbackColumns: [status] }
      rules:
        - { id: delete_after_7_years, after: { years: 7 }, action: delete }
`,
      "utf8",
    );

    try {
      await expect(loadManifest(path)).rejects.toThrow(/fallbackColumns.*timestamptz/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects relationship register entries that do not match real columns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openshapeforge-service-compiler-"));
    const path = join(dir, "schema.yaml");
    await writeFile(
      path,
      `
version: 1
relationshipRegister:
  - from: { schema: messaging, table: conversations, column: missing_case_id }
    to: { schema: erp, table: cases, column: id }
tables:
  - schema: erp
    name: cases
    tenantScoped: true
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
  - schema: messaging
    name: conversations
    tenantScoped: true
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
      - { name: case_id, type: uuid }
`,
      "utf8",
    );

    try {
      await expect(loadManifest(path)).rejects.toThrow(/relationshipRegister/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects domain-internal tables that enable generated CRUD", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openshapeforge-service-compiler-"));
    const path = join(dir, "schema.yaml");
    await writeFile(
      path,
      `
version: 1
tables:
  - schema: messaging
    name: mail_account_credentials
    tenantScoped: true
    domainInternal: true
    generatedCrud: true
    columns:
      - { name: account_id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
`,
      "utf8",
    );

    try {
      await expect(loadManifest(path)).rejects.toThrow(/Domain-internal table/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads a rowScope declaration from YAML and validates referenced columns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openshapeforge-service-compiler-"));
    const path = join(dir, "schema.yaml");
    await writeFile(
      path,
      `
version: 1
tables:
  - schema: erp
    name: cases
    tenantScoped: true
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
      - { name: org_unit_id, type: uuid }
      - { name: assignee_id, type: uuid }
    rowScope:
      group: { column: org_unit_id, expand: descendants }
      userColumns: [assignee_id]
      bypassRoles: [Case.TenantAdmin]
`,
      "utf8",
    );

    try {
      const manifest = await loadManifest(path);
      expect(manifest.tables[0]?.rowScope).toEqual({
        group: { column: "org_unit_id", expand: "descendants" },
        userColumns: ["assignee_id"],
        bypassRoles: ["Case.TenantAdmin"],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a YAML rowScope that references unknown columns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openshapeforge-service-compiler-"));
    const path = join(dir, "schema.yaml");
    await writeFile(
      path,
      `
version: 1
tables:
  - schema: erp
    name: cases
    tenantScoped: true
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
    rowScope:
      group: { column: org_unit_id }
`,
      "utf8",
    );

    try {
      await expect(loadManifest(path)).rejects.toThrow(/unknown column org_unit_id/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a YAML rowScope on a non-tenant-scoped table", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openshapeforge-service-compiler-"));
    const path = join(dir, "schema.yaml");
    await writeFile(
      path,
      `
version: 1
tables:
  - schema: platform
    name: reference_codes
    tenantScoped: false
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: org_unit_id, type: uuid }
    rowScope:
      group: { column: org_unit_id }
`,
      "utf8",
    );

    try {
      await expect(loadManifest(path)).rejects.toThrow(/requires tenantScoped: true/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
