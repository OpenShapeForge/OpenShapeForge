// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { sql } from "kysely";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import accounts from "../accounts/runtime.js";
import documents from "@openshapeforge/documents/runtime";
import versioning from "@openshapeforge/versioning/runtime";
import { createDatabaseRuntime } from "../db/connection.js";
import { withDbSession, withInvocationSavepoint } from "../db/session.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { applyAuditHistory, auditHistoryReady } from "../db/migrations/audit-history.js";
import { ModulePlatformRuntime } from "../modules/platform.js";
import { __buildGeneratedMcpServerForTests } from "../mcp/generated-mcp-server.js";
import { listOperationContracts, runtimeStaticOperationRegistrations } from "../operations/runtime.js";
import type { GeneratedCrudTable } from "../operations/entity/types.js";
import { jsonbLiteral } from "../db/sql-helpers.js";
import { withAuditContext } from "./audit-context.js";
import { auditFilterFields } from "./history-operations.js";
import { appendEntityEvent } from "./entity-events.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL;
if (!adminUrl) throw new Error("SCRATCH_ADMIN_DATABASE_URL must name the disposable test server.");
const tenant = crypto.randomUUID(), otherTenant = crypto.randomUUID(), actor = crypto.randomUUID();
const budget = crypto.randomUUID(), movedBudget = crypto.randomUUID(), line = crypto.randomUUID(), value = crypto.randomUUID(), contact = crypto.randomUUID();
const session = (tenantId: string, roles = ["Audit.Logs.ReadAll"]) => ({ tenantId, userId: actor, roles, groups: [], scope: "tenant" as const, credential: "trusted-context" as const, principalKind: "person" as const });

function table(entity: string, name: string, columns: string[], children: { name: string; target: string; foreignKey: string }[] = []): GeneratedCrudTable {
  return { name: `audit_probe.${name}`, schema: "audit_probe", table: name, primaryKey: "id", tenantScoped: true, domainInternal: false, generatedCrudEligible: true,
    columns: ["id", ...columns].map(column => ({ name: column, type: column === "exact_amount" ? "numeric" : "text", required: false, primaryKey: column === "id", generated: null, sourceField: column === "budget_id" ? "budgetId" : column === "line_id" ? "lineId" : column,
      ...(column === "private_note" ? { classification: "confidential" as const } : {}) })),
    source: { authoringEntityName: entity, graphql: { typeName: entity, singleQueryName: entity,
      listQueryName: entity, createMutationName: "create", updateMutationName: "update", deleteMutationName: "delete", relationships: children.map(child => ({ ...child, type: child.target, resolve: "hasMany" as const })) } } };
}
const tables = [table("ProbeBudget", "budgets", ["name"], [{ name: "lines", target: "ProbeLine", foreignKey: "budget_id" }]),
  table("ProbeLine", "lines", ["budget_id", "name"], [{ name: "values", target: "ProbeValue", foreignKey: "line_id" }]),
  table("ProbeValue", "amounts", ["line_id", "amount", "private_note", "exact_amount"]), table("ProbeContact", "contacts", ["name", "private_note"])];

tables[3]!.retention = { clock: { column: "name" }, rules: [{ id: "probe", action: "delete", duration: { maximum: { days: 1 } } }] };
tables[2]!.realtime = { readPredicate: "true", visibilityColumns: ["private_note"] };
tables[2]!.source!.computedFields = [{ field: "age", resolver: "temporalThreshold", trackedField: "amount", thresholdDays: "amount.limit" }];
tables[2]!.source!.graphql!.relationships!.push({ name: "amount", fieldKey: "amount", target: "TrackedTarget", type: "TrackedTarget", kind: "belongsTo", resolve: "belongsTo", foreignKey: "amount" });

test("AuditEvent YAML reads: uniform transactional registration, structured filters, raw details, composed timelines and tenant isolation", async () => {
  const name = `history_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(adminUrl!, { max: 1 }); await admin.unsafe(`create database "${name}"`);
  const url = new URL(adminUrl!); url.pathname = `/${name}`;
  const privileged = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 2 });
  url.username = url.password = "openshapeforge_app";
  const runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 2 });
  try {
    await privileged.db.connection().execute(connection => runMigrationChain(connection));
    await sql.raw(`create schema audit_probe;
      create table audit_probe.budgets(id uuid primary key,tenant_id uuid not null,name text);
      create table audit_probe.lines(id uuid primary key,tenant_id uuid not null,budget_id uuid references audit_probe.budgets(id) on delete cascade,name text);
      create table audit_probe.amounts(id uuid primary key,tenant_id uuid not null,line_id uuid references audit_probe.lines(id) on delete cascade,amount text,private_note text,exact_amount numeric);
      create table audit_probe.contacts(id uuid primary key,tenant_id uuid not null,name text,private_note text);
      grant usage on schema audit_probe to openshapeforge_app;
      grant select,insert,update,delete on all tables in schema audit_probe to openshapeforge_app;`).execute(privileged.db);
    for (const table of tables) await sql.raw(`alter table audit_probe.${table.table} enable row level security;
      alter table audit_probe.${table.table} force row level security;
      create policy tenant on audit_probe.${table.table} using(tenant_id::text=current_setting('app.tenant_id',true)) with check(tenant_id::text=current_setting('app.tenant_id',true));`).execute(privileged.db);
    await applyAuditHistory(privileged.db, tables, { ProbeBudget: { include: ["lines"] }, ProbeLine: { include: ["values"] } });
    await withAuditContext("ProbeBudget.apply", "control-bearer", () => withDbSession(runtime.db, session(tenant), async tx => {
      await sql`insert into audit_probe.budgets values(${budget}::uuid,${tenant}::uuid,'Plan'),(${movedBudget}::uuid,${tenant}::uuid,'Second plan')`.execute(tx);
      await sql`insert into audit_probe.lines values(${line}::uuid,${tenant}::uuid,${budget}::uuid,'Sales')`.execute(tx);
      await withAuditContext("ProbeValue.create", "trusted-context", () => withDbSession(runtime.db, session(tenant), nested => sql`insert into audit_probe.amounts values(${value}::uuid,${tenant}::uuid,${line}::uuid,'100','classified-never-store',9007199254740993.123456789)`.execute(nested)));
      await expect(withInvocationSavepoint(tx, () => withAuditContext("ProbeValue.refused", "trusted-context", () => withDbSession(runtime.db, session(tenant), nested => sql`select 1/0`.execute(nested))))).rejects.toThrow();
      await sql`insert into audit_probe.contacts values(${contact}::uuid,${tenant}::uuid,'Contact','classified-never-store')`.execute(tx);
    }));
    const trackedSince = async () => (await sql<{ since_at: string }>`select since_at::text as since_at from platform.field_value_since where tenant_id=${tenant}::uuid and entity_type='ProbeValue' and record_id=${value} and field_key='amount'`.execute(privileged.db)).rows[0]?.since_at;
    const originalSince = await trackedSince();
    expect(originalSince).toBeDefined();
    await withAuditContext("ProbeValue.noop", "trusted-context", () => withDbSession(runtime.db, session(tenant), async tx => {
      await sql`update audit_probe.amounts set amount=amount where id=${value}::uuid`.execute(tx);
    }));
    expect(await trackedSince()).toEqual(originalSince);
    await expect(withDbSession(runtime.db, session(tenant), tx => sql`update platform.field_value_since set since_at=now() where tenant_id=${tenant}::uuid`.execute(tx))).rejects.toThrow();
    const plan = await privileged.db.transaction().execute(async tx => {
      await sql`set local enable_seqscan=off`.execute(tx);
      return sql`explain select id from platform.entity_events where platform.audit_event_subjects(payload,aggregate_type,aggregate_id) @> ${jsonbLiteral([{ entityType: "ProbeBudget", recordId: budget }])}`.execute(tx);
    });
    expect(JSON.stringify(plan.rows)).toContain("audit_event_subjects_idx");
    await withAuditContext("ProbeBudget.adjust", "control-bearer", () => withDbSession(runtime.db, session(tenant), async tx => {
      await sql`update audit_probe.amounts set amount='120',private_note='changed-never-store' where id=${value}::uuid`.execute(tx);
    }));
    const changedSince = await trackedSince();
    expect(changedSince).not.toEqual(originalSince);
    // Rollback must discard both the state change and its audit event.
    await expect(withAuditContext("ProbeBudget.rollback", "trusted-context", () => withDbSession(runtime.db, session(tenant), async tx => {
      await sql`update audit_probe.amounts set amount='999' where id=${value}::uuid`.execute(tx); throw new Error("rollback");
    }))).rejects.toThrow("rollback");
    expect(await trackedSince()).toEqual(changedSince);
    await withAuditContext("ProbeBudget.move", "control-bearer", () => withDbSession(runtime.db, session(tenant), async tx => {
      await sql`update audit_probe.lines set budget_id=${movedBudget}::uuid where id=${line}::uuid`.execute(tx);
    }));
    await appendEntityEvent(runtime.db, session(otherTenant), { aggregateType: "ProbeBudget", aggregateId: budget, eventType: "foreign-only", payload: { password: "must-not-store" } });
    await appendEntityEvent(runtime.db, session(otherTenant), { aggregateType: "ProbeLine", aggregateId: line, eventType: "foreign-line-only", payload: {} });
    await appendEntityEvent(runtime.db, session(tenant), { aggregateType: "ProbeContact", aggregateId: contact, eventType: "semantic-event", payload: { accessToken: "must-not-store", nested: { clientSecret: "must-not-store" } } });
    for (const payload of [{ changedFields: { invalid: true } }, { changedFields: [1] }, { audit: { changedFields: null } }]) {
      await expect(appendEntityEvent(runtime.db, session(tenant), { aggregateType: "ProbeContact", aggregateId: contact, eventType: "invalid-fields", payload })).rejects.toThrow();
    }

    async function clientFor(tenantId: string, held: string[], run: (client: Client) => Promise<void>) {
      const platform = new ModulePlatformRuntime(runtime.db);
      platform.registerStaticOperations(runtimeStaticOperationRegistrations([], { db: runtime.db }, listOperationContracts().filter(operation => operation.plugin === "osf-audit")));
      const server = __buildGeneratedMcpServerForTests({ db: runtime.db, modulePlatform: platform, session: session(tenantId, held) as never,
        modules: [accounts, documents as never, versioning as never, { name: "notebook", operationHandlers: { importNotebook: async () => ({ value: undefined }),
          deliverToNotebook: () => { throw new Error("This test does not exercise Notebook.deliver."); } } }],
        operationToolProjection: { mode: "searchable", search: "osf_search_operations", execute: "osf_execute_operation" } });
      const client = new Client({ name: "audit-entity-proof", version: "1" }); const [ct, st] = InMemoryTransport.createLinkedPair();
      try { await server.connect(st); await client.connect(ct); await run(client); }
      finally { platform.unregisterServer(server); await client.close(); await server.close(); }
    }
    await clientFor(tenant, ["Audit.Logs.ReadAll"], async client => {
      const call = (operationId: string, input: Record<string, unknown>) => client.callTool({ name: "osf_execute_operation", arguments: { operationId, input } });
      const list = async (input: Record<string, unknown> = {}) => {
        const result = await call("AuditEvent.list", input); if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
        return (result.structuredContent as any).data as { items: any[]; totalCount: number; nextCursor: string | null };
      };
      for (const id of ["AuditEvent.list", "AuditEvent.get"]) {
        const found = await client.callTool({ name: "osf_search_operations", arguments: { query: id } }); expect(JSON.stringify(found.structuredContent)).toContain(id);
      }
      const filterContract = listOperationContracts().find(operation => operation.key === "AuditEvent.list")!.inputSchema as any;
      expect(Object.keys(filterContract.$defs.filter0.properties).filter(key => !["and", "or"].includes(key)).sort()).toEqual([...auditFilterFields].sort());
      const all = await list(); expect(all.totalCount).toBe(8); expect(all.items).toHaveLength(8);
      expect(all.items.every(event => event.actorId === actor)).toBe(true);
      expect(all.items.some(event => event.operationId === "ProbeBudget.apply" && event.actorKind === "person")).toBe(true);
      expect(all.items.filter(event => event.operationId === "ProbeBudget.apply").map(event => event.correlationId).filter((id, index, ids) => ids.indexOf(id) === index)).toHaveLength(1);
      expect(all.items.some(event => event.operationId === "ProbeBudget.rollback")).toBe(false);
      expect(all.items.find(event => event.entityType === "ProbeValue" && event.eventType === "created")?.operationId).toBe("ProbeValue.create");
      expect(all.items.find(event => event.entityType === "ProbeContact" && event.eventType === "created")?.operationId).toBe("ProbeBudget.apply");
      expect(all.items.find(event => event.operationId === "ProbeValue.create")?.correlationId).toBe(all.items.find(event => event.entityType === "ProbeContact" && event.eventType === "created")?.correlationId);
      expect(all.items.every(event => event.rawData === null && event.beforeValues === null && event.afterValues === null)).toBe(true);
      const timeline = await list({ filter: { subjects: { contains: { entityType: "ProbeBudget", recordId: budget } } } });
      expect(timeline.items.some(event => event.entityType === "ProbeValue" && event.eventType === "updated")).toBe(true);
      expect(timeline.items.some(event => event.entityType === "ProbeLine" && event.operationId === "ProbeBudget.move")).toBe(true);
      const moved = await list({ filter: { subjects: { contains: { entityType: "ProbeBudget", recordId: movedBudget } } } });
      expect(moved.items.some(event => event.operationId === "ProbeBudget.move")).toBe(true);
      const filtered = await list({ filter: { and: [{ entityType: { in: ["ProbeValue", "ProbeContact"] } }, { or: [{ operationId: { eq: "ProbeBudget.adjust" } }, { eventType: { eq: "semantic-event" } }] }], actorId: { eq: actor }, occurredAt: { gte: "2020-01-01T00:00:00Z", lt: "2100-01-01T00:00:00Z" } } });
      expect(filtered.totalCount).toBe(2);
      const changed = await list({ filter: { changedFields: { contains: "amount" }, eventType: { eq: "updated" } } }); expect(changed.items).toHaveLength(1);
      const result = await call("AuditEvent.get", { id: changed.items[0].id }); expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.structuredContent)).toContain('"amount":"100"'); expect(JSON.stringify(result.structuredContent)).toContain('"amount":"120"');
      expect(JSON.stringify(result.structuredContent)).not.toMatch(/classified-never-store|changed-never-store/);
      expect(JSON.stringify(result.structuredContent)).toContain('\"exact_amount\":\"9007199254740993.123456789\"');
      const retained = all.items.find(event => event.entityType === "ProbeContact" && event.eventType === "created");
      expect(((await call("AuditEvent.get", { id: retained.id })).structuredContent as any).data.afterValues.name).toBe("[REDACTED]");
      const semantic = all.items.find(event => event.eventType === "semantic-event");
      expect(JSON.stringify((await call("AuditEvent.get", { id: semantic.id })).structuredContent)).not.toContain("must-not-store");
      const seen = new Set<string>(); let after: string | undefined;
      do { const page = await list({ first: 2, ...(after ? { after } : {}), sortField: "occurredAt", sortDirection: "asc" }); for (const row of page.items) { expect(seen.has(row.id)).toBe(false); seen.add(row.id); } after = page.nextCursor ?? undefined; } while (after);
      expect(seen.size).toBe(all.totalCount);
      const first = await list({ first: 1 }); expect(first.nextCursor).toBeTruthy();
      for (const input of [{ filter: { rawData: { eq: "x" } } }, { filter: { actorId: { containsSql: "x" } } }, { filter: { or: [] } }, { first: 0 }, { after: "bogus" }, { filter: { entityType: { eq: "ProbeValue" } }, after: first.nextCursor }, { tenantId: otherTenant }]) expect((await call("AuditEvent.list", input)).isError).toBe(true);
      expect((await call("AuditEvent.get", { id: crypto.randomUUID() })).isError).toBe(true);
      for (const id of ["AuditEvent.create", "AuditEvent.update", "AuditEvent.delete", "audit.list", "timeline.list"]) expect((await call(id, {})).isError).toBe(true);
    });
    // A later semantic signal has no row snapshot and must not hide the last recorded ancestry.
    await appendEntityEvent(runtime.db, session(tenant), { aggregateType: "ProbeLine", aggregateId: line, eventType: "line.reviewed", payload: {} });
    await clientFor(tenant, ["Audit.Logs.ReadAll"], async client => {
      const result = await client.callTool({ name: "osf_execute_operation", arguments: { operationId: "AuditEvent.list", input: { filter: {
        subjects: { contains: { entityType: "ProbeBudget", recordId: movedBudget } }, eventType: { eq: "line.reviewed" },
      } } } });
      expect(result.isError).toBeFalsy(); expect((result.structuredContent as any).data.items).toHaveLength(1);
    });
    await sql.raw("alter policy tenant on audit_probe.lines using(false)").execute(privileged.db);
    try {
      await withAuditContext("ProbeValue.hidden-parent", "trusted-context", () => withDbSession(runtime.db, session(tenant), tx =>
        sql`update audit_probe.amounts set amount='125' where id=${value}::uuid`.execute(tx)));
      await clientFor(tenant, ["Audit.Logs.ReadAll"], async client => {
        const result = await client.callTool({ name: "osf_execute_operation", arguments: { operationId: "AuditEvent.list", input: { filter: {
          subjects: { contains: { entityType: "ProbeBudget", recordId: movedBudget } }, operationId: { eq: "ProbeValue.hidden-parent" },
        } } } });
        expect(result.isError).toBeFalsy(); expect((result.structuredContent as any).data.items).toHaveLength(1);
      });
    } finally {
      await sql.raw("alter policy tenant on audit_probe.lines using(tenant_id::text=current_setting('app.tenant_id',true))").execute(privileged.db);
    }
    // Cascaded deletion must retain the parent timeline links on every descendant event.
    await withAuditContext("ProbeBudget.delete", "trusted-context", () => withDbSession(runtime.db, session(tenant), tx => sql`delete from audit_probe.budgets where id=${movedBudget}::uuid`.execute(tx)));
    await clientFor(tenant, ["Audit.Logs.ReadAll"], async client => {
      const result = await client.callTool({ name: "osf_execute_operation", arguments: { operationId: "AuditEvent.list", input: { filter: { subjects: { contains: { entityType: "ProbeBudget", recordId: movedBudget } }, eventType: { eq: "deleted" } } } } });
      expect(result.isError).toBeFalsy(); expect((result.structuredContent as any).data.items.map((event: any) => event.entityType).sort()).toEqual(["ProbeBudget", "ProbeLine", "ProbeValue"]);
    });
    await appendEntityEvent(runtime.db, session(tenant), { aggregateType: "ProbeLine", aggregateId: line, eventType: "line.archived", payload: {} });
    await clientFor(tenant, ["Audit.Logs.ReadAll"], async client => {
      const result = await client.callTool({ name: "osf_execute_operation", arguments: { operationId: "AuditEvent.list", input: { filter: {
        subjects: { contains: { entityType: "ProbeBudget", recordId: movedBudget } }, eventType: { eq: "line.archived" },
      } } } });
      expect(result.isError).toBeFalsy(); expect((result.structuredContent as any).data.items).toHaveLength(1);
    });
    await clientFor(otherTenant, ["Audit.Logs.ReadAll"], async client => {
      const result = await client.callTool({ name: "osf_execute_operation", arguments: { operationId: "AuditEvent.list", input: {} } });
      expect(result.isError).toBeFalsy();
      const events = (result.structuredContent as any).data.items;
      expect(events.map((event: any) => event.eventType).sort()).toEqual(["foreign-line-only", "foreign-only"]);
      expect(events.find((event: any) => event.eventType === "foreign-line-only").subjects).toEqual([{ entityType: "ProbeLine", recordId: line }]);
    });
    await clientFor(tenant, [], async client => {
      for (const id of ["AuditEvent.list", "AuditEvent.get"]) {
        const found = await client.callTool({ name: "osf_search_operations", arguments: { query: id } }); expect((found.structuredContent as any).operations).toEqual([]);
        expect((await client.callTool({ name: "osf_execute_operation", arguments: { operationId: id, input: {} } })).isError).toBe(true);
      }
    });
    // Failing audit persistence must roll back the business mutation too.
    await sql.raw(`create function audit_probe.refuse_event() returns trigger language plpgsql as $$ begin if NEW.aggregate_type='ProbeContact' then raise exception 'audit unavailable'; end if; return NEW; end $$;
      create trigger refusal before insert on platform.entity_events for each row execute function audit_probe.refuse_event();`).execute(privileged.db);
    await expect(withDbSession(runtime.db, session(tenant), tx => sql`update audit_probe.contacts set name='Must roll back' where id=${contact}::uuid`.execute(tx))).rejects.toThrow();
    expect((await sql<{ name: string }>`select name from audit_probe.contacts where id=${contact}::uuid`.execute(privileged.db)).rows[0]!.name).toBe("Contact");
    await sql.raw('drop trigger refusal on platform.entity_events').execute(privileged.db);
    expect(await auditHistoryReady(privileged.db, tables, { ProbeBudget: { include: ["lines"] }, ProbeLine: { include: ["values"] } })).toBe(true);
    // A failed policy install must not leave a partially replaced registry or producer set.
    await expect(applyAuditHistory(privileged.db, [...tables, table("ProbeMissing", "missing", ["name"])], { ProbeBudget: { include: ["lines"] }, ProbeLine: { include: ["values"] } })).rejects.toThrow();
    expect((await sql<{ config: unknown }>`select platform.audit_config('ProbeMissing') as config`.execute(privileged.db)).rows[0]!.config).toBeNull();
    expect(await auditHistoryReady(privileged.db, tables, { ProbeBudget: { include: ["lines"] }, ProbeLine: { include: ["values"] } })).toBe(true);
    await sql.raw('alter table audit_probe.amounts disable trigger audit_business_row').execute(privileged.db);
    expect(await auditHistoryReady(privileged.db, tables, { ProbeBudget: { include: ["lines"] }, ProbeLine: { include: ["values"] } })).toBe(false);
    await sql.raw('alter table audit_probe.amounts enable trigger audit_business_row').execute(privileged.db);
    await sql.raw("drop trigger audit_business_row on audit_probe.amounts; create trigger audit_business_row after insert or update or delete on audit_probe.amounts for each row execute function platform.audit_business_row('{}')").execute(privileged.db);
    expect(await auditHistoryReady(privileged.db, tables, { ProbeBudget: { include: ["lines"] }, ProbeLine: { include: ["values"] } })).toBe(false);
    await applyAuditHistory(privileged.db, tables, { ProbeBudget: { include: ["lines"] }, ProbeLine: { include: ["values"] } });
    const resumedLine = crypto.randomUUID(), resumedValue = crypto.randomUUID();
    await withDbSession(runtime.db, session(tenant), async tx => {
      await sql`insert into audit_probe.lines values(${resumedLine}::uuid,${tenant}::uuid,${budget}::uuid,'Resumed')`.execute(tx);
      await sql`insert into audit_probe.amounts values(${resumedValue}::uuid,${tenant}::uuid,${resumedLine}::uuid,'100',null,null)`.execute(tx);
    });
    const resumedSince = async () => (await sql`select since_at from platform.field_value_since where tenant_id=${tenant}::uuid and record_id=${resumedValue} and field_key='amount'`.execute(privileged.db)).rows[0];
    const firstResumedSince = await resumedSince();
    expect(firstResumedSince).toBeDefined();
    await withDbSession(runtime.db, session(tenant), tx => sql`update audit_probe.amounts set private_note='unrelated' where id=${resumedValue}::uuid`.execute(tx));
    expect(await resumedSince()).toEqual(firstResumedSince);
    await sql.raw('alter table audit_probe.amounts disable trigger track_field_value_since').execute(privileged.db);
    expect(await auditHistoryReady(privileged.db, tables, { ProbeBudget: { include: ["lines"] }, ProbeLine: { include: ["values"] } })).toBe(false);
    await applyAuditHistory(privileged.db, tables, { ProbeBudget: { include: ["lines"] }, ProbeLine: { include: ["values"] } });
    expect(await resumedSince()).toBeUndefined(); // the disabled interval has unknown coverage
    await withDbSession(runtime.db, session(tenant), tx => sql`update audit_probe.amounts set amount='130' where id=${resumedValue}::uuid`.execute(tx));
    const beforeReapply = await resumedSince();
    expect(beforeReapply).toBeDefined();
    await applyAuditHistory(privileged.db, tables, { ProbeBudget: { include: ["lines"] }, ProbeLine: { include: ["values"] } });
    expect(await resumedSince()).toEqual(beforeReapply);
    tables[2]!.source!.graphql!.relationships!.find(item => item.name === "amount")!.target = "TrackedTargetV2";
    await applyAuditHistory(privileged.db, tables, { ProbeBudget: { include: ["lines"] }, ProbeLine: { include: ["values"] } });
    expect(await resumedSince()).toBeUndefined(); // a relationship to another entity is a new tracked meaning
    const stored = await sql<{ payload: unknown }>`select payload from platform.entity_events`.execute(privileged.db);
    expect(JSON.stringify(stored.rows)).not.toMatch(/classified-never-store|changed-never-store|must-not-store/);
    await expect(sql`delete from platform.entity_events`.execute(privileged.db)).rejects.toThrow();
    await expect(sql`update platform.entity_events set payload='{}'::jsonb`.execute(privileged.db)).rejects.toThrow();
    const bulkTenant = crypto.randomUUID(), bulkBudget = crypto.randomUUID(), bulkLine = crypto.randomUUID();
    const started = performance.now();
    await withDbSession(runtime.db, session(bulkTenant), async tx => {
      await sql`insert into audit_probe.budgets values(${bulkBudget}::uuid,${bulkTenant}::uuid,'Bulk')`.execute(tx);
      await sql`insert into audit_probe.lines values(${bulkLine}::uuid,${bulkTenant}::uuid,${bulkBudget}::uuid,'Bulk line')`.execute(tx);
      await sql`insert into audit_probe.amounts select gen_random_uuid(),${bulkTenant}::uuid,${bulkLine}::uuid,n::text,'masked',n::numeric from generate_series(1,1000) n`.execute(tx);
    });
    const durationMs = performance.now() - started;
    const bulk = await sql<{ count: number }>`select count(*)::int as count from platform.entity_events where tenant_id=${bulkTenant}::uuid and platform.audit_event_subjects(payload,aggregate_type,aggregate_id) @> ${jsonbLiteral([{ entityType: "ProbeBudget", recordId: bulkBudget }])}`.execute(privileged.db);
    expect(bulk.rows[0]!.count).toBe(1002);
    console.log(JSON.stringify({ auditBulkChildRows: 1000, timelineLevels: 3, recordedRootEvents: 1002, durationMs }));
    // Rehearse the documented owner-only, complete-tenant offboarding step.
    await privileged.db.transaction().execute(async tx => {
      await sql`select set_config('app.tenant_id',${otherTenant},true)`.execute(tx);
      await sql.raw("lock table platform.entity_events in access exclusive mode; alter table platform.entity_events disable trigger audit_event_envelope").execute(tx);
      await sql`delete from platform.entity_events where tenant_id=app.current_tenant()`.execute(tx);
      await sql.raw("alter table platform.entity_events enable trigger audit_event_envelope").execute(tx);
    });
    expect((await sql<{ count: number }>`select count(*)::int as count from platform.entity_events where tenant_id=${otherTenant}::uuid`.execute(privileged.db)).rows[0]!.count).toBe(0);
    expect((await sql<{ count: number }>`select count(*)::int as count from platform.entity_events where tenant_id=${bulkTenant}::uuid`.execute(privileged.db)).rows[0]!.count).toBe(1002);
    expect(await auditHistoryReady(privileged.db, tables, { ProbeBudget: { include: ["lines"] }, ProbeLine: { include: ["values"] } })).toBe(true);
    await expect(sql`delete from platform.entity_events where tenant_id=${tenant}::uuid`.execute(privileged.db)).rejects.toThrow();
  } finally {
    await runtime.close(); await privileged.close(); await admin.unsafe(`drop database if exists "${name}" with (force)`); await admin.close();
  }
}, 120_000);
