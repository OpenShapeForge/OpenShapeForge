// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { applyAppHelpersMigration } from "../../db/migrations/app-helpers.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { listGeneratedEntityRelation } from "./relations.js";
import type { GeneratedCrudRelationship, GeneratedCrudTable } from "./types.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const suite = describe;
const scratchName = `schema3_rel_${randomUUID().replaceAll("-", "")}`;
const tenant = randomUUID(), otherTenant = randomUUID(), actor = randomUUID(), otherActor = randomUUID();
const pageId = randomUUID(), hiddenPage = randomUUID(), foreignPage = randomUUID();
const first = randomUUID(), second = randomUUID(), hidden = randomUUID(), foreign = randomUUID();
let admin: SQL | undefined, privileged: DatabaseRuntime | undefined, restricted: DatabaseRuntime | undefined;
let created = false;
const sourceDefinition = getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === "Relation")!;
const targetDefinition = getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === "ContactDetail")!;
const ownColumns = ["id", "tenant_id", "viewer", "title"].map((name) => ({ name, type: name === "title" ? "text" : "uuid", primaryKey: name === "id", required: name === "id" || name === "tenant_id", generated: null }));
const inverse: GeneratedCrudRelationship = { name: "children", fieldKey: "children", kind: "hasMany", resolve: "hasMany", type: "[ContactDetail!]!", target: "ContactDetail", foreignKey: "parent_id", sortable: true, positionColumn: "parent_id_position" };
const association: GeneratedCrudRelationship = { name: "linked", fieldKey: "linked", kind: "manyToMany", resolve: "hasMany", type: "[ContactDetail!]!", target: "ContactDetail", via: "relation_links", viaSchema: "erp", sortable: true, positionColumn: "position" };
const belongsTo: GeneratedCrudRelationship = { name: "parent", fieldKey: "parent", kind: "belongsTo", resolve: "belongsTo", type: "Relation", target: "Relation", foreignKey: "parent_id" };
const parentTable: GeneratedCrudTable = { ...sourceDefinition, columns: ownColumns, source: { ...sourceDefinition?.source, authoringVersion: 3, computedFields: [], graphql: { ...sourceDefinition?.source?.graphql!, relationships: [inverse, association] } } };
const childTable: GeneratedCrudTable = { ...targetDefinition, columns: [...ownColumns, { name: "parent_id", sourceField: "parent", type: "uuid", primaryKey: false, required: false, generated: null }, { name: "parent_id_position", type: "integer", primaryKey: false, required: true, generated: null }], source: { ...targetDefinition?.source, authoringVersion: 3, computedFields: [], graphql: { ...targetDefinition?.source?.graphql!, relationships: [belongsTo] } } };
const session = { tenantId: tenant, userId: actor, roles: [...new Set([...(sourceDefinition?.source?.authorization?.roles.read ?? []), ...(targetDefinition?.source?.authorization?.roles.read ?? [])])], scope: "self" as const };

function databaseUrl(app = false) {
  const url = new URL(adminUrl!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") throw new Error("Scratch tests require a local postgres admin database, never an application database.");
  url.pathname = `/${scratchName}`;
  if (app) { url.username = "openshapeforge_app"; url.password = "openshapeforge_app"; }
  return url.toString();
}

suite("schema-3 relation traversal against PostgreSQL", () => {
  beforeAll(async () => {
    databaseUrl();
    admin = new SQL(adminUrl!, { max: 1 });
    const roles = await admin`select rolsuper, rolbypassrls from pg_roles where rolname = 'openshapeforge_app'`;
    if (roles.length !== 1 || roles[0].rolsuper || roles[0].rolbypassrls) throw new Error("An existing restricted application role is required; this test never changes shared roles.");
    await admin.unsafe(`create database "${scratchName}"`);
    created = true;
    privileged = createDatabaseRuntime({ databaseUrl: databaseUrl(), maxConnections: 1 });
    await applyAppHelpersMigration(privileged.db);
    const generatorPath = new URL("../../../../../packages/compiler/src/generate.ts", import.meta.url).pathname;
    const { generateArtifacts } = await import(generatorPath);
    const reference = (table: string, local: string) => ({ schema: "erp", table, column: "id", localColumns: ["tenant_id", local], targetColumns: ["tenant_id", "id"] });
    const storage = (table: GeneratedCrudTable) => ({
      schema: table.schema, name: table.table, tenantScoped: true,
      columns: table.columns.map(({ generated: _generated, ...column }) => ({ ...column, ...(column.name === "parent_id" ? { references: reference(parentTable.table, "parent_id") } : {}) })),
      rowScope: { userColumns: ["viewer"], nullVisibleColumns: ["viewer"] },
      indexes: [{ name: `${table.table}_tenant_id_key`, columns: ["tenant_id", "id"], unique: true }],
    });
    const artifacts = generateArtifacts({ version: 1, tables: [storage(parentTable), storage(childTable), {
      schema: "erp", name: "relation_links", tenantScoped: true,
      columns: [
        { name: "id", type: "uuid", primaryKey: true }, { name: "tenant_id", type: "uuid", required: true },
        { name: "source_id", type: "uuid", required: true, references: reference(parentTable.table, "source_id") },
        { name: "target_id", type: "uuid", required: true, references: reference(childTable.table, "target_id") },
        { name: "position", type: "integer", required: true },
      ], indexes: [{ name: "relation_links_unique_pair", columns: ["tenant_id", "source_id", "target_id"], unique: true }],
    }] });
    await sql.raw(artifacts.find((artifact: { path: string }) => artifact.path.endsWith("schema.sql")).contents).execute(privileged.db);
    await sql`grant usage on schema app, erp to openshapeforge_app; grant select, insert, update, delete on all tables in schema erp to openshapeforge_app; grant execute on all functions in schema app to openshapeforge_app`.execute(privileged.db);
    for (const [id, tenantId, viewer] of [[pageId, tenant, actor], [hiddenPage, tenant, otherActor], [foreignPage, otherTenant, actor]]) {
      await sql`insert into erp.relations(id, tenant_id, viewer, title) values (${id}::uuid, ${tenantId}::uuid, ${viewer}::uuid, 'Synthetic page')`.execute(privileged.db);
    }
    for (const [id, tenantId, viewer, parent, position] of [[first, tenant, actor, pageId, 20], [second, tenant, null, pageId, 10], [hidden, tenant, otherActor, pageId, 5], [foreign, otherTenant, actor, foreignPage, 0]]) {
      await sql`insert into erp.contact_details(id, tenant_id, viewer, title, parent_id, parent_id_position) values (${id}::uuid, ${tenantId}::uuid, ${viewer}::uuid, 'Synthetic block', ${parent}::uuid, ${position})`.execute(privileged.db);
    }
    for (const [id, position] of [[first, 20], [second, 10], [hidden, 5]]) {
      await sql`insert into erp.relation_links(id, tenant_id, source_id, target_id, position) values (${randomUUID()}::uuid, ${tenant}::uuid, ${pageId}::uuid, ${id}::uuid, ${position})`.execute(privileged.db);
    }
    restricted = createDatabaseRuntime({ databaseUrl: databaseUrl(true), maxConnections: 1 });
  }, 30_000);

  afterAll(async () => {
    await restricted?.close();
    await privileged?.close();
    if (created) await admin?.unsafe(`drop database "${scratchName}" with (force)`);
    await admin?.close();
  });

  for (const relationship of [inverse, association]) {
    test(`${relationship.kind}: reads ordered, authorized rows and counts only visible targets`, async () => {
      const result = await listGeneratedEntityRelation(restricted!.db, session, { parent: { id: pageId }, parentTable, targetTable: childTable, relationship, includeTotalCount: true });
      expect(result.rows.map((row) => row.id)).toEqual([second, first]);
      expect(result.totalCount).toBe(2);
      const page = await listGeneratedEntityRelation(restricted!.db, session, { parent: { id: pageId }, parentTable, targetTable: childTable, relationship, limit: 1 });
      const next = await listGeneratedEntityRelation(restricted!.db, session, { parent: { id: pageId }, parentTable, targetTable: childTable, relationship, limit: 1, cursor: page.nextCursor });
      expect(next.rows.map((row) => row.id)).toEqual([first]);
    });
  }
  test("rechecks parent visibility instead of trusting a previously read parent object", async () => {
    await sql`update erp.relations set viewer = ${otherActor}::uuid where id = ${pageId}::uuid`.execute(privileged!.db);
    try {
      for (const relationship of [inverse, association]) {
        const result = await listGeneratedEntityRelation(restricted!.db, session, { parent: { id: pageId }, parentTable, targetTable: childTable, relationship, includeTotalCount: true });
        expect(result.rows).toEqual([]); expect(result.totalCount).toBe(0);
      }
    } finally {
      await sql`update erp.relations set viewer = ${actor}::uuid where id = ${pageId}::uuid`.execute(privileged!.db);
    }
  });
  test("singular traversal uses the persisted FK, not a forged or stale parent value", async () => {
    const result = await listGeneratedEntityRelation(restricted!.db, session, { parent: { id: first, parent: hiddenPage, parent_id: hiddenPage }, parentTable: childTable, targetTable: parentTable, relationship: belongsTo });
    expect(result.rows.map((row) => row.id)).toEqual([pageId]);
  });
  test("a different tenant cannot traverse another tenant's parent", async () => {
    const result = await listGeneratedEntityRelation(restricted!.db, { ...session, tenantId: otherTenant }, { parent: { id: pageId }, parentTable, targetTable: childTable, relationship: association });
    expect(result.rows).toEqual([]);
  });
  test("missing entity roles and forged relationship metadata cannot bypass traversal", async () => {
    await expect(listGeneratedEntityRelation(restricted!.db, { ...session, roles: [] }, { parent: { id: pageId }, parentTable, targetTable: childTable, relationship: association })).rejects.toMatchObject({ operationError: { code: "FORBIDDEN" } });
    const result = await listGeneratedEntityRelation(restricted!.db, session, { parent: { id: pageId }, parentTable, targetTable: childTable, relationship: { ...association, via: "not_a_real_table" } });
    expect(result.rows.map((row) => row.id)).toEqual([second, first]);
  });
  test("generated composite FKs reject cross-tenant edges even for privileged SQL", async () => {
    await expect(sql`insert into erp.relation_links(id, tenant_id, source_id, target_id, position) values (${randomUUID()}::uuid, ${tenant}::uuid, ${pageId}::uuid, ${foreign}::uuid, 0)`.execute(privileged!.db)).rejects.toThrow("violates foreign key constraint");
    await expect(sql`update erp.contact_details set parent_id = ${foreignPage}::uuid where id = ${first}::uuid`.execute(privileged!.db)).rejects.toThrow("violates foreign key constraint");
  });
});
