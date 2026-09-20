// SPDX-License-Identifier: BUSL-1.1
/**
 * Reverse-map revalidation on a real write path: collection insert/remove
 * and generic child update against a published owner, plus two sessions
 * racing to delete the last two bindings.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { applyAppHelpersMigration } from "../../db/migrations/app-helpers.js";
import { withDbSession } from "../../db/session.js";
import rawCatalog from "../../generated/operations/catalog.json" with { type: "json" };
import type { DerivedToolsCatalogEntry } from "../../mcp/derived-tools.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { createCollectionMutationExecutor, type CollectionMutationBinding } from "./collection-mutations.js";
import { assertPublishableRelatedMutationInTransaction } from "./derived-execution-guards.js";
import { updateGeneratedEntityForTable } from "./mutations.js";
import type { EntityOperationContract, GeneratedCrudColumn, GeneratedCrudTable } from "./types.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@127.0.0.1:5435/postgres";
const scratchName = `exec_bind_guard_${randomUUID().replaceAll("-", "")}`;
let admin: SQL | undefined, privileged: DatabaseRuntime | undefined, restricted: DatabaseRuntime | undefined;
let created = false;
const tenant = randomUUID(), actor = randomUUID();
const session = {
  tenantId: tenant,
  userId: actor,
  scope: "self" as const,
  roles: ["General.All.Read", "General.All.ReadWrite", "Organization.All.ReadWrite"],
};
const column = (name: string, type: string, extra: Partial<GeneratedCrudColumn> = {}): GeneratedCrudColumn => ({
  name, type, required: true, primaryKey: name === "id", generated: null, ...extra,
});

const ENTRY: DerivedToolsCatalogEntry = {
  entity: "TemplateVariant",
  table: "erp.template_variants",
  roles: ["employee"],
  keyField: "key",
  descriptionField: "key",
  inputFieldsField: "key",
  visibleWhen: { field: "status", equals: "published" },
  execution: {
    bindingsRelation: "blocks",
    bindingsEntity: "Block",
    bindingsTable: "erp.blocks",
    parentRef: "parent",
    operationRef: "operationId",
    operationEntity: "Operation",
    operationTable: "public.svc_operations",
    providerRef: "providerId",
    providerEntity: "Provider",
    providerTable: "public.svc_providers",
    connectionEntity: "Connection",
    connectionTable: "public.svc_connections",
    connectionProviderRef: "providerId",
    connectionValuesField: "values",
  },
};

function databaseUrl(app = false) {
  const url = new URL(adminUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") {
    throw new Error("Scratch tests require a local postgres admin database, never an application database.");
  }
  url.pathname = `/${scratchName}`;
  if (app) { url.username = "openshapeforge_app"; url.password = "openshapeforge_app"; }
  return url.toString();
}

function fixture() {
  const tables = getGeneratedCrudTables();
  const parent = structuredClone(tables.find((table) => table.source?.authoringEntityName === "TemplateVariant")!);
  const child = structuredClone(tables.find((table) => table.source?.authoringEntityName === "Block")!);
  const common = [
    column("id", "uuid"),
    column("tenant_id", "uuid"),
    column("updated_at", "timestamptz", { sourceField: "updatedAt" }),
    column("title", "text"),
    column("permissions", "jsonb", { required: false }),
  ];
  parent.columns = [
    ...common,
    column("key", "text", { sourceField: "key" }),
    column("status", "text", { sourceField: "status" }),
  ];
  child.columns = [
    ...common,
    column("parent_id", "uuid", { sourceField: "parent", immutable: true }),
    column("parent_id_position", "integer"),
    column("operation_id", "uuid", { sourceField: "operationId" }),
  ];
  parent.source!.graphql!.relationships = [{
    name: "blocks", fieldKey: "blocks", kind: "hasMany", resolve: "hasMany",
    type: "[Block!]!", target: "Block", inverse: "parent", foreignKey: "parent_id",
    ownership: "owned", sortable: true, positionColumn: "parent_id_position", cardinality: { min: 0, max: 8 },
  }];
  child.source!.graphql!.relationships = [{
    name: "parent", fieldKey: "parent", kind: "belongsTo", resolve: "belongsTo",
    type: "TemplateVariant", target: "TemplateVariant", foreignKey: "parent_id",
  }];
  for (const table of [parent, child]) {
    table.source!.computedFields = [];
    table.realtime = { readPredicate: '"tenant_id" = app.current_tenant()', visibilityColumns: ["tenant_id"] };
  }
  const operation = {
    name: "public.svc_operations", schema: "public", table: "svc_operations", tenantScoped: true,
    primaryKey: "id", domainInternal: false, generatedCrudEligible: true,
    columns: [
      column("id", "uuid"), column("tenant_id", "uuid"),
      column("key", "text", { sourceField: "key" }),
      column("provider_id", "uuid", { sourceField: "providerId" }),
    ],
    source: { authoringEntityName: "Operation", graphql: { typeName: "Operation", relationships: [] } },
  } as unknown as GeneratedCrudTable;
  const provider = {
    name: "public.svc_providers", schema: "public", table: "svc_providers", tenantScoped: true,
    primaryKey: "id", domainInternal: false, generatedCrudEligible: true,
    columns: [
      column("id", "uuid"), column("tenant_id", "uuid"),
      column("name", "text", { sourceField: "name" }),
      column("auth", "jsonb", { sourceField: "auth" }),
    ],
    source: { authoringEntityName: "Provider", graphql: { typeName: "Provider", relationships: [] } },
  } as unknown as GeneratedCrudTable;
  const connection = {
    name: "public.svc_connections", schema: "public", table: "svc_connections", tenantScoped: true,
    primaryKey: "id", domainInternal: false, generatedCrudEligible: true,
    columns: [
      column("id", "uuid"), column("tenant_id", "uuid"),
      column("provider_id", "uuid", { sourceField: "providerId" }),
      column("owner_user_id", "uuid", { sourceField: "ownerUserId", required: false }),
      column("values", "jsonb", { sourceField: "values" }),
    ],
    source: { authoringEntityName: "Connection", graphql: { typeName: "Connection", relationships: [] } },
  } as unknown as GeneratedCrudTable;
  const operations = structuredClone(
    (rawCatalog as unknown as { entityOperations: EntityOperationContract[] }).entityOperations
      .filter((op) => ["TemplateVariant", "Block"].includes(op.entityName)),
  );
  operations.find((op) => op.entityName === "Block" && op.intent === "create")!.inputSchema = {
    type: "object",
    properties: {
      values: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1 },
          parent: { type: "string", format: "uuid" },
          permissions: { type: "object" },
          operationId: { type: "string", format: "uuid" },
        },
        required: ["title", "parent", "operationId"],
        additionalProperties: false,
      },
    },
  };
  operations.find((op) => op.entityName === "Block" && op.intent === "update")!.inputSchema = {
    type: "object",
    properties: {
      values: {
        type: "object",
        properties: {
          title: { type: "string" },
          operationId: { type: "string", format: "uuid" },
        },
        additionalProperties: false,
      },
    },
  };
  const catalogTables = [parent, child, operation, provider, connection];
  const execute = createCollectionMutationExecutor({
    tables: catalogTables,
    operations,
    derivedTools: [ENTRY],
  });
  return { parent, child, operation, provider, connection, catalogTables, execute };
}

async function version(id: string) {
  return String(
    (await sql<{ version: string }>`select updated_at::text as version from erp.template_variants where id = ${id}::uuid`
      .execute(privileged!.db)).rows[0]!.version,
  );
}

async function seed(bindings: number) {
  const f = fixture();
  const ownerId = randomUUID();
  const operationId = randomUUID();
  const providerId = randomUUID();
  await sql`insert into public.svc_providers(id, tenant_id, name, auth)
    values (${providerId}::uuid, ${tenant}::uuid, 'Ticketing', '{"scheme":"bearer","tokenFrom":"token"}'::jsonb)`
    .execute(privileged!.db);
  await sql`insert into public.svc_operations(id, tenant_id, key, provider_id)
    values (${operationId}::uuid, ${tenant}::uuid, 'search', ${providerId}::uuid)`.execute(privileged!.db);
  await sql`insert into public.svc_connections(id, tenant_id, provider_id, owner_user_id, values)
    values (${randomUUID()}::uuid, ${tenant}::uuid, ${providerId}::uuid, null, '{"token":"t"}'::jsonb)`
    .execute(privileged!.db);
  await sql`insert into erp.template_variants(id, tenant_id, title, key, status)
    values (${ownerId}::uuid, ${tenant}::uuid, 'Owner', 'find-tickets', 'published')`.execute(privileged!.db);
  const childIds: string[] = [];
  for (let index = 0; index < bindings; index++) {
    const childId = randomUUID();
    childIds.push(childId);
    await sql`insert into erp.blocks(id, tenant_id, title, parent_id, parent_id_position, operation_id)
      values (${childId}::uuid, ${tenant}::uuid, 'Binding', ${ownerId}::uuid, ${index}, ${operationId}::uuid)`
      .execute(privileged!.db);
  }
  return { f, ownerId, operationId, providerId, childIds, expectedVersion: await version(ownerId) };
}

const fails = (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ operationError: { code } });

(adminUrl ? describe : describe.skip)("published owner revalidation on the write engine", () => {
  beforeAll(async () => {
    admin = new SQL(adminUrl, { max: 1 });
    const roles = await admin`select rolsuper, rolbypassrls from pg_roles where rolname = 'openshapeforge_app'`;
    if (roles.length !== 1 || roles[0].rolsuper || roles[0].rolbypassrls) {
      throw new Error("An existing restricted app role is required; shared roles are never changed.");
    }
    await admin.unsafe(`create database "${scratchName}"`);
    created = true;
    privileged = createDatabaseRuntime({ databaseUrl: databaseUrl(), maxConnections: 1 });
    await applyAppHelpersMigration(privileged.db);
    await sql`
      create schema erp; create schema platform;
      create table erp.template_variants(
        id uuid primary key, tenant_id uuid not null, title text not null, key text not null, status text not null,
        updated_at timestamptz not null default clock_timestamp(), permissions jsonb, unique(tenant_id,id));
      create table erp.blocks(
        id uuid primary key, tenant_id uuid not null, title text not null,
        updated_at timestamptz not null default clock_timestamp(), permissions jsonb,
        parent_id uuid not null, parent_id_position integer not null, operation_id uuid not null,
        unique(tenant_id,id), foreign key(tenant_id,parent_id) references erp.template_variants(tenant_id,id));
      create table public.svc_providers(
        id uuid primary key, tenant_id uuid not null, name text not null, auth jsonb not null, unique(tenant_id,id));
      create table public.svc_operations(
        id uuid primary key, tenant_id uuid not null, key text not null, provider_id uuid not null, unique(tenant_id,id));
      create table public.svc_connections(
        id uuid primary key, tenant_id uuid not null, provider_id uuid not null, owner_user_id uuid,
        values jsonb not null, unique(tenant_id,id));
      create table platform.entity_events(
        id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
        aggregate_type text not null, aggregate_id text not null, event_type text not null, payload jsonb,
        sequence bigint generated always as identity, occurred_at timestamptz not null);
      alter table erp.template_variants enable row level security; alter table erp.template_variants force row level security;
      alter table erp.blocks enable row level security; alter table erp.blocks force row level security;
      alter table public.svc_operations enable row level security; alter table public.svc_operations force row level security;
      alter table public.svc_providers enable row level security; alter table public.svc_providers force row level security;
      alter table public.svc_connections enable row level security; alter table public.svc_connections force row level security;
      create policy tenant on erp.template_variants using(tenant_id=app.current_tenant()) with check(tenant_id=app.current_tenant());
      create policy tenant on erp.blocks using(tenant_id=app.current_tenant()) with check(tenant_id=app.current_tenant());
      create policy tenant on public.svc_operations using(tenant_id=app.current_tenant()) with check(tenant_id=app.current_tenant());
      create policy tenant on public.svc_providers using(tenant_id=app.current_tenant()) with check(tenant_id=app.current_tenant());
      create policy tenant on public.svc_connections using(tenant_id=app.current_tenant()) with check(tenant_id=app.current_tenant());
      grant usage on schema app, erp, public, platform to openshapeforge_app;
      grant select,insert,update,delete on all tables in schema erp, public, platform to openshapeforge_app;
      grant usage on all sequences in schema platform to openshapeforge_app;
      grant execute on all functions in schema app to openshapeforge_app
    `.execute(privileged.db);
    restricted = createDatabaseRuntime({ databaseUrl: databaseUrl(true), maxConnections: 4 });
  }, 30_000);

  beforeEach(async () => {
    await sql`truncate erp.blocks, erp.template_variants, public.svc_connections, public.svc_operations, public.svc_providers, platform.entity_events`
      .execute(privileged!.db);
  });

  afterAll(async () => {
    await restricted?.close();
    await privileged?.close();
    if (created) await admin?.unsafe(`drop database "${scratchName}" with (force)`);
    await admin?.close();
  });

  test("collection remove of the last binding of a published owner is NOT_PUBLISHABLE", async () => {
    const seeded = await seed(1);
    const remove: CollectionMutationBinding = { entityName: "TemplateVariant", field: "blocks", action: "remove" };
    await fails(
      seeded.f.execute(restricted!.db, session, remove, {
        id: seeded.ownerId,
        expectedVersion: seeded.expectedVersion,
        childId: seeded.childIds[0]!,
      }),
      "NOT_PUBLISHABLE",
    );
    expect(
      (await sql<{ count: number }>`select count(*)::int as count from erp.blocks`.execute(privileged!.db)).rows[0]!.count,
    ).toBe(1);
  });

  test("collection insert naming a missing operation is NOT_PUBLISHABLE", async () => {
    const seeded = await seed(1);
    const insert: CollectionMutationBinding = { entityName: "TemplateVariant", field: "blocks", action: "insert" };
    await fails(
      seeded.f.execute(restricted!.db, session, insert, {
        id: seeded.ownerId,
        expectedVersion: seeded.expectedVersion,
        values: { title: "Bad binding", operationId: randomUUID() },
      }),
      "NOT_PUBLISHABLE",
    );
  });

  test("generic update of a child that names a missing operation is NOT_PUBLISHABLE", async () => {
    const seeded = await seed(1);
    await fails(
      updateGeneratedEntityForTable(
        restricted!.db,
        session,
        seeded.f.child,
        seeded.childIds[0]!,
        { operationId: randomUUID() },
        { tables: seeded.f.catalogTables, derivedTools: [ENTRY] },
      ),
      "NOT_PUBLISHABLE",
    );
  });

  test("two sessions deleting the last two bindings do not both succeed", async () => {
    const seeded = await seed(2);
    const results = await Promise.allSettled(
      seeded.childIds.map((childId) =>
        withDbSession(restricted!.db, session, (trx) =>
          assertPublishableRelatedMutationInTransaction(
            trx,
            session,
            seeded.f.child,
            {
              kind: "delete",
              id: childId,
              row: { id: childId, parent: seeded.ownerId, operationId: seeded.operationId },
            },
            { tables: seeded.f.catalogTables, entries: [ENTRY], db: restricted!.db },
          ).then(() =>
            sql`delete from erp.blocks where id = ${childId}::uuid`.execute(trx),
          ),
        ),
      ),
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled").length;
    const refused = results.filter(
      (result) =>
        result.status === "rejected" &&
        (result.reason as { operationError?: { code?: string } })?.operationError?.code === "NOT_PUBLISHABLE",
    ).length;
    expect(fulfilled).toBe(1);
    expect(refused).toBe(1);
    expect(
      (await sql<{ count: number }>`select count(*)::int as count from erp.blocks`.execute(privileged!.db)).rows[0]!.count,
    ).toBe(1);
  });
});
