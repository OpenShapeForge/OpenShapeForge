// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { generateArtifacts, WORKER_DATABASE_ROLE } from "./generate.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadManifest } from "./load-manifest.js";
import type { PlatformSchemaManifest, TableDefinition } from "./schema.js";

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

  it("escapes embedded double-quotes in quoted identifiers", () => {
    // Defense-in-depth: even if a hostile identifier reaches the generator
    // (the primary guard is the authoring-layer allowlist), quoteIdent must
    // double embedded double-quotes so the emitted SQL stays well-formed and
    // cannot break out of the quoted-identifier syntax.
    const hostileManifest: PlatformSchemaManifest = {
      version: 1,
      tables: [
        {
          schema: "erp",
          name: "cases",
          tenantScoped: false,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: 'a"b', type: "text" },
          ],
        },
      ],
    };

    const sql = generateArtifacts(hostileManifest).find((artifact) =>
      artifact.path.endsWith("schema.sql"),
    )?.contents;

    // The double-quote inside the identifier is doubled, not passed through raw.
    expect(sql).toContain('"a""b"');
    expect(sql).not.toContain('"a"b"');
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

  // ── worker axis (#218, #223) ──
  //
  // The one axis that WIDENS. `workerAccess` admits a named worker role across
  // tenants on the table that declares it, so a queue-draining worker reads the
  // queue because a policy says so rather than by setting app.bypass_rls, which
  // is all-or-nothing over every tenant-scoped table in the manifest.
  //
  // #223 made the disjunct check the CONNECTED ROLE and not only the GUC. The
  // GUC is set by whoever holds the connection, so on its own it authenticated
  // nothing; `current_user` is a fact about the connection. The GUC stays as an
  // AND so two plugins' workers, sharing one login role, keep their separate
  // queues.

  const workerAccessManifest = (
    workerAccess: string | undefined,
    extra: Partial<PlatformSchemaManifest["tables"][number]> = {},
  ): PlatformSchemaManifest => ({
    version: 1,
    tables: [
      {
        schema: "workflow",
        name: "control_commands",
        tenantScoped: true,
        columns: [
          { name: "id", type: "uuid", primaryKey: true },
          { name: "tenant_id", type: "uuid", required: true },
          { name: "owner_id", type: "uuid" },
        ],
        ...(workerAccess === undefined ? {} : { workerAccess }),
        ...extra,
      },
    ],
  });

  const schemaSqlFor = (manifest: PlatformSchemaManifest): string =>
    generateArtifacts(manifest).find((artifact) => artifact.path.endsWith("schema.sql"))
      ?.contents ?? "";

  const workerDisjunct = (role: string) =>
    `(current_user = '${WORKER_DATABASE_ROLE}' AND app.current_worker_role() = '${role}')`;

  it("emits the worker-role disjunct on the plain tenant-isolation policy", () => {
    const sql = schemaSqlFor(workerAccessManifest("workflow-worker"));

    const predicate = `app.bypass_rls() OR ${workerDisjunct("workflow-worker")} OR (tenant_id = app.current_tenant())`;
    expect(sql).toContain(
      `CREATE POLICY "control_commands_tenant_isolation" ON "workflow"."control_commands"\n  USING (${predicate})\n  WITH CHECK (${predicate});`,
    );
  });

  it("names the connected role, so the GUC alone can no longer claim the queue", () => {
    // The #223 property, asserted as a shape rather than as a substring: the
    // GUC comparison must never appear without the role comparison AND-ed to
    // it, or a session that can set a GUC is back to being a worker.
    const sql = schemaSqlFor(workerAccessManifest("workflow-worker"));

    const gucOccurrences = sql.split("app.current_worker_role()").length - 1;
    const pairedOccurrences = sql.split(workerDisjunct("workflow-worker")).length - 1;
    expect(gucOccurrences).toBeGreaterThan(0);
    expect(pairedOccurrences).toBe(gucOccurrences);
  });

  it("emits the worker-role disjunct on the rowScope policy too", () => {
    // Both branches or neither: a table must not be able to declare workerAccess
    // and silently lose it by also declaring rowScope.
    const sql = schemaSqlFor(
      workerAccessManifest("workflow-worker", { rowScope: { userColumns: ["owner_id"] } }),
    );

    const predicate = `app.bypass_rls() OR ${workerDisjunct("workflow-worker")} OR (tenant_id = app.current_tenant() AND ("owner_id" = app.current_user_id()))`;
    expect(sql).toContain(
      `CREATE POLICY "control_commands_row_scope" ON "workflow"."control_commands"\n  USING (${predicate})\n  WITH CHECK (${predicate});`,
    );
  });

  it("emits today's two-way predicate, byte for byte, for a table without workerAccess", () => {
    // The assertion that matters: this feature must not perturb any table that
    // did not ask for it. Same manifest, field absent — the emitted SQL has to
    // be identical to what the emitter produced before the field existed.
    const sql = schemaSqlFor(workerAccessManifest(undefined));

    const predicate = "app.bypass_rls() OR (tenant_id = app.current_tenant())";
    expect(sql).toContain(
      `CREATE POLICY "control_commands_tenant_isolation" ON "workflow"."control_commands"\n  USING (${predicate})\n  WITH CHECK (${predicate});`,
    );
    expect(sql).not.toContain("app.current_worker_role()");
    expect(sql).not.toContain("current_user");
  });

  it("escapes a single quote in a worker role name", () => {
    const sql = schemaSqlFor(workerAccessManifest("worker's-role"));

    expect(sql).toContain("app.current_worker_role() = 'worker''s-role'");
  });

  it("publishes the worker login role in the manifest, so provisioning cannot drift", () => {
    // apps/api provisions the role by reading this. A role the policies name
    // and nothing creates fails silently — the queue simply reads as empty —
    // so the name is emitted once and consumed, never retyped.
    const manifestJson = JSON.parse(
      generateArtifacts(workerAccessManifest("workflow-worker")).find((artifact) =>
        artifact.path.endsWith("manifest.json"),
      )!.contents,
    ) as { workerDatabaseRole: string; tables: Array<Record<string, unknown>> };

    expect(manifestJson.workerDatabaseRole).toBe(WORKER_DATABASE_ROLE);
    expect(
      schemaSqlFor(workerAccessManifest("workflow-worker")),
    ).toContain(`current_user = '${manifestJson.workerDatabaseRole}'`);
  });

  it("publishes workerAccess and the workerDml it implies", () => {
    // The grant sweep reads both off the manifest. `workerAccess` implying
    // `workerDml` is what stops a queue table from being widened for a role
    // that was never granted the table.
    const manifestJson = JSON.parse(
      generateArtifacts(workerAccessManifest("workflow-worker")).find((artifact) =>
        artifact.path.endsWith("manifest.json"),
      )!.contents,
    ) as { tables: Array<{ workerAccess?: string; workerDml?: boolean }> };

    expect(manifestJson.tables[0]?.workerAccess).toBe("workflow-worker");
    expect(manifestJson.tables[0]?.workerDml).toBe(true);
  });

  it("publishes workerDml on a table that declares it alone, and emits no policy change", () => {
    // workerDml is a GRANT, not a widening — including on a global table, where
    // there is no policy at all and the grant is the only gate there is.
    const artifacts = generateArtifacts({
      version: 1,
      tables: [
        {
          schema: "platform",
          name: "workflow_node_catalog_entries",
          tenantScoped: false,
          columns: [{ name: "node_type", type: "text", primaryKey: true }],
          workerDml: true,
        },
      ],
    });
    const sql = artifacts.find((artifact) => artifact.path.endsWith("schema.sql"))!.contents;
    const manifestJson = JSON.parse(
      artifacts.find((artifact) => artifact.path.endsWith("manifest.json"))!.contents,
    ) as { tables: Array<{ workerDml?: boolean }> };

    expect(manifestJson.tables[0]?.workerDml).toBe(true);
    expect(sql).not.toContain("CREATE POLICY");
    expect(sql).not.toContain("current_worker_role");
  });

  it("rejects a workerDml that is a role name rather than a boolean", () => {
    // The plausible mistake is writing it by analogy with workerAccess. A
    // truthy string would be silently accepted by every `=== true` check that
    // matters, so it is refused at the emitter.
    expect(() =>
      generateArtifacts(
        workerAccessManifest(undefined, {
          workerDml: "workflow-worker" as unknown as boolean,
        }),
      ),
    ).toThrow(/declares workerDml "workflow-worker", which is not a boolean/);
  });

  it("rejects workerAccess on a table that is not tenantScoped", () => {
    // A global table has no tenant predicate to widen, so the declaration would
    // read as a grant while granting nothing.
    const globalManifest: PlatformSchemaManifest = {
      version: 1,
      tables: [
        {
          schema: "platform",
          name: "node_catalog",
          tenantScoped: false,
          columns: [{ name: "id", type: "text", primaryKey: true }],
          workerAccess: "workflow-worker",
        },
      ],
    };

    expect(() => generateArtifacts(globalManifest)).toThrow(
      /declares workerAccess "workflow-worker" but is not tenantScoped/,
    );
  });

  it("rejects an empty workerAccess", () => {
    expect(() => generateArtifacts(workerAccessManifest("  "))).toThrow(
      /declares an empty workerAccess/,
    );
  });

  // ── tenant registry (#289) ──
  //
  // The one policy on a table that is NOT tenantScoped. `platform.tenants`
  // cannot be tenant-scoped — the row IS the tenant — but it is cross-tenant
  // data sitting in a schema the restricted runtime role holds blanket DML on,
  // so "no policy" is the wrong default for it.

  const registryManifest = (
    tenantIdentityColumn: string | undefined,
    extra: Partial<PlatformSchemaManifest["tables"][number]> = {},
  ): PlatformSchemaManifest => ({
    version: 1,
    tables: [
      {
        schema: "platform",
        name: "tenants",
        tenantScoped: false,
        columns: [
          { name: "id", type: "uuid", primaryKey: true },
          { name: "slug", type: "text", required: true },
        ],
        ...(tenantIdentityColumn === undefined ? {} : { tenantIdentityColumn }),
        ...extra,
      },
    ],
  });

  it("emits a self-read, bypass-write policy for a tenant registry", () => {
    const sql = schemaSqlFor(registryManifest("id"));

    expect(sql).toContain('ALTER TABLE "platform"."tenants" ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE "platform"."tenants" FORCE ROW LEVEL SECURITY;');
    // Asymmetric on purpose: a tenant session may read the row that IS its own
    // tenant, and may write nothing. Writes go through withSystemSession, which
    // sets app.bypass_rls and audits the invocation.
    expect(sql).toContain(
      'CREATE POLICY "tenants_tenant_registry" ON "platform"."tenants"\n' +
        '  USING (app.bypass_rls() OR ("id" = app.current_tenant()))\n' +
        "  WITH CHECK (app.bypass_rls());",
    );
  });

  it("emits no policy for a global table without tenantIdentityColumn", () => {
    // The configuration catalogs are identical for every tenant and have
    // nothing to fence; this feature must not start policing them.
    const sql = schemaSqlFor(registryManifest(undefined));

    expect(sql).not.toContain("ROW LEVEL SECURITY");
    expect(sql).not.toContain("CREATE POLICY");
  });

  it("rejects tenantIdentityColumn on a tenantScoped table", () => {
    // Both would answer "which tenant owns this row", and they would not agree.
    expect(() =>
      generateArtifacts(
        registryManifest("id", {
          tenantScoped: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
          ],
        }),
      ),
    ).toThrow(/declares tenantIdentityColumn "id" but is tenantScoped/);
  });

  it("rejects a tenantIdentityColumn that is not a column of the table", () => {
    expect(() => generateArtifacts(registryManifest("tenant_id"))).toThrow(
      /declares tenantIdentityColumn "tenant_id" but the column is not defined/,
    );
  });

  it("rejects an empty tenantIdentityColumn", () => {
    expect(() => generateArtifacts(registryManifest("  "))).toThrow(
      /declares an empty tenantIdentityColumn/,
    );
  });

  it("determinism: the shipped tenant registry is RLS-protected", () => {
    // The committed generated schema.sql is the source of truth. If
    // platform.tenants ever loses this policy, the cross-tenant registry is
    // readable in full by any raw-SQL path a tenant session can reach.
    const schemaSql = readFileSync(
      join(import.meta.dir, "../../../apps/api/src/generated/db/schema.sql"),
      "utf8",
    );

    expect(schemaSql).toContain('ALTER TABLE "platform"."tenants" FORCE ROW LEVEL SECURITY;');
    expect(schemaSql).toContain(
      'CREATE POLICY "tenants_tenant_registry" ON "platform"."tenants"\n' +
        '  USING (app.bypass_rls() OR ("id" = app.current_tenant()))\n' +
        "  WITH CHECK (app.bypass_rls());",
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
          generatedCrud: true,
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
        {
          schema: "messaging",
          name: "legacy_inconsistent_entities",
          tenantScoped: true,
          generatedCrudEligible: false,
          generatedCrud: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
          ],
        },
        {
          schema: "messaging",
          name: "partial_policy_entities",
          tenantScoped: true,
          generatedCrudEligible: true,
          generatedCrud: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
          ],
          source: {
            crud: {
              operations: {
                list: true,
                get: true,
                create: false,
                update: false,
                delete: false,
              },
            },
          },
        },
        {
          schema: "messaging",
          name: "malformed_plugin_policy_entities",
          tenantScoped: true,
          generatedCrudEligible: true,
          generatedCrud: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
          ],
          // A JS or bare-package plugin can bypass the authoring schema and
          // contribute this malformed shape. Serialization must fail closed.
          source: { crud: {} } as unknown as NonNullable<TableDefinition["source"]>,
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
        generatedCrudEligible: boolean;
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
    expect(manifestPayload.tables).toContainEqual(
      expect.objectContaining({
        name: "messaging.legacy_inconsistent_entities",
        generatedCrudEligible: false,
        generatedCrud: false,
      }),
    );
    expect(manifestPayload.tables).toContainEqual(
      expect.objectContaining({
        name: "messaging.partial_policy_entities",
        generatedCrudEligible: true,
        generatedCrud: false,
      }),
    );
    expect(manifestPayload.tables).toContainEqual(
      expect.objectContaining({
        name: "messaging.malformed_plugin_policy_entities",
        generatedCrudEligible: true,
        generatedCrud: false,
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
          generatedCrud: true,
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

  it("rejects a non-uuid tenantIdentityColumn", async () => {
    // app.current_tenant() returns uuid, so the comparison in the emitted
    // policy would not even typecheck at the database — better to fail the
    // build than ship a policy that errors on first evaluation.
    const dir = await mkdtemp(join(tmpdir(), "openshapeforge-service-compiler-"));
    const path = join(dir, "schema.yaml");
    await writeFile(
      path,
      `
version: 1
tables:
  - schema: platform
    name: tenants
    tenantScoped: false
    tenantIdentityColumn: slug
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: slug, type: text, required: true }
`,
      "utf8",
    );

    try {
      await expect(loadManifest(path)).rejects.toThrow(
        /tenantIdentityColumn "slug" must be uuid/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects tenantIdentityColumn on a tenant-scoped table at load time", async () => {
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
    tenantIdentityColumn: id
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
`,
      "utf8",
    );

    try {
      await expect(loadManifest(path)).rejects.toThrow(
        /tenantIdentityColumn requires tenantScoped: false/,
      );
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

  it("accepts a date-typed retention clock (business-date anchor)", async () => {
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
      - { name: contract_end_date, type: date, required: true }
    retention:
      clock: { column: contract_end_date }
      rules:
        - { id: delete_after_7_years, after: { years: 7 }, action: delete }
`,
      "utf8",
    );

    try {
      const loaded = await loadManifest(path);
      const table = loaded.tables.find((entry) => entry.name === "cases");
      expect(table?.retention?.clock).toEqual({
        column: "contract_end_date",
        type: "date",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("carries legal hold, review gate, disposition, crypto-delete, and erasure metadata through the manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openshapeforge-service-compiler-"));
    const path = join(dir, "schema.yaml");
    await writeFile(
      path,
      `
version: 1
relationshipRegister:
  - from: { schema: erp, table: contact_details, column: relation_id }
    to: { schema: erp, table: relations, column: id }
tables:
  - schema: erp
    name: relations
    tenantScoped: true
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
      - { name: closed_at, type: timestamptz }
    retention:
      clock: { column: closed_at }
      rules:
        - id: crypto_erase_after_7_years
          after: { years: 7 }
          action: redact
          disposition: cryptoDelete
          review: { required: true, queue: privacy-review }
          cryptoDelete: { keyReference: subject-key }
      legalHold: { suspendDestruction: true }
      erasure:
        subjectScoped: true
        subjectColumns: [id]
        cascades:
          - { schema: erp, table: contact_details, via: relation_id }
  - schema: erp
    name: contact_details
    tenantScoped: true
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
      - { name: relation_id, type: uuid, references: { schema: erp, table: relations, column: id } }
`,
      "utf8",
    );

    try {
      const loaded = await loadManifest(path);
      const relations = loaded.tables.find((entry) => entry.name === "relations");
      expect(relations?.retention?.legalHold).toEqual({ suspendDestruction: true });
      expect(relations?.retention?.rules[0]).toMatchObject({
        disposition: "cryptoDelete",
        review: { required: true, queue: "privacy-review" },
        cryptoDelete: { keyReference: "subject-key" },
      });
      expect(relations?.retention?.erasure).toEqual({
        subjectScoped: true,
        subjectColumns: ["id"],
        cascades: [{ schema: "erp", table: "contact_details", via: "relation_id" }],
      });
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

  it("loads a workerAccess declaration from YAML", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openshapeforge-service-compiler-"));
    const path = join(dir, "schema.yaml");
    await writeFile(
      path,
      `
version: 1
tables:
  - schema: workflow
    name: control_commands
    tenantScoped: true
    workerAccess: workflow-worker
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
`,
      "utf8",
    );

    try {
      const manifest = await loadManifest(path);
      expect(manifest.tables[0]?.workerAccess).toBe("workflow-worker");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads a workerDml declaration from YAML, including on a global table", async () => {
    // Unlike workerAccess it widens nothing, so a global table may declare it —
    // and must be able to, since a global table has no policy and the grant is
    // its only gate.
    const dir = await mkdtemp(join(tmpdir(), "openshapeforge-service-compiler-"));
    const path = join(dir, "schema.yaml");
    await writeFile(
      path,
      `
version: 1
tables:
  - schema: platform
    name: workflow_node_catalog_entries
    tenantScoped: false
    workerDml: true
    columns:
      - { name: node_type, type: text, primaryKey: true }
`,
      "utf8",
    );

    try {
      const manifest = await loadManifest(path);
      expect(manifest.tables[0]?.workerDml).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a YAML workerDml that names a role instead of saying true", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openshapeforge-service-compiler-"));
    const path = join(dir, "schema.yaml");
    await writeFile(
      path,
      `
version: 1
tables:
  - schema: workflow
    name: instances
    tenantScoped: true
    workerDml: workflow-worker
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
`,
      "utf8",
    );

    try {
      await expect(loadManifest(path)).rejects.toThrow(/workerDml must be a boolean/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a YAML workerAccess on a non-tenant-scoped table", async () => {
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
    workerAccess: workflow-worker
    columns:
      - { name: id, type: uuid, primaryKey: true }
`,
      "utf8",
    );

    try {
      await expect(loadManifest(path)).rejects.toThrow(
        /workerAccess requires tenantScoped: true/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an empty YAML workerAccess", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openshapeforge-service-compiler-"));
    const path = join(dir, "schema.yaml");
    await writeFile(
      path,
      `
version: 1
tables:
  - schema: workflow
    name: control_commands
    tenantScoped: true
    workerAccess: "  "
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
`,
      "utf8",
    );

    try {
      await expect(loadManifest(path)).rejects.toThrow(
        /workerAccess must be a non-empty string/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a column default that carries a statement terminator", async () => {
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
      - { name: id, type: uuid, primaryKey: true, default: "gen_random_uuid(); DROP TABLE users; --" }
`,
      "utf8",
    );

    try {
      await expect(loadManifest(path)).rejects.toThrow(/default must not contain/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown foreign-key onDelete action", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openshapeforge-service-compiler-"));
    const path = join(dir, "schema.yaml");
    await writeFile(
      path,
      `
version: 1
tables:
  - schema: platform
    name: parents
    tenantScoped: false
    columns:
      - { name: id, type: uuid, primaryKey: true }
  - schema: platform
    name: children
    tenantScoped: false
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: parent_id, type: uuid, references: { schema: platform, table: parents, column: id, onDelete: "CASCADE; DROP SCHEMA erp CASCADE" } }
`,
      "utf8",
    );

    try {
      await expect(loadManifest(path)).rejects.toThrow(/onDelete must be one of/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an index WHERE predicate that carries a statement terminator", async () => {
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
      - { name: code, type: text }
    indexes:
      - name: reference_codes_code_idx
        columns: [code]
        where: "1=1); DROP TABLE audit; --"
`,
      "utf8",
    );

    try {
      await expect(loadManifest(path)).rejects.toThrow(/where must not contain/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("only marks tables generatedCrud when they opt in explicitly", () => {
    const optInManifest: PlatformSchemaManifest = {
      version: 1,
      tables: [
        {
          schema: "erp",
          name: "exposed",
          tenantScoped: true,
          generatedCrud: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
          ],
        },
        {
          schema: "erp",
          name: "omitted",
          tenantScoped: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
          ],
        },
      ],
    };
    const json = generateArtifacts(optInManifest).find((artifact) =>
      artifact.path.endsWith("manifest.json"),
    )?.contents;
    if (!json) {
      throw new Error("manifest.json artifact not found");
    }
    const parsed = JSON.parse(json) as {
      tables: Array<{ table: string; generatedCrud: boolean }>;
    };
    const byName = new Map(parsed.tables.map((t) => [t.table, t.generatedCrud]));
    expect(byName.get("exposed")).toBe(true);
    expect(byName.get("omitted")).toBe(false);
  });

  it("hash-stabilizes over-length index names so they cannot collide after truncation", () => {
    const longColumnA = `assignee_${"a".repeat(60)}`;
    const longColumnB = `assignee_${"a".repeat(59)}b`;
    const longManifest: PlatformSchemaManifest = {
      version: 1,
      tables: [
        {
          schema: "erp",
          name: "cases",
          tenantScoped: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "tenant_id", type: "uuid", required: true },
            { name: longColumnA, type: "uuid" },
            { name: longColumnB, type: "uuid" },
          ],
          indexes: [
            { name: `cases_tenant_${longColumnA}_idx`, columns: ["tenant_id", longColumnA] },
            { name: `cases_tenant_${longColumnB}_idx`, columns: ["tenant_id", longColumnB] },
          ],
        },
      ],
    };
    const sql = generateArtifacts(longManifest).find((artifact) =>
      artifact.path.endsWith("schema.sql"),
    )?.contents;
    if (!sql) {
      throw new Error("schema.sql artifact not found");
    }
    const emittedNames = [...sql.matchAll(/CREATE INDEX IF NOT EXISTS "([^"]+)"/g)].map(
      (match) => match[1] ?? "",
    );
    // Every emitted index name is within Postgres's 63-byte identifier limit.
    for (const name of emittedNames) {
      expect(name.length).toBeLessThanOrEqual(63);
    }
    // The two over-length names remain distinct after stabilization.
    expect(new Set(emittedNames).size).toBe(emittedNames.length);
  });
});

describe("generated REST OpenAPI artifact", () => {
  const restManifest: PlatformSchemaManifest = {
    version: 1,
    tables: [
      {
        schema: "erp",
        name: "widgets",
        tenantScoped: true,
        generatedCrud: true,
        columns: [
          { name: "id", type: "uuid", primaryKey: true, default: "gen_random_uuid()" },
          { name: "tenant_id", type: "uuid", required: true },
          { name: "display_name", type: "text", required: true },
          { name: "is_active", type: "boolean" },
          { name: "created_at", type: "timestamptz", required: true },
        ],
        source: {
          authoringEntityName: "Widget",
          rest: {
            basePath: "widgets",
            operations: { list: true, get: true, create: true, update: true, delete: false },
          },
        },
      },
      {
        schema: "erp",
        name: "gadgets",
        tenantScoped: true,
        generatedCrud: true,
        columns: [{ name: "id", type: "uuid", primaryKey: true }],
        source: { authoringEntityName: "Gadget" },
      },
    ],
  };

  function openApiFor(input: PlatformSchemaManifest) {
    const artifact = generateArtifacts(input).find((item) =>
      item.path.endsWith("rest/openapi.json"),
    );
    expect(artifact?.path).toBe("apps/api/src/generated/rest/openapi.json");
    return JSON.parse(artifact!.contents) as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
    };
  }

  it("emits versioned paths only for rest-enabled tables and enabled operations", () => {
    const spec = openApiFor(restManifest);
    expect(Object.keys(spec.paths)).toEqual([
      "/api/rest/v1/widgets",
      "/api/rest/v1/widgets/{id}",
    ]);
    const item = spec.paths["/api/rest/v1/widgets/{id}"]!;
    expect(item.get).toBeDefined();
    expect(item.patch).toBeDefined();
    // operations.delete: false → no delete route advertised.
    expect(item.delete).toBeUndefined();
  });

  it("derives camelCase field schemas from columns and excludes server-managed columns from the input schema", () => {
    const spec = openApiFor(restManifest);
    const widget = spec.components.schemas.Widget!;
    expect(Object.keys(widget.properties ?? {})).toEqual([
      "id",
      "tenantId",
      "displayName",
      "isActive",
      "createdAt",
    ]);
    expect(widget.required).toEqual(["id", "tenantId", "displayName", "createdAt"]);

    const input = spec.components.schemas.WidgetInput!;
    expect(Object.keys(input.properties ?? {})).toEqual(["displayName", "isActive"]);
    expect(input.required).toEqual(["displayName"]);

    const update = spec.components.schemas.WidgetUpdateInput!;
    expect(Object.keys(update.properties ?? {})).toEqual(["displayName", "isActive"]);
    expect(update.required).toBeUndefined();
  });

  it("always emits the artifact — with empty paths when no table opts in", () => {
    const spec = openApiFor(manifest);
    expect(spec.paths).toEqual({});
  });

  it("is deterministic: two renders are byte-identical", () => {
    const render = () =>
      generateArtifacts(restManifest).find((item) => item.path.endsWith("rest/openapi.json"))!
        .contents;
    expect(render()).toBe(render());
  });
});
