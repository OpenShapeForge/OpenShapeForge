// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { withDbSession } from "../../db/session.js";
import { applyAppHelpersMigration } from "../../db/migrations/app-helpers.js";
import { auditContext, runWithAuditContext, withAuditContext } from "../../platform/audit-context.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { labelSourceOperation, readLabelPages, type LabelPage, type LabelSource } from "./label-search.js";
import { entityOperationRef, executeEntityOperation } from "./runtime.js";
import { serializeEntityRow } from "./serialize-result.js";
import { nativeApplicationSearchHandler } from "../application-search.js";
import { generatedCrudTables } from "./table-registry.js";
import type { GeneratedCrudTable } from "./types.js";

// The combined label read must be indistinguishable from each entity's own
// list Operation: same rows, same order, same continuation, same refusals.
// Every case below asks both and compares, and separately proves that every
// row the list would give is reachable through the search continuation — a
// subset comparison alone would also pass for a read that returns nothing.

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const scratchName = `label_search_${randomUUID().replaceAll("-", "")}`;
const tenant = randomUUID(), foreignTenant = randomUUID(), user = randomUUID(), otherUser = randomUUID();
let admin: SQL | undefined, privileged: DatabaseRuntime | undefined, restricted: DatabaseRuntime | undefined, created = false;
const firstBase = getGeneratedCrudTables().find(table => table.source?.authoringEntityName === "Relation")!;
const secondBase = getGeneratedCrudTables().find(table => table.source?.authoringEntityName === "ContactDetail")!;
const column = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ name, type, primaryKey: name === "id", required: false, generated: null, ...extra });
const shaped = (base: GeneratedCrudTable): GeneratedCrudTable => ({ ...base, columns: [column("id", "uuid"), column("tenant_id", "uuid"), column("viewer", "uuid"), column("name", "text"), column("description", "text"), column("secret", "text", { classification: "pii" })], source: { ...base.source, computedFields: [], graphql: { ...base.source!.graphql!, relationships: [] } } } as GeneratedCrudTable);
const first = shaped(firstBase), second = shaped(secondBase);
const readRoles = (base: GeneratedCrudTable) => base.source?.authorization?.roles.read ?? [];
const session = { tenantId: tenant, userId: user, roles: [...new Set([...readRoles(firstBase), ...readRoles(secondBase)])], scope: "self" as const };
const readOnly = { ...session, roles: session.roles.filter(role => role.endsWith(".Read")) };

function databaseUrl(app = false) {
  const url = new URL(adminUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") throw new Error("Scratch tests require a local postgres admin database.");
  url.pathname = `/${scratchName}`;
  if (app) { url.username = "openshapeforge_app"; url.password = "openshapeforge_app"; }
  return url.toString();
}

const previous = new Map<string, GeneratedCrudTable | undefined>();
beforeAll(async () => {
  databaseUrl(); admin = new SQL(adminUrl, { max: 1 });
  const roles = await admin`select rolsuper, rolbypassrls from pg_roles where rolname = 'openshapeforge_app'`;
  if (roles.length !== 1 || roles[0].rolsuper || roles[0].rolbypassrls) throw new Error("A restricted application role is required.");
  await admin.unsafe(`create database "${scratchName}"`); created = true;
  privileged = createDatabaseRuntime({ databaseUrl: databaseUrl(), maxConnections: 1 });
  await applyAppHelpersMigration(privileged.db);
  const generatorPath = new URL("../../../../../packages/compiler/src/generate.ts", import.meta.url).pathname;
  const { generateArtifacts } = await import(generatorPath);
  const storage = (table: GeneratedCrudTable) => ({ schema: table.schema, name: table.table, tenantScoped: true, columns: table.columns.map(({ generated: _generated, ...entry }) => entry), rowScope: { userColumns: ["viewer"], nullVisibleColumns: ["viewer"] }, indexes: [{ name: `${table.table}_tenant_id_key`, columns: ["tenant_id", "id"], unique: true }] });
  const artifacts = generateArtifacts({ version: 1, tables: [storage(first), storage(second)] });
  await sql.raw(artifacts.find((entry: { path: string }) => entry.path.endsWith("schema.sql"))!.contents).execute(privileged.db);
  await sql`create schema if not exists platform; create table platform.entity_edit_leases (id uuid, tenant_id uuid, entity_id text, target_id text, operation_id text, owner_user_id uuid, owner_display_name text, acquired_version text, inactivity_timeout_seconds integer, expires_at timestamptz); create table platform.field_value_since(tenant_id uuid,entity_type text,record_id text,field_key text,since_at timestamptz); alter table platform.field_value_since enable row level security; alter table platform.field_value_since force row level security; create policy tenant on platform.field_value_since using (tenant_id=app.current_tenant()); grant usage on schema platform to openshapeforge_app; grant select on platform.entity_edit_leases, platform.field_value_since to openshapeforge_app`.execute(privileged.db);
  await sql`grant usage on schema app, erp to openshapeforge_app; grant select, insert, update, delete on all tables in schema erp to openshapeforge_app; grant execute on all functions in schema app to openshapeforge_app`.execute(privileged.db);
  restricted = createDatabaseRuntime({ databaseUrl: databaseUrl(true), maxConnections: 1 });
  for (const table of [first, second]) {
    previous.set(table.name, generatedCrudTables.get(table.name)); generatedCrudTables.set(table.name, table);
    const target = sql.id(table.schema, table.table);
    // Twelve visible matches (more than one page), one match by description
    // only, and matches this session must never see: another member's row
    // and another tenant's.
    await sql`insert into ${target}(id,tenant_id,viewer,name,description,secret) select gen_random_uuid(),${tenant}::uuid,${user}::uuid,'Needle '||n,'plain','s' from generate_series(1,12) n`.execute(privileged.db);
    await sql`insert into ${target}(id,tenant_id,viewer,name,description,secret) values
      (gen_random_uuid(),${tenant}::uuid,null,'Shared','holds a NEEDLE inside','s'),
      (gen_random_uuid(),${tenant}::uuid,${user}::uuid,'Unrelated','nothing','needle'),
      (gen_random_uuid(),${tenant}::uuid,${otherUser}::uuid,'Needle of another member','plain','s'),
      (gen_random_uuid(),${foreignTenant}::uuid,${user}::uuid,'Needle of another tenant','plain','s')`.execute(privileged.db);
  }
}, 30000);
afterAll(async () => {
  for (const [name, table] of previous) { if (table) generatedCrudTables.set(name, table); else generatedCrudTables.delete(name); }
  await restricted?.close(); await privileged?.close();
  if (created) await admin?.unsafe(`drop database "${scratchName}" with (force)`);
  await admin?.close();
});

const filterFor = (query: string) => ({ or: [{ name: { contains: query } }, { description: { contains: query } }] });
const sourcesFor = (query: string, tables = [first, second]): LabelSource[] =>
  tables.map(table => ({ key: table.name, table, filter: filterFor(query), labelField: "name" }));

/** One page of an entity's own list Operation, reduced the way search reduces it. */
async function listed(actor: typeof session, table: GeneratedCrudTable, query: string, limit: number, cursor?: string): Promise<LabelPage | "refused"> {
  const result = await executeEntityOperation(restricted!.db, actor, { operation: entityOperationRef(table, "list"), input: { filter: filterFor(query), limit, ...(cursor ? { cursor } : {}) }, offerIntents: [] });
  if ("error" in result) return "refused";
  if (result.intent !== "list") throw new Error("Expected a list result.");
  const items = result.data.items.flatMap(item => {
    const value = serializeEntityRow(table, item.data);
    return typeof value.id === "string" && typeof value.name === "string" ? [{ id: value.id, label: value.name }] : [];
  });
  return { items, nextCursor: result.data.nextCursor };
}

/** The combined read, admitted the way application search admits it. */
const combined = (actor: typeof session, sources: LabelSource[], limit: number, declare = true) =>
  withAuditContext("application.search", undefined, () => runWithAuditContext(
    { ...auditContext()!, readOperations: declare ? sources.map(source => labelSourceOperation(source.table)) : [] },
    () => withDbSession(restricted!.db, actor, trx => readLabelPages(trx, actor, sources, limit))));

test("each branch equals that entity's own list page, for hits, more than a page, and no hits", async () => {
  for (const [query, limit] of [["needle", 5], ["needle", 50], ["NEEDLE", 3], ["shared", 5], ["absent", 5]] as const) {
    const pages = await combined(session, sourcesFor(query), limit);
    for (const table of [first, second]) {
      const own = await listed(session, table, query, limit);
      if (own === "refused") throw new Error("The list Operation refused an authorized read.");
      // An entity without hits has no group, exactly as search reports it.
      expect(pages!.get(table.name) ?? { items: [], nextCursor: null }).toEqual(own);
    }
  }
});

test("every row the list gives is reachable from the combined first page and its continuation", async () => {
  const pages = await combined(session, sourcesFor("needle"), 5);
  for (const table of [first, second]) {
    const reached = [...pages!.get(table.name)!.items];
    for (let cursor = pages!.get(table.name)!.nextCursor; cursor;) {
      const next = await listed(session, table, "needle", 5, cursor);
      if (next === "refused") throw new Error("The continuation was refused.");
      reached.push(...next.items); cursor = next.nextCursor;
    }
    const everything = await listed(session, table, "needle", 200);
    if (everything === "refused") throw new Error("The list Operation refused an authorized read.");
    // Twelve by name and one by description; never the secret-only match,
    // another member's row or another tenant's.
    expect(reached).toHaveLength(13);
    expect(reached).toEqual(everything.items);
    expect(reached.map(item => item.label).filter(label => label.includes("another"))).toEqual([]);
    expect(reached.map(item => item.label)).not.toContain("Unrelated");
  }
});

test("a session without the list role gets no branch, as its list Operation would refuse", async () => {
  const noRoles = { ...session, roles: [] as string[] };
  expect(await listed(noRoles, first, "needle", 5)).toBe("refused");
  expect([...(await combined(noRoles, sourcesFor("needle"), 5))!.keys()]).toEqual([]);
  // Holding one entity's role reads that entity only.
  const onlyFirst = { ...session, roles: readRoles(firstBase) };
  const partial = await combined(onlyFirst, sourcesFor("needle"), 5);
  expect(partial!.has(first.name)).toBe(true);
  expect(partial!.has(second.name)).toBe(readRoles(firstBase).some(role => readRoles(secondBase).includes(role)));
});

test("filtering by a classified field is refused for a reader, in both paths", async () => {
  const bySecret = (table: GeneratedCrudTable): LabelSource => ({ key: table.name, table, filter: { or: [{ secret: { contains: "needle" } }] }, labelField: "name" });
  const result = await executeEntityOperation(restricted!.db, readOnly, { operation: entityOperationRef(first, "list"), input: { filter: { or: [{ secret: { contains: "needle" } }] }, limit: 5 }, offerIntents: [] });
  expect("error" in result).toBe(true);
  expect([...(await combined(readOnly, [bySecret(first), bySecret(second)], 5))!.keys()]).toEqual([]);
});

test("without the declared read dependencies nothing is read", async () => {
  expect(await combined(session, sourcesFor("needle"), 5, false)).toBeUndefined();
  // Declaring one of two is not enough either.
  const partial = withAuditContext("application.search", undefined, () => runWithAuditContext(
    { ...auditContext()!, readOperations: [labelSourceOperation(first)] },
    () => withDbSession(restricted!.db, session, trx => readLabelPages(trx, session, sourcesFor("needle"), 5))));
  expect(await partial).toBeUndefined();
});

test("an authorization profile state narrows a branch exactly as it narrows the list", async () => {
  // Both reads inside one transaction that carries the same profile rules:
  // the list under its own Operation, the combined read under search with the
  // list declared. Only rows named `Needle 1`..`Needle 3` are granted.
  const granted = ["Needle 1", "Needle 2", "Needle 3"];
  // A managed list names the fields it carries. The first entity's carries
  // the fields search reads; the second's carries only its description, so
  // a filter by name is outside what that list may be asked.
  const state = (table: GeneratedCrudTable) => ({ entity: table.source!.authoringEntityName!, managed: true, grantable: true,
    fields: { name: { column: "name", type: "text" } },
    rules: [{ left: { kind: "path", path: "resource.name" }, operator: "in", right: { kind: "literal", value: granted } }],
    listFields: table === second ? ["description"] : ["name", "description"] });
  const rules = { actor: {}, managedEntities: [], states: Object.fromEntries([first, second].map(table => [labelSourceOperation(table), state(table)])) };
  // A profile binds to the session object it was read for.
  const actor = { ...session };
  const outcome = await withAuditContext("application.search", undefined, () => runWithAuditContext(
    { ...auditContext()!, readOperations: [first, second].map(labelSourceOperation) },
    () => withDbSession(restricted!.db, actor, async trx => {
      await sql`select set_config('app.authorization_rules', ${JSON.stringify(rules)}, true)`.execute(trx);
      const pages = await readLabelPages(trx, actor, sourcesFor("needle"), 50);
      return { pages, ownFirst: await listed(actor, first, "needle", 50), ownSecond: await listed(actor, second, "needle", 50) };
    })));
  if (outcome.ownFirst === "refused") throw new Error("The list Operation refused an authorized read.");
  expect(outcome.pages!.get(first.name)).toEqual(outcome.ownFirst);
  expect(outcome.ownFirst.items.map(item => item.label).sort()).toEqual(granted);
  expect(outcome.ownSecond).toBe("refused");
  expect(outcome.pages!.has(second.name)).toBe(false);
});

test("application search answers the same through one statement, however many sources it has", async () => {
  let statements = 0;
  const counted = createDatabaseRuntime({ databaseUrl: databaseUrl(true), maxConnections: 1, log: event => { if (event.level === "query") statements += 1; } });
  try {
    const source = (table: GeneratedCrudTable) => ({ entity: table.source!.authoringEntityName!, labels: { en: table.source!.authoringEntityName! }, description: "", list: entityOperationRef(table, "list").id, field: "name", descriptionField: "description" });
    const search = (tables: GeneratedCrudTable[], oneStatement: boolean) => {
      const operation = { key: "application.search", plugin: "core", auth: { mode: "session" }, tenancy: { mode: "required" }, effects: { data: "read", external: "none" }, implementation: { type: "application-search", sources: tables.map(source) } };
      const platform = {
        operations: {
          get: async (_session: unknown, id: string) => ({ id, intent: "list", input: { kind: "json-schema", schema: { properties: { filter: {}, limit: {} } } } }),
          execute: async (actor: typeof session, request: { operation: { id: string; intent: "list" }; input: Record<string, unknown> }) =>
            executeEntityOperation(counted.db, actor, { operation: request.operation, input: request.input, offerIntents: [] }),
        },
        ...(oneStatement ? { db: { withSession: (actor: typeof session, work: (trx: never) => Promise<unknown>) => withDbSession(counted.db, actor, work as never) } } : {}),
      };
      return withAuditContext("application.search", undefined, async () => {
        statements = 0;
        const result = await nativeApplicationSearchHandler(operation as never)({ query: "needle", locale: "en", first: 5 }, { session, platform } as never);
        return { value: "value" in result ? result.value : undefined, statements };
      });
    };
    const perSource = await search([first, second], false);
    const one = await search([first], true), two = await search([first, second], true);
    // The same groups, items and continuations as the per-source Operations.
    expect(two.value).toEqual(perSource.value);
    expect((two.value as { groups: unknown[] }).groups).toHaveLength(2);
    // A second source adds a branch to the statement, not statements.
    expect(two.statements).toBe(one.statements);
    expect(two.statements).toBeLessThan(perSource.statements);
    if (process.env.LABEL_SEARCH_REPORT) console.log(`statements: per source (2 sources) ${perSource.statements}, combined (1 source) ${one.statements}, combined (2 sources) ${two.statements}`);
  } finally { await counted.close(); }
});
