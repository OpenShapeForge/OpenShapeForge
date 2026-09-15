// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { applyAppHelpersMigration } from "../../db/migrations/app-helpers.js";
import { withDbSession } from "../../db/session.js";
import { jsonbLiteral } from "../../db/sql-helpers.js";
import { createEntityValueRegistry } from "../../modules/entity-value-registry.js";
import rawCatalog from "../../generated/operations/catalog.json" with { type: "json" };
import { getGeneratedCrudTables, projectGeneratedEntityRow, projectRows } from "./catalog.js";
import { createGeneratedEntityForTable, updateGeneratedEntityForTable } from "./mutations.js";
import { serializeEntityRow } from "./serialize-result.js";
import { collectionMutationError } from "./collection-policy.js";
import { createCollectionMutationExecutor, type CollectionMutationBinding } from "./collection-mutations.js";
import type { EntityOperationContract, GeneratedCrudColumn, GeneratedCrudTable } from "./types.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL;
const scratchName = `schema3_mut_${randomUUID().replaceAll("-", "")}`;
let admin: SQL | undefined, privileged: DatabaseRuntime | undefined, restricted: DatabaseRuntime | undefined;
let created = false;
const tenant = randomUUID(), otherTenant = randomUUID(), actor = randomUUID();
const binding: CollectionMutationBinding = { entityName: "TemplateVariant", field: "blocks", action: "insert" };
const session = { tenantId: tenant, userId: actor, scope: "self" as const, roles: ["General.All.Read", "General.All.ReadWrite", "Organization.All.ReadWrite"] };
const column = (name: string, type: string, extra: Partial<GeneratedCrudColumn> = {}): GeneratedCrudColumn => ({ name, type, required: true, primaryKey: name === "id", generated: null, ...extra });

function fixture(entityValues = createEntityValueRegistry({ version: 1, carriers: [], collections: [] })) {
  const tables = getGeneratedCrudTables();
  const parent = structuredClone(tables.find((table) => table.source?.authoringEntityName === "TemplateVariant")!);
  const child = structuredClone(tables.find((table) => table.source?.authoringEntityName === "Block")!);
  const common = [column("id", "uuid"), column("tenant_id", "uuid"), column("updated_at", "timestamptz", { sourceField: "updatedAt" }), column("title", "text"), column("permissions", "jsonb", { required: false })];
  parent.columns = common;
  child.columns = [...common, column("parent_id", "uuid", { sourceField: "parent", immutable: true }), column("parent_id_position", "integer")];
  parent.source!.graphql!.relationships = [{ name: "blocks", fieldKey: "blocks", kind: "hasMany", resolve: "hasMany", type: "[Block!]!", target: "Block", inverse: "parent", foreignKey: "parent_id", ownership: "owned", sortable: true, positionColumn: "parent_id_position", cardinality: { min: 0, max: 4 } }];
  child.source!.graphql!.relationships = [{ name: "parent", fieldKey: "parent", kind: "belongsTo", resolve: "belongsTo", type: "TemplateVariant", target: "TemplateVariant", foreignKey: "parent_id" }];
  for (const table of [parent, child]) {
    table.source!.computedFields = [];
    table.realtime = { readPredicate: '"tenant_id" = app.current_tenant()', visibilityColumns: ["tenant_id"] };
  }
  const operations = structuredClone((rawCatalog as unknown as { entityOperations: EntityOperationContract[] }).entityOperations.filter((op) => ["TemplateVariant", "Block"].includes(op.entityName)));
  operations.find((op) => op.entityName === "Block" && op.intent === "create")!.inputSchema = {
    type: "object", properties: { values: { type: "object", properties: { title: { type: "string", minLength: 1 }, parent: { type: "string", format: "uuid" }, permissions: { type: "object" } }, required: ["title", "parent"], additionalProperties: false } },
  };
  const catalog = { tables: [parent, child], operations, entityValues };
  return { parent, child, operations, execute: createCollectionMutationExecutor(catalog) };
}
function valueFixture(allowed = ["Include", "Text"]) {
  const registry = createEntityValueRegistry({ version: 1, carriers: [{
    entityName: "Block", fieldKey: "values", definitionField: "definitionKey", schema: "erp", table: "blocks", valuesColumn: "payload", definitionColumn: "definition_key",
    definitions: {
      Include: { entityName: "Include", schemaVersion: 1, definitionHash: "a".repeat(64),
        fields: [{ key: "parameters", valueType: "object", defaultValue: {} }],
        valueSchema: { type: "object", properties: { parameters: { type: "object", properties: { label: { type: "string" } }, additionalProperties: false } }, required: ["parameters"], additionalProperties: false },
        references: [
          { fieldKey: "version", targetEntity: "TemplateVariant", schema: "erp", table: "template_variants", column: "ev_values_include_version_id", required: true },
          { fieldKey: "alternate", targetEntity: "TemplateVariant", schema: "erp", table: "template_variants", column: "ev_values_include_alternate_id", required: false },
        ],
      },
      Text: { entityName: "Text", schemaVersion: 1, definitionHash: "b".repeat(64),
        fields: [{ key: "caption", valueType: "string", defaultValue: "Untitled" }],
        valueSchema: { type: "object", properties: { caption: { type: "string", minLength: 1 } }, required: ["caption"], additionalProperties: false }, references: [],
      },
    },
  }], collections: allowed.length ? [{ entityName: "TemplateVariant", fieldKey: "blocks", targetEntity: "Block", allowedDefinitions: allowed }] : [] });
  const f = fixture(registry);
  f.child.columns.push(column("definition_key", "text", { sourceField: "definitionKey", immutable: true }), column("payload", "jsonb", { sourceField: "values" }),
    column("ev_values_include_version_id", "uuid", { required: false }), column("ev_values_include_alternate_id", "uuid", { required: false }));
  f.operations.find((op) => op.entityName === "Block" && op.intent === "create")!.inputSchema = {
    type: "object", properties: { values: { type: "object", properties: {
      title: { type: "string" }, parent: { type: "string", format: "uuid" }, definitionKey: { type: "string", enum: ["Include", "Text"] }, values: { type: "object" },
    }, required: ["title", "parent", "definitionKey", "values"], additionalProperties: false } },
  };
  return { ...f, registry, context: { registry, tables: [f.parent, f.child] } };
}
async function insertValue(f: ReturnType<typeof valueFixture>, parentId: string, values: Record<string, unknown>, definitionKey = "Include", actorSession = session) {
  return createGeneratedEntityForTable(restricted!.db, actorSession, f.child, { title: "Typed child", parent: parentId, parentIdPosition: 0, definitionKey, values }, f.context);
}
async function storedValue(id: string) {
  return (await sql<{ row: Record<string, unknown> }>`select to_jsonb(b.*) as row from erp.blocks b where id=${id}::uuid`.execute(privileged!.db)).rows[0]!.row;
}
function databaseUrl(app = false) {
  const url = new URL(adminUrl!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") throw new Error("Scratch tests require a local postgres admin database, never an application database.");
  url.pathname = `/${scratchName}`;
  if (app) { url.username = "openshapeforge_app"; url.password = "openshapeforge_app"; }
  return url.toString();
}
async function seed(count = 2, tenantId = tenant) {
  const id = randomUUID();
  await sql`insert into erp.template_variants(id, tenant_id, title) values (${id}::uuid, ${tenantId}::uuid, 'Synthetic parent')`.execute(privileged!.db);
  const children: string[] = [];
  for (let index = 0; index < count; index++) {
    const childId = randomUUID(); children.push(childId);
    await sql`insert into erp.blocks(id,tenant_id,title,parent_id,parent_id_position) values (${childId}::uuid, ${tenantId}::uuid, 'Synthetic child', ${id}::uuid, ${index})`.execute(privileged!.db);
  }
  return { id, children, expectedVersion: await version(id) };
}
async function version(id: string) {
  return String((await sql<{ version: string }>`select updated_at::text as version from erp.template_variants where id = ${id}::uuid`.execute(privileged!.db)).rows[0]!.version);
}
async function state(id: string) {
  const rows = (await sql<{ id: string; parent_id_position: number }>`select id, parent_id_position from erp.blocks where parent_id = ${id}::uuid order by parent_id_position, id`.execute(privileged!.db)).rows;
  const events = (await sql<{ count: number }>`select count(*)::int as count from platform.entity_events`.execute(privileged!.db)).rows[0]!.count;
  return { rows, events, version: await version(id) };
}
const fails = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ operationError: { code } });

test("generic CRUD remains fail-closed for collection arrays, child reparenting and position input", () => {
  const { parent, child } = fixture();
  for (const values of [{ blocks: [] }]) expect(collectionMutationError(parent, "update", [parent, child], values)?.code).toBe("RELATION_COLLECTION_MUTATION_UNSUPPORTED");
  for (const values of [{ parent: randomUUID() }, { parent_id_position: 1 }]) expect(collectionMutationError(child, "update", [parent, child], values)?.code).toBe("RELATION_COLLECTION_MUTATION_UNSUPPORTED");
});

(adminUrl ? describe : describe.skip)("atomic owned collection insert/move against PostgreSQL", () => {
  beforeAll(async () => {
    databaseUrl(); admin = new SQL(adminUrl!, { max: 1 });
    const roles = await admin`select rolsuper, rolbypassrls from pg_roles where rolname = 'openshapeforge_app'`;
    if (roles.length !== 1 || roles[0].rolsuper || roles[0].rolbypassrls) throw new Error("An existing restricted app role is required; shared roles are never changed.");
    await admin.unsafe(`create database "${scratchName}"`); created = true;
    privileged = createDatabaseRuntime({ databaseUrl: databaseUrl(), maxConnections: 1 });
    await applyAppHelpersMigration(privileged.db);
    await sql`create schema erp; create schema platform;
      create table erp.template_variants(id uuid primary key default gen_random_uuid(), tenant_id uuid not null, title text not null,
        updated_at timestamptz not null default clock_timestamp(), permissions jsonb, unique(tenant_id,id));
      create table erp.blocks(id uuid primary key default gen_random_uuid(), tenant_id uuid not null, title text not null,
        updated_at timestamptz not null default clock_timestamp(), permissions jsonb, parent_id uuid not null, parent_id_position integer not null,
        definition_key text, version_number integer, payload jsonb, ev_values_include_version_id uuid, ev_values_include_alternate_id uuid,
        foreign key(tenant_id,ev_values_include_version_id) references erp.template_variants(tenant_id,id),
        foreign key(tenant_id,ev_values_include_alternate_id) references erp.template_variants(tenant_id,id),
        check(definition_key is null or definition_key in ('Include','Text')),
        check(definition_key is null or (payload is not null and jsonb_typeof(payload)='object')),
        check(definition_key<>'Include' or ev_values_include_version_id is not null),
        check(definition_key<>'Text' or (ev_values_include_version_id is null and ev_values_include_alternate_id is null)),
        check(definition_key<>'Include' or payload - array['parameters']::text[] = '{}'::jsonb),
        check(definition_key<>'Text' or payload - array['caption']::text[] = '{}'::jsonb),
        unique(tenant_id,id), foreign key(tenant_id,parent_id) references erp.template_variants(tenant_id,id));
      create index blocks_parent on erp.blocks(tenant_id,parent_id,parent_id_position);
      create table platform.entity_events(id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
        aggregate_type text not null, aggregate_id text not null, event_type text not null, payload jsonb,
        sequence bigint generated always as identity, occurred_at timestamptz not null);
      alter table erp.template_variants enable row level security; alter table erp.template_variants force row level security;
      alter table erp.blocks enable row level security; alter table erp.blocks force row level security;
      create policy tenant on erp.template_variants using(tenant_id=app.current_tenant()) with check(tenant_id=app.current_tenant());
      create policy tenant on erp.blocks using(tenant_id=app.current_tenant()) with check(tenant_id=app.current_tenant());
      grant usage on schema app, erp, platform to openshapeforge_app;
      grant select,insert,update,delete on all tables in schema erp,platform to openshapeforge_app;
      grant usage on all sequences in schema platform to openshapeforge_app;
      grant execute on all functions in schema app to openshapeforge_app`.execute(privileged.db);
    restricted = createDatabaseRuntime({ databaseUrl: databaseUrl(true), maxConnections: 4 });
  }, 30_000);
  beforeEach(async () => {
    await sql`truncate erp.blocks, erp.template_variants, platform.entity_events`.execute(privileged!.db);
  });
  afterAll(async () => {
    await restricted?.close(); await privileged?.close();
    if (created) await admin?.unsafe(`drop database "${scratchName}" with (force)`);
    await admin?.close();
  });
  test("inserts before a sibling, preserves IDs, injects the FK and audits parent/children", async () => {
    const { execute } = fixture(), seeded = await seed();
    const result = await execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "New child" }, beforeId: seeded.children[0]! });
    expect(result.orderedIds).toEqual([result.childId, ...seeded.children]);
    const after = await state(seeded.id);
    expect(after.rows.map((row) => row.id)).toEqual(result.orderedIds);
    expect(after.rows.map((row) => row.parent_id_position)).toEqual([0, 1, 2]);
    expect(after.events).toBe(5);
    expect(after.version).not.toBe(seeded.expectedVersion);
    expect(result.parent.id).toBe(seeded.id);
  });
  test("insert validates child references against the operation's bundled definitions", async () => {
    const f = fixture(), seeded = await seed(0);
    const create = f.operations.find(op => op.entityName === "Block" && op.intent === "create")!;
    (create.inputSchema!.properties as any).values.properties.title = { $ref: "#/$defs/title" };
    create.inputSchema!.$defs = { title: { type: "string", minLength: 3 } };
    await expect(f.execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "x" } })).rejects.toThrow("Child values");
    const result = await f.execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Valid child" } });
    expect(result.orderedIds).toEqual([result.childId]);
  });
  test("moves existing IDs to before another child and to the end", async () => {
    const { execute } = fixture(), seeded = await seed(3);
    const result = await execute(restricted!.db, session, { ...binding, action: "move" }, { id: seeded.id, expectedVersion: seeded.expectedVersion, childId: seeded.children[2]!, beforeId: seeded.children[0]! });
    expect(result.orderedIds).toEqual([seeded.children[2]!, seeded.children[0]!, seeded.children[1]!]);
    const next = await execute(restricted!.db, session, { ...binding, action: "move" }, { id: seeded.id, expectedVersion: await version(seeded.id), childId: seeded.children[2]!, beforeId: null });
    expect(next.orderedIds).toEqual(seeded.children);
    expect((await state(seeded.id)).rows.map((row) => row.parent_id_position)).toEqual([0, 1, 2]);
  });
  test("max/min failures roll back without touching parent version or audit", async () => {
    const { execute, parent } = fixture(), seeded = await seed();
    const before = await state(seeded.id);
    parent.source!.graphql!.relationships![0]!.cardinality = { max: 2 };
    await fails(execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Too many" } }), "VALIDATION");
    parent.source!.graphql!.relationships![0]!.cardinality = { min: 4 };
    await fails(execute(restricted!.db, session, { ...binding, action: "move" }, { id: seeded.id, expectedVersion: seeded.expectedVersion, childId: seeded.children[0]! }), "VALIDATION");
    expect(await state(seeded.id)).toEqual(before);
  });
  test("a failure after insert rolls back inserted child, ordering, parent and audit", async () => {
    const { execute } = fixture(), seeded = await seed();
    const before = await state(seeded.id);
    await sql`alter table erp.template_variants add constraint deny_parent_touch check(updated_at < '2000-01-01') not valid`.execute(privileged!.db);
    try {
      await expect(execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Must roll back" }, beforeId: seeded.children[0]! })).rejects.toThrow();
      expect(await state(seeded.id)).toEqual(before);
    } finally { await sql`alter table erp.template_variants drop constraint deny_parent_touch`.execute(privileged!.db); }
  });
  test("simultaneous edits with the same parent version yield one success and one conflict", async () => {
    const { execute } = fixture(), seeded = await seed();
    const results = await Promise.allSettled(["First", "Second"].map((title) => execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title } })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ operationError: { code: "VERSION_CONFLICT" } });
    expect((await state(seeded.id)).rows).toHaveLength(3);
  });
  test("nested execution reuses the transaction; outer rollback undoes everything", async () => {
    const { execute } = fixture(), seeded = await seed();
    const before = await state(seeded.id);
    await expect(withDbSession(restricted!.db, session, async (trx) => {
      await sql`select id from erp.template_variants where id=${seeded.id}::uuid for update`.execute(trx);
      await execute.inTransaction(trx, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Nested" } });
      throw new Error("Outer rollback");
    })).rejects.toThrow("Outer rollback");
    expect(await state(seeded.id)).toEqual(before);
  });
  test("explicit transaction entry refuses a mismatched verified session", async () => {
    const { execute } = fixture(), seeded = await seed();
    await fails(withDbSession(restricted!.db, session, (trx) => execute.inTransaction(trx, { ...session, userId: randomUUID() }, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Denied" } })), "FORBIDDEN");
    expect((await state(seeded.id)).events).toBe(0);
  });
  test("non-sortable insert needs no child update Operation and leaves sibling versions untouched", async () => {
    const f = fixture(), seeded = await seed();
    const relation = f.parent.source!.graphql!.relationships![0]!;
    relation.sortable = false; delete relation.positionColumn;
    f.child.columns = f.child.columns.filter((column) => column.name !== "parent_id_position");
    f.operations.splice(f.operations.findIndex((op) => op.entityName === "Block" && op.intent === "update"), 1);
    const old = await sql`select id, updated_at::text from erp.blocks order by id`.execute(privileged!.db);
    await sql`alter table erp.blocks alter column parent_id_position set default 0`.execute(privileged!.db);
    try {
      const result = await f.execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Unordered child" } });
      expect(result.orderedIds).toEqual([...seeded.children, result.childId].sort());
      const after = await sql`select id, updated_at::text from erp.blocks where id<>${result.childId}::uuid order by id`.execute(privileged!.db);
      expect(after.rows).toEqual(old.rows);
      expect((await state(seeded.id)).events).toBe(2);
      await fails(f.execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: await version(seeded.id), values: { title: "Denied" }, beforeId: null }), "BAD_USER_INPUT");
      await fails(f.execute(restricted!.db, session, { ...binding, action: "move" }, { id: seeded.id, expectedVersion: await version(seeded.id), childId: result.childId }), "RELATION_COLLECTION_MUTATION_UNSUPPORTED");
    } finally { await sql`alter table erp.blocks alter column parent_id_position drop default`.execute(privileged!.db); }
  });
  test("insert permits empty optional descendant collections, never nested inputs or required descendants", async () => {
    const f = fixture(), seeded = await seed();
    f.child.source!.graphql!.relationships!.push({ ...f.parent.source!.graphql!.relationships![0]!, fieldKey: "descendants", name: "descendants", cardinality: { min: 0 } });
    const result = await f.execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Has optional descendants" } });
    expect(result.childId).toBeTruthy();
    await fails(f.execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: await version(seeded.id), values: { title: "Denied", descendants: [] } }), "BAD_USER_INPUT");
  });
  test("tenant and membership checks reject foreign parents, children and beforeId", async () => {
    const { execute } = fixture(), seeded = await seed(), foreign = await seed(1, otherTenant);
    const before = await state(seeded.id);
    await fails(execute(restricted!.db, { ...session, tenantId: otherTenant }, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Denied" } }), "NOT_FOUND");
    await fails(execute(restricted!.db, session, { ...binding, action: "move" }, { id: seeded.id, expectedVersion: seeded.expectedVersion, childId: foreign.children[0]! }), "BAD_USER_INPUT");
    await fails(execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Denied" }, beforeId: foreign.children[0]! }), "BAD_USER_INPUT");
    await expect(sql`update erp.blocks set parent_id=${foreign.id}::uuid where id=${seeded.children[0]!}::uuid`.execute(privileged!.db)).rejects.toThrow("violates foreign key constraint");
    expect(await state(seeded.id)).toEqual(before);
  });
  test("authored parent/child roles cannot be bypassed by the binding", async () => {
    const seeded = await seed();
    for (const [entity, intent] of [["TemplateVariant", "update"], ["Block", "list"], ["Block", "create"], ["Block", "update"]]) {
      const { execute, operations } = fixture();
      operations.find((op) => op.entityName === entity && op.intent === intent)!.authorization.roles = ["Synthetic.Denied"];
      await fails(execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Denied" } }), "FORBIDDEN");
    }
    expect((await state(seeded.id)).events).toBe(0);
  });
  test("record edit and create permission requirements are enforced transactionally", async () => {
    const seeded = await seed();
    for (const which of ["parent", "child"] as const) {
      const f = fixture();
      f[which].source!.authorization!.recordPermissions = { field: "permissions", column: "permissions", empty: "restricted", createRequires: ["view", "edit"] };
      await fails(f.execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Denied" } }), "FORBIDDEN");
    }
    const empty = await seed(0), f = fixture();
    f.child.source!.authorization!.recordPermissions = { field: "permissions", column: "permissions", empty: "restricted", createRequires: ["view", "edit"] };
    await fails(f.execute(restricted!.db, session, binding, { id: empty.id, expectedVersion: empty.expectedVersion, values: { title: "Denied", permissions: {} } }), "FORBIDDEN");
    expect((await state(seeded.id)).events).toBe(0);
  });
  test("visible but non-editable siblings cannot be reordered; authorized record ACLs succeed", async () => {
    const f = fixture(), seeded = await seed();
    f.child.source!.authorization!.recordPermissions = { field: "permissions", column: "permissions", empty: "restricted", createRequires: ["view", "edit"] };
    const allowed = { view: { users: [actor] }, edit: { users: [actor] } };
    await sql`update erp.blocks set permissions=${jsonbLiteral(allowed)}`.execute(privileged!.db);
    const result = await f.execute(restricted!.db, session, { ...binding, action: "move" }, { id: seeded.id, expectedVersion: seeded.expectedVersion, childId: seeded.children[1]!, beforeId: seeded.children[0]! });
    expect(result.orderedIds).toEqual([...seeded.children].reverse());
    const readOnly = { view: { users: [actor] }, edit: { users: [randomUUID()] } };
    await sql`update erp.blocks set permissions=${jsonbLiteral(readOnly)} where id=${seeded.children[0]!}::uuid`.execute(privileged!.db);
    const before = await state(seeded.id);
    await fails(f.execute(restricted!.db, session, { ...binding, action: "move" }, { id: seeded.id, expectedVersion: before.version, childId: seeded.children[0]!, beforeId: seeded.children[1]! }), "FORBIDDEN");
    expect(await state(seeded.id)).toEqual(before);
  });
  test("UPDATE RLS cannot hide siblings from cardinality and ordering checks", async () => {
    const f = fixture(), seeded = await seed();
    f.parent.source!.graphql!.relationships![0]!.cardinality = { max: 2 };
    const before = await state(seeded.id);
    await sql`create policy deny_edits on erp.blocks as restrictive for update using(false)`.execute(privileged!.db);
    try {
      await fails(f.execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Denied" } }), "FORBIDDEN");
      expect(await state(seeded.id)).toEqual(before);
    } finally { await sql`drop policy deny_edits on erp.blocks`.execute(privileged!.db); }
  });
  test("manifest binding and authored value validation reject unrecognized inputs", async () => {
    const { execute } = fixture(), seeded = await seed();
    for (const altered of [{ ...binding, field: "missing" }, { ...binding, entityName: "Missing" }]) {
      await fails(execute(restricted!.db, session, altered, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Denied" } }), "RELATION_COLLECTION_MUTATION_UNSUPPORTED");
    }
    for (const values of [{}, { title: 42 }, { title: "" }]) {
      await fails(execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values }), "BAD_USER_INPUT");
    }
    await fails(execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Denied" }, table: "erp.blocks" } as never), "BAD_USER_INPUT");
    expect((await state(seeded.id)).events).toBe(0);
  });
  test("incomplete entityValue storage metadata fails closed before any committed write", async () => {
    const seeded = await seed();
    const before = await state(seeded.id);
    for (const entityName of ["TemplateVariant", "Block"]) {
      for (const references of [[], [{ fieldKey: "version", targetEntity: "TemplateVersion", schema: "erp", table: "template_versions", column: "template_version_id", required: true }]]) {
        const registry = createEntityValueRegistry({ version: 1, collections: [], carriers: [{
          entityName, fieldKey: "values", definitionField: "definitionKey", schema: "erp", table: entityName === "Block" ? "blocks" : "template_variants",
          valuesColumn: "logical_payload", definitionColumn: "definition_key", definitions: {
            SyntheticDefinition: { entityName: "SyntheticDefinition", schemaVersion: 1, definitionHash: "a".repeat(64), fields: [], valueSchema: { type: "object", properties: {} }, references },
          },
        }] });
        const f = fixture(registry);
        const carrier = entityName === "Block" ? f.child : f.parent;
        carrier.columns.push(column("logical_payload", "jsonb", { sourceField: "values" }));
        for (const action of ["insert", "move"] as const) {
          await fails(f.execute(restricted!.db, session, { ...binding, action }, {
            id: seeded.id, expectedVersion: seeded.expectedVersion,
            ...(action === "insert" ? { values: { definitionKey: "SyntheticDefinition", values: { version: randomUUID(), parameters: {} } } } : { childId: seeded.children[0]! }),
          }), "INVALID_DEFINITION");
        }
      }
    }
    expect(await state(seeded.id)).toEqual(before);
  });
  test("entityValue create splits typed IDs into real FKs and read projection exposes only logical values", async () => {
    const f = valueFixture(), seeded = await seed(0);
    f.child.realtime!.visibilityColumns.push("ev_values_include_version_id");
    const row = await insertValue(f, seeded.id, { version: seeded.id, parameters: { label: "Synthetic" } });
    const raw = await storedValue(String(row.id));
    expect(raw.payload).toEqual({ parameters: { label: "Synthetic" } });
    expect(raw.ev_values_include_version_id).toBe(seeded.id);
    expect(raw.ev_values_include_alternate_id).toBeNull();
    const logical = { version: seeded.id, alternate: null, parameters: { label: "Synthetic" } };
    expect(row.payload).toEqual(logical);
    expect(Object.hasOwn(row, "ev_values_include_version_id")).toBe(false);
    const projected = projectRows(f.child, session, [raw], f.registry)[0]!;
    expect(projected.payload).toEqual(logical);
    const output = serializeEntityRow(f.child, projected, f.registry);
    expect(output.values).toEqual(logical);
    expect(JSON.stringify(output)).not.toContain("evValuesInclude");
    expect(JSON.stringify(output)).not.toContain("ev_values_include");
    const events = await sql<{ payload: unknown }>`select payload from platform.entity_events`.execute(privileged!.db);
    expect(JSON.stringify(events.rows)).not.toContain("ev_values_include");
  });
  test("entityValue text-only values receive canonical defaults and validation too", async () => {
    const f = valueFixture(), seeded = await seed(0);
    const row = await insertValue(f, seeded.id, {}, "Text");
    expect(row.payload).toEqual({ caption: "Untitled" });
    const before = await state(seeded.id);
    for (const values of [{ caption: "" }, { caption: 1 }, { unexpected: true }]) {
      await expect(insertValue(f, seeded.id, values, "Text")).rejects.toThrow();
    }
    expect(await state(seeded.id)).toEqual(before);
    const corrupt = { ...await storedValue(String(row.id)), payload: { caption: 1 } };
    expect(() => projectGeneratedEntityRow(f.child, session, corrupt, f.registry)).toThrow();
  });
  test("entityValue update uses the locked discriminator, clears omitted optional FKs and preserves version guards", async () => {
    const f = valueFixture(), seeded = await seed(0), other = await seed(0);
    const row = await insertValue(f, seeded.id, { version: seeded.id, alternate: other.id });
    const id = String(row.id), raw = await storedValue(id);
    const operation = f.operations.find((op) => op.entityName === "Block" && op.intent === "update")!;
    const guard = { operation: { ...operation, intent: "update" as const }, expectedVersion: String(raw.updated_at) };
    const updated = await updateGeneratedEntityForTable(restricted!.db, session, f.child, id, { values: { version: other.id, parameters: { label: "Changed" } } }, f.context, guard);
    expect(updated!.payload).toEqual({ version: other.id, alternate: null, parameters: { label: "Changed" } });
    const stored = await storedValue(id);
    expect(stored.definition_key).toBe("Include");
    expect(stored.ev_values_include_version_id).toBe(other.id);
    expect(stored.ev_values_include_alternate_id).toBeNull();
    expect(stored.payload).toEqual({ parameters: { label: "Changed" } });
    await fails(updateGeneratedEntityForTable(restricted!.db, session, f.child, id, { values: { version: seeded.id } }, f.context, guard), "VERSION_CONFLICT");
    expect(await storedValue(id)).toEqual(stored);
    for (const input of [{ definitionKey: "Text" }, { definitionKey: "Include" }, { definition_key: "Text" }]) {
      await fails(updateGeneratedEntityForTable(restricted!.db, session, f.child, id, input, f.context), "BAD_USER_INPUT");
    }
  });
  test("entityValue never accepts caller-supplied physical columns or JSON-embedded storage keys", async () => {
    const f = valueFixture(), seeded = await seed(0);
    const row = await insertValue(f, seeded.id, { version: seeded.id });
    const before = await storedValue(String(row.id));
    for (const key of ["ev_values_include_version_id", "evValuesIncludeVersionId", "payload"]) {
      const extra = { [key]: seeded.id };
      await fails(createGeneratedEntityForTable(restricted!.db, session, f.child, { title: "Denied", parent: seeded.id, parentIdPosition: 1, definitionKey: "Include", values: { version: seeded.id }, ...extra }, f.context), "BAD_USER_INPUT");
      await fails(updateGeneratedEntityForTable(restricted!.db, session, f.child, String(row.id), extra, f.context), "BAD_USER_INPUT");
    }
    for (const values of [{ version: seeded.id, ev_values_include_version_id: seeded.id }, { version: "invalid" }, { version: seeded.id, parameters: { undeclared: true } }, {}]) {
      await expect(insertValue(f, seeded.id, values)).rejects.toThrow();
    }
    expect(await storedValue(String(row.id))).toEqual(before);
    expect((await state(seeded.id)).rows).toHaveLength(1);
  });
  test("entityValue references require target read role, record view, tenant and existence in the write transaction", async () => {
    const f = valueFixture(), seeded = await seed(0), foreign = await seed(0, otherTenant);
    const before = await state(seeded.id);
    // The role-ungated child IO helper must still enforce target read rights.
    await fails(insertValue(f, seeded.id, { version: seeded.id }, "Include", { ...session, roles: [] }), "FORBIDDEN");
    for (const versionId of [foreign.id, randomUUID()]) await fails(insertValue(f, seeded.id, { version: versionId }), "FORBIDDEN");
    f.parent.source!.authorization!.recordPermissions = { field: "permissions", column: "permissions", empty: "restricted", createRequires: [] };
    await fails(insertValue(f, seeded.id, { version: seeded.id }), "FORBIDDEN");
    expect(await state(seeded.id)).toEqual(before);
    await sql`update erp.template_variants set permissions=${jsonbLiteral({ view: { users: [actor] } })} where id=${seeded.id}::uuid`.execute(privileged!.db);
    const row = await insertValue(f, seeded.id, { version: seeded.id });
    expect(row.payload).toEqual({ parameters: {}, version: seeded.id, alternate: null });
    const raw = await storedValue(String(row.id));
    await fails(updateGeneratedEntityForTable(restricted!.db, session, f.child, String(row.id), { values: { version: foreign.id } }, f.context), "FORBIDDEN");
    expect(await storedValue(String(row.id))).toEqual(raw);
  });
  test("entityValue collection insert and move use the same IO path and canonical definition allowlist", async () => {
    const f = valueFixture(), seeded = await seed(0);
    const request = { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Included", definitionKey: "Include", values: { version: seeded.id } } };
    const first = await f.execute(restricted!.db, session, binding, request);
    expect((await storedValue(first.childId)).ev_values_include_version_id).toBe(seeded.id);
    const second = await f.execute(restricted!.db, session, binding, { ...request, expectedVersion: await version(seeded.id), values: { title: "Text", definitionKey: "Text", values: { caption: "Hello" } } });
    const moved = await f.execute(restricted!.db, session, { ...binding, action: "move" }, { id: seeded.id, expectedVersion: await version(seeded.id), childId: second.childId, beforeId: first.childId });
    expect(moved.orderedIds).toEqual([second.childId, first.childId]);
    await fails(valueFixture(["Text"]).execute(restricted!.db, session, binding, { ...request, expectedVersion: await version(seeded.id) }), "BAD_USER_INPUT");
    await fails(valueFixture([]).execute(restricted!.db, session, binding, { ...request, expectedVersion: await version(seeded.id) }), "RELATION_COLLECTION_MUTATION_UNSUPPORTED");
    expect((await state(seeded.id)).rows).toHaveLength(2);
  });
  test("entityValue writes and audit events roll back with the caller's outer transaction", async () => {
    const f = valueFixture(), seeded = await seed(0), before = await state(seeded.id);
    await expect(withDbSession(restricted!.db, session, async (trx) => {
      await f.execute.inTransaction(trx, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Rollback", definitionKey: "Include", values: { version: seeded.id } } });
      throw new Error("Typed rollback");
    })).rejects.toThrow("Typed rollback");
    expect(await state(seeded.id)).toEqual(before);
  });
  test("plugin implementations, confirmations, prerequisites, leases and hooks fail closed", async () => {
    const seeded = await seed();
    for (const intent of ["parent", "child"] as const) {
      for (const safeguard of ["plugin", "confirmation", "lease", "prerequisites", "hooks"]) {
        const f = fixture();
        const op = f.operations.find((op) => op.entityName === (intent === "parent" ? "TemplateVariant" : "Block") && op.intent === "update")!;
        if (safeguard === "plugin") op.implementation = { type: "plugin", plugin: "fixture", handler: "update" };
        if (safeguard === "confirmation") (op.interaction.confirmation as { mode: string }).mode = "required";
        if (safeguard === "lease") Object.assign(op.concurrency!, { editLease: { mode: "required" } });
        if (safeguard === "prerequisites") Object.assign(op, { prerequisites: [{ operation: "fixture" }] });
        if (safeguard === "hooks") Object.assign(op, { hooks: ["fixture"] });
        await fails(f.execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Denied" } }), "RELATION_COLLECTION_MUTATION_UNSUPPORTED");
      }
    }
  });
  test("immutable authored fields can be set once by collection insert, but not changed by update", async () => {
    const f = fixture(), seeded = await seed(0);
    f.child.columns.find((column) => column.name === "title")!.immutable = true;
    f.child.columns.push(column("version_number", "integer", { sourceField: "versionNumber", immutable: true }));
    const schema = f.operations.find((op) => op.entityName === "Block" && op.intent === "create")!.inputSchema!;
    const valuesSchema = (schema.properties as Record<string, { properties: Record<string, unknown> }>).values!;
    valuesSchema.properties.versionNumber = { type: "integer", minimum: 1 };
    const result = await f.execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Initial", versionNumber: 1 } });
    const row = await storedValue(result.childId);
    expect(row.title).toBe("Initial"); expect(row.version_number).toBe(1);
    await updateGeneratedEntityForTable(restricted!.db, session, f.child, result.childId, { title: "Changed", versionNumber: 2 });
    const unchanged = await storedValue(result.childId);
    expect(unchanged.title).toBe("Initial"); expect(unchanged.version_number).toBe(1);
  });
  test("no raw IDs, FKs, positions, writtenBy, unknown or nested fields can be written", async () => {
    const seeded = await seed();
    for (const values of [{ id: randomUUID() }, { parent: seeded.id }, { parent_id: seeded.id }, { parent_id_position: 9 }, { unknown: "value" }, { blocks: [] }]) {
      const { execute } = fixture();
      await fails(execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Denied", ...values } }), "BAD_USER_INPUT");
    }
    for (const policy of [{ writtenBy: [{ operation: "fixture", rest: "/fixture" }] }]) {
      const f = fixture(); Object.assign(f.child.columns.find((column) => column.name === "title")!, policy);
      await fails(f.execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Denied" } }), "BAD_USER_INPUT");
    }
    expect((await state(seeded.id)).events).toBe(0);
  });
  test("reference/junction/restricted-read collections and nested descendants remain unsupported", async () => {
    const seeded = await seed();
    for (const mode of ["reference", "junction", "restricted", "nested"]) {
      const f = fixture();
      if (mode === "reference") f.parent.source!.graphql!.relationships![0]!.ownership = "reference";
      if (mode === "junction") f.parent.source!.graphql!.relationships![0]!.via = "fixture_links";
      if (mode === "restricted") f.child.realtime!.readPredicate += " and false";
      if (mode === "nested") f.child.source!.graphql!.relationships!.push({ ...f.parent.source!.graphql!.relationships![0]!, cardinality: { min: 1 } });
      await fails(f.execute(restricted!.db, session, binding, { id: seeded.id, expectedVersion: seeded.expectedVersion, values: { title: "Denied" } }), "RELATION_COLLECTION_MUTATION_UNSUPPORTED");
    }
  });
});
