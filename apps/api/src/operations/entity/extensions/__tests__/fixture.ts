// SPDX-License-Identifier: BUSL-1.1
/**
 * Scratch-database fixture for tenant field tests (contract fase 1a).
 *
 * Until the compiler emits `extensible`, the fixture builds by hand what it
 * will emit — the `extension_values` column on erp.tasks, the two side
 * tables and the three platform tables, with the contract's DDL, RLS and
 * grants — and registers the matching manifest entries: Task as an
 * extensible entity (referencing itself) in the extension registry, and the
 * Task table with its new column. Every path downstream reads them exactly as
 * it reads compiled metadata.
 *
 * Scratch databases are named `osf372_rt_*` and dropped afterwards; the
 * shared development database is never touched (docs/testing.md).
 */
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import manifest from "../../../../generated/db/manifest.json" with { type: "json" };
import { createDatabaseRuntime, type DatabaseRuntime } from "../../../../db/connection.js";
import { runMigrationChain } from "../../../../db/migration-chain.js";
import { applyAuditHistory } from "../../../../db/migrations/audit-history.js";
import { applyWorkerRoleGrants } from "../../../../db/migrations/worker-role.js";
import { __registerGeneratedCrudTableForTests, getGeneratedCrudTables } from "../../catalog.js";
import type { GeneratedCrudTable } from "../../types.js";
import { __setExtensionRegistryForTests } from "../registry.js";

export const MANAGER_ROLE = "Test.Fields.Manage";
export const WRITER_ROLE = "General.All.ReadWrite";
export const READER_ROLE = "General.All.Read";

export type ExtensionFixture = {
  admin: SQL;
  privileged: DatabaseRuntime;
  app: DatabaseRuntime;
  worker: DatabaseRuntime;
  database: string;
  table: GeneratedCrudTable;
  /** Tenants exist as platform rows (jobs reference them). */
  addTenants(...ids: string[]): Promise<void>;
  close(): Promise<void>;
};

export function sessionFor(tenantId: string, roles: string[], userId = randomUUID()) {
  return { tenantId, userId, roles, groups: [], scope: "tenant" as const, credential: "trusted-context" as const };
}

/** The platform and side-table DDL the compiler emits for one extensible entity (contract "Opslag"). */
export const EXTENSION_DDL = `
  alter table erp.tasks add column if not exists extension_values jsonb not null default '{}'::jsonb;

  create table erp.tasks_field_values (
    tenant_id uuid not null, record_id uuid not null, field_id uuid not null, ordinal integer not null default 0,
    value_text text, value_number numeric, value_boolean boolean, value_date date, value_timestamp timestamptz, value_ref_id uuid,
    primary key (tenant_id, record_id, field_id, ordinal),
    foreign key (tenant_id, record_id) references erp.tasks (tenant_id, id) on delete cascade
  );
  create index on erp.tasks_field_values (tenant_id, field_id, value_text) where value_text is not null;
  create index on erp.tasks_field_values (tenant_id, field_id, value_number) where value_number is not null;
  create index on erp.tasks_field_values (tenant_id, field_id, value_boolean) where value_boolean is not null;
  create index on erp.tasks_field_values (tenant_id, field_id, value_date) where value_date is not null;
  create index on erp.tasks_field_values (tenant_id, field_id, value_timestamp) where value_timestamp is not null;
  create index on erp.tasks_field_values (tenant_id, value_ref_id) where value_ref_id is not null;

  create table erp.tasks_field_unique_values (
    tenant_id uuid not null, field_id uuid not null, value_text text not null, record_id uuid not null,
    primary key (tenant_id, field_id, value_text),
    foreign key (tenant_id, record_id) references erp.tasks (tenant_id, id) on delete cascade
  );

  create table platform.extension_field_definitions (
    tenant_id uuid not null, id uuid primary key, field_id uuid not null, entity text not null, key text not null,
    version integer not null, kind text not null check (kind in ('stored','formula','lookup','rollup')),
    definition jsonb not null, applies_when jsonb,
    state text not null check (state in ('updating','ready','deprecated','suspended','deleted')),
    position integer not null, is_current boolean not null, created_at timestamptz not null default now(), created_by uuid,
    unique (tenant_id, field_id, version)
  );
  create unique index extension_field_definitions_current_key on platform.extension_field_definitions (tenant_id, entity, key)
    where is_current and state <> 'deleted';
  create index on platform.extension_field_definitions (tenant_id, entity) where is_current;

  create table platform.extension_field_dependencies (
    tenant_id uuid not null, field_id uuid not null, depends_on_entity text not null, depends_on_field text not null, via_field text,
    unique nulls not distinct (tenant_id, field_id, depends_on_entity, depends_on_field, via_field)
  );
  create index on platform.extension_field_dependencies (tenant_id, depends_on_entity, depends_on_field);

  create table platform.extension_field_backfills (
    tenant_id uuid not null, id uuid primary key, entity text not null, field_id uuid not null, definition_version integer not null,
    operation text not null check (operation in ('retype','delete','unique','formula','lookup','rollup','rebuild')),
    state text not null check (state in ('queued','running','done','failed')),
    processed integer not null default 0, total integer not null default 0, cursor text, error jsonb,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
`;

const TENANT_TABLES = [
  "erp.tasks_field_values", "erp.tasks_field_unique_values", "platform.extension_field_definitions",
  "platform.extension_field_dependencies", "platform.extension_field_backfills",
];

export const TASK_EXTENSIONS = {
  entities: {
    Task: {
      table: "erp.tasks",
      valuesTable: "erp.tasks_field_values",
      uniqueTable: "erp.tasks_field_unique_values",
      manageRoles: [MANAGER_ROLE, "Organization.All.ReadWrite"],
      limits: { fields: 9, filtersPerQuery: 3, formulaDepth: 5, syncFanOut: 100 },
      allowedOsfTypes: ["string", "integer", "number", "boolean", "date", "datetime", "measurement", "money", "email", "multilineText"],
      targets: [{ entity: "Task", table: "erp.tasks" }],
      ownedSingleChildren: [],
    },
  },
  indexProjections: { measurement: { number: "value", text: "unit" } },
  referencedBy: { Task: [{ sourceEntity: "Task", valuesTable: "erp.tasks_field_values" }] },
};

export async function createExtensionFixture(label: string): Promise<ExtensionFixture> {
  const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
  const url = new URL(adminUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") {
    throw new Error("Scratch tests require a local postgres admin database, never an application database.");
  }
  const database = `osf372_rt_${label}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new SQL(adminUrl, { max: 1 });
  await admin.unsafe(`create database "${database}"`);
  url.pathname = `/${database}`;
  const privileged = createDatabaseRuntime({ databaseUrl: url.toString() });
  await privileged.db.connection().execute((connection) => runMigrationChain(connection));

  const restoreRegistry = __setExtensionRegistryForTests(TASK_EXTENSIONS);
  const original = getGeneratedCrudTables().find((table) => table.name === "erp.tasks")!;
  const table: GeneratedCrudTable = {
    ...original,
    columns: [...original.columns, { name: "extension_values", type: "jsonb", required: true, primaryKey: false, generated: null }],
  };
  const unregister = __registerGeneratedCrudTableForTests(table);

  await sql.raw(EXTENSION_DDL).execute(privileged.db);
  for (const qualified of TENANT_TABLES) {
    const [schema, name] = qualified.split(".");
    await sql.raw(`
      alter table ${schema}.${name} enable row level security;
      alter table ${schema}.${name} force row level security;
      create policy ${name}_tenant_isolation on ${schema}.${name}
        using (app.bypass_rls() or (tenant_id = app.current_tenant()))
        with check (app.bypass_rls() or (tenant_id = app.current_tenant()));
      grant select, insert, update, delete on ${schema}.${name} to openshapeforge_app;
    `).execute(privileged.db);
  }
  await applyWorkerRoleGrants(privileged.db);
  const tables = (manifest.tables as unknown as GeneratedCrudTable[]).map((candidate) => candidate.name === table.name ? table : candidate);
  await applyAuditHistory(privileged.db, tables);

  const appUrl = new URL(url); appUrl.username = "openshapeforge_app"; appUrl.password = "openshapeforge_app";
  const workerUrl = new URL(url); workerUrl.username = "openshapeforge_worker"; workerUrl.password = "openshapeforge_worker";
  const app = createDatabaseRuntime({ databaseUrl: appUrl.toString(), maxConnections: 4 });
  const worker = createDatabaseRuntime({ databaseUrl: workerUrl.toString(), maxConnections: 2 });
  return {
    admin, privileged, app, worker, database, table,
    async addTenants(...ids: string[]) {
      for (const id of ids) {
        await sql`insert into platform.tenants (id, slug, name, status)
          values (${id}::uuid, ${`t-${id.slice(0, 8)}`}, ${`Tenant ${id.slice(0, 8)}`}, 'active')`.execute(privileged.db);
      }
    },
    async close() {
      unregister();
      __registerGeneratedCrudTableForTests(original);
      restoreRegistry();
      await app.close();
      await worker.close();
      await privileged.close();
      await admin.unsafe(`drop database if exists "${database}" with (force)`);
      await admin.close();
    },
  };
}
