// SPDX-License-Identifier: BUSL-1.1
/**
 * The generic status-transition runtime against PostgreSQL, on the one core
 * entity that declares a state machine: AgreementMilestone.status with the
 * rule `trigger` (pending -> triggered, writes triggeredAt/triggeredBy). The
 * scratch schema mirrors the catalog's columns, default and CHECK by hand.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type CompiledQuery } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { applyAppHelpersMigration } from "../../db/migrations/app-helpers.js";
import { withDbSession } from "../../db/session.js";
import { jsonbLiteral } from "../../db/sql-helpers.js";
import rawCatalog from "../../generated/operations/catalog.json" with { type: "json" };
import { bindOperationHandlers, type OperationContract } from "../runtime.js";
import { registerEntityOperationAvailability } from "./availability.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { createGeneratedEntityForTable, updateGeneratedEntity } from "./mutations.js";
import { currentRecordOffers, offerTarget } from "./runtime.js";
import { executeTransition, transitionAvailabilityFor, transitionAvailabilityHandler, transitionBinding, transitionOperationHandler, type TransitionBinding } from "./transitions.js";
import { recordPermissionsAllowRow } from "./record-permissions.js";
import type { GeneratedCrudTable } from "./types.js";
import { assertNoOperationWrittenValues } from "./write-policy.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const scratchName = `transitions_${randomUUID().replaceAll("-", "")}`;
let admin: SQL | undefined, privileged: DatabaseRuntime | undefined, restricted: DatabaseRuntime | undefined;
let created = false;
const tenant = randomUUID(), otherTenant = randomUUID(), actor = randomUUID();
const session = {
  tenantId: tenant, userId: actor, scope: "tenant" as const, credential: "bearer" as const, groups: [] as string[],
  roles: ["Agreements.All.Read", "Agreements.All.ReadWrite"],
};
const table = getGeneratedCrudTables().find((candidate) => candidate.source?.authoringEntityName === "AgreementMilestone")!;
const catalogOperation = (key: string) => (rawCatalog as { operations: OperationContract[] }).operations
  .find((candidate) => candidate.key === key)!;
const operation = catalogOperation("AgreementMilestone.trigger");
const cancel = catalogOperation("AgreementMilestone.cancel");
const context = () => ({ db: restricted!.db, session, transport: "operation" as const }) as unknown as Parameters<ReturnType<typeof transitionOperationHandler>>[1];

function databaseUrl(app = false) {
  const url = new URL(adminUrl!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") throw new Error("Scratch tests require a local postgres admin database.");
  url.pathname = `/${scratchName}`;
  if (app) { url.username = "openshapeforge_app"; url.password = "openshapeforge_app"; }
  return url.toString();
}
function columnDdl(): string {
  return table.columns.map((column) => {
    if (column.name === "id") return "id uuid primary key default gen_random_uuid()";
    if (column.name === "created_at" || column.name === "updated_at") return `${column.name} timestamptz not null default clock_timestamp()`;
    if (column.name === "status") return "status text not null default 'pending' check (status in ('pending','triggered','invoiced','cancelled'))";
    return `${column.name} ${column.type}${column.required ? " not null" : ""}`;
  }).join(", ");
}
/** The same table with record-level permissions, as an ACL-protected entity would compile it. */
function protectedBinding(): TransitionBinding {
  const base = transitionBinding(operation);
  const table: GeneratedCrudTable = {
    ...structuredClone(base.table),
    columns: [...base.table.columns, { name: "authorization", type: "jsonb", required: true, primaryKey: false, generated: null, sourceField: "authorization" }],
    source: {
      ...structuredClone(base.table.source!),
      authorization: {
        ...base.table.source!.authorization!,
        recordPermissions: { field: "authorization", column: "authorization", empty: "public", createRequires: ["view", "edit"] },
      },
    },
  };
  return { ...base, table, statusColumn: table.columns.find((column) => column.name === "status")!, rule: { ...base.rule, recordPermission: "edit" } };
}
async function agreement(tenantId = tenant, code: string | null = "AGR-1"): Promise<string> {
  const id = randomUUID();
  await sql`insert into erp.agreements (id, tenant_id, code) values (${id}::uuid, ${tenantId}::uuid, ${code})`.execute(privileged!.db);
  return id;
}
async function milestone(status = "pending", tenantId = tenant, agreementId?: string) {
  const record = await createGeneratedEntityForTable(
    privileged!.db,
    { ...session, tenantId },
    table,
    { agreementId: agreementId ?? await agreement(tenantId), description: "Go-live", amount: 100 },
  );
  const id = String(record.id);
  if (status !== "pending") await sql`update erp.agreement_milestones set status = ${status} where id = ${id}::uuid`.execute(privileged!.db);
  return id;
}
async function row(id: string) {
  return (await sql<{ row: Record<string, unknown> }>`select to_jsonb(m.*) as row from erp.agreement_milestones m where id = ${id}::uuid`.execute(privileged!.db)).rows[0]?.row;
}
async function events(id: string) {
  return (await sql<{ event_type: string }>`select event_type from platform.entity_events where aggregate_id = ${id} order by sequence`.execute(privileged!.db)).rows.map((event) => event.event_type);
}
const fails = (promise: unknown, code: string) => expect(Promise.resolve(promise)).rejects.toMatchObject({ operationError: { code } });

describe("status transitions against PostgreSQL", () => {
  beforeAll(async () => {
    databaseUrl(); admin = new SQL(adminUrl!, { max: 1 });
    const roles = await admin`select rolsuper, rolbypassrls from pg_roles where rolname = 'openshapeforge_app'`;
    if (roles.length !== 1 || roles[0].rolsuper || roles[0].rolbypassrls) throw new Error("An existing restricted app role is required; shared roles are never changed.");
    await admin.unsafe(`create database "${scratchName}"`); created = true;
    privileged = createDatabaseRuntime({ databaseUrl: databaseUrl(), maxConnections: 1 });
    await applyAppHelpersMigration(privileged.db);
    await sql.raw(`create schema erp; create schema platform;
      create table erp.agreements(id uuid primary key default gen_random_uuid(), tenant_id uuid not null, code text, activated_at timestamptz, amount numeric, unique(tenant_id,id));
      create table erp.agreement_milestones(${columnDdl()}, "authorization" jsonb not null default '{}'::jsonb, unique(tenant_id,id));
      create table platform.entity_events(id uuid primary key default gen_random_uuid(), tenant_id uuid not null, aggregate_type text not null,
        aggregate_id text not null, event_type text not null, payload jsonb, sequence bigint generated always as identity, occurred_at timestamptz not null);
      create table platform.entity_edit_leases(id uuid primary key default gen_random_uuid(), tenant_id uuid not null, entity_id text not null,
        target_id text not null, operation_id text not null, owner_user_id uuid not null, owner_display_name text, token_hash text not null,
        acquired_version text not null, inactivity_timeout_seconds integer not null, acquired_at timestamptz not null default now(),
        last_activity_at timestamptz not null default now(), expires_at timestamptz not null);
      alter table erp.agreements enable row level security; alter table erp.agreements force row level security;
      create policy tenant on erp.agreements using(tenant_id=app.current_tenant()) with check(tenant_id=app.current_tenant());
      alter table erp.agreement_milestones enable row level security; alter table erp.agreement_milestones force row level security;
      create policy tenant on erp.agreement_milestones using(tenant_id=app.current_tenant()) with check(tenant_id=app.current_tenant());
      grant usage on schema app,erp,platform to openshapeforge_app;
      grant select,insert,update,delete on all tables in schema erp,platform to openshapeforge_app;
      grant usage on all sequences in schema platform to openshapeforge_app;
      grant execute on all functions in schema app to openshapeforge_app`).execute(privileged.db);
    restricted = createDatabaseRuntime({ databaseUrl: databaseUrl(true), maxConnections: 2 });
    registerEntityOperationAvailability(restricted.db, bindOperationHandlers([]));
  }, 30_000);
  beforeEach(async () => {
    await sql`truncate erp.agreement_milestones, erp.agreements, platform.entity_events`.execute(privileged!.db);
  });
  afterAll(async () => {
    await restricted?.close(); await privileged?.close();
    if (created) await admin?.unsafe(`drop database "${scratchName}" with (force)`);
    await admin?.close();
  });

  test("a create carries no status and starts in the initial state", async () => {
    const id = await milestone();
    expect((await row(id))!.status).toBe("pending");
    expect(() => assertNoOperationWrittenValues(table, { status: "triggered" })).toThrow(/AgreementMilestone\.trigger.*POST \/api\/rest\/v1\/agreement-milestones\/:id\/trigger/);
    expect(() => assertNoOperationWrittenValues(table, { status: "pending" })).toThrow("cannot be set through create or update");
  });

  test("the rule moves the status, stamps time and actor from the server, bumps the version and journals the update", async () => {
    const id = await milestone();
    const before = (await row(id))!;
    // Stamped fields are not input: a supplied value is neither accepted nor applied.
    const result = await transitionOperationHandler(operation)({ id, triggeredBy: "forged", triggeredAt: "2000-01-01T00:00:00Z" }, context());
    expect(result).toMatchObject({ status: 200, value: { id, status: "triggered", triggeredBy: actor, description: "Go-live" } });
    const after = (await row(id))!;
    expect(after.status).toBe("triggered");
    expect(after.triggered_by).toBe(actor);
    expect(after.triggered_at).toBe(after.updated_at);
    expect(after.updated_at).not.toBe(before.updated_at);
    expect(Date.parse(String(after.triggered_at))).toBeGreaterThan(Date.now() - 60_000);
    expect(await events(id)).toEqual(["created", "updated"]);
  });

  test("on an ACL-protected entity the rule is neither offered on nor applied to a record the session may not edit", async () => {
    const binding = protectedBinding();
    const denied = await milestone();
    const allowed = await milestone();
    await sql`update erp.agreement_milestones set "authorization" = ${jsonbLiteral({ view: { users: [actor] }, edit: { users: [randomUUID()] } })} where id = ${denied}::uuid`.execute(privileged!.db);
    await sql`update erp.agreement_milestones set "authorization" = ${jsonbLiteral({ view: { users: [actor] }, edit: { users: [actor] } })} where id = ${allowed}::uuid`.execute(privileged!.db);
    // The offer filter omits a custom Operation whose recordPermission the row refuses.
    expect(recordPermissionsAllowRow(binding.table, (await row(denied))!, ["edit"], session)).toBe(false);
    expect(recordPermissionsAllowRow(binding.table, (await row(allowed))!, ["edit"], session)).toBe(true);
    await fails(executeTransition(restricted!.db, session, binding, { id: denied }), "FORBIDDEN");
    expect((await row(denied))!.status).toBe("pending");
    expect(await events(denied)).toEqual(["created"]);
    expect(await executeTransition(restricted!.db, session, binding, { id: allowed })).toMatchObject({ id: allowed, status: "triggered" });
  });

  test("a status outside the rule's from is refused with INVALID_STATE naming from and to", async () => {
    const id = await milestone("triggered");
    await expect(transitionOperationHandler(operation)({ id }, context())).rejects.toMatchObject({
      operationError: { code: "INVALID_STATE", message: "AgreementMilestone is triggered; trigger moves status from pending to triggered." },
    });
    expect((await row(id))!.status).toBe("triggered");
    expect(await events(id)).toEqual(["created"]);
  });

  test("cancel runs from pending or triggered and is refused afterwards; the status names every rule as its writer", async () => {
    const pending = await milestone();
    const triggered = await milestone("triggered");
    expect(await transitionOperationHandler(cancel)({ id: pending }, context())).toMatchObject({ value: { status: "cancelled", triggeredAt: null } });
    expect(await transitionOperationHandler(cancel)({ id: triggered }, context())).toMatchObject({ value: { status: "cancelled" } });
    await fails(transitionOperationHandler(cancel)({ id: pending }, context()), "INVALID_STATE");
    await fails(transitionOperationHandler(operation)({ id: pending }, context()), "INVALID_STATE");
    expect(table.columns.find((column) => column.name === "status")!.writtenBy!.map((writer) => writer.operation))
      .toEqual(["AgreementMilestone.trigger", "AgreementMilestone.cancel", "AgreementMilestone.invoice"]);
  });

  test("a record of another tenant or none at all is NOT_FOUND", async () => {
    const foreign = await milestone("pending", otherTenant);
    await fails(transitionOperationHandler(operation)({ id: foreign }, context()), "NOT_FOUND");
    await fails(transitionOperationHandler(operation)({ id: randomUUID() }, context()), "NOT_FOUND");
  });

  test("the generic update refuses the status and the rule's writes fields by name", async () => {
    const id = await milestone();
    for (const values of [{ status: "triggered" }, { triggeredBy: "someone" }, { triggeredAt: new Date().toISOString() }]) {
      // triggeredBy and triggeredAt are stamped by the rule, so writtenBy it too.
      await fails(updateGeneratedEntity(restricted!.db, session, { table: table.name, id, values }), "BAD_USER_INPUT");
    }
    expect((await row(id))!.status).toBe("pending");
    expect(await updateGeneratedEntity(restricted!.db, session, { table: table.name, id, values: { description: "Renamed" } })).toMatchObject({ description: "Renamed" });
  });

  test("the rule is offered only while the status is in from", async () => {
    const pending = await milestone();
    const triggered = await milestone("triggered");
    const decisions = await withDbSession(restricted!.db, session, async (trx) =>
      transitionAvailabilityHandler(operation)([pending, triggered, randomUUID()], { db: trx, session: session as never }));
    expect(decisions[pending]).toEqual({ available: true });
    expect(decisions[triggered]).toMatchObject({ available: false, error: { code: "INVALID_STATE" } });
    expect(Object.values(decisions)[2]).toMatchObject({ available: false, error: { code: "NOT_FOUND" } });

    const offers = async (id: string) => {
      const target = offerTarget((await row(id))!, table);
      const all = await currentRecordOffers(restricted!.db, session, "AgreementMilestone", table, target, ["update", "delete"]);
      return all.find((offer) => offer.operation.id === "AgreementMilestone.trigger");
    };
    expect(await offers(pending)).toMatchObject({ available: true, binding: { input: { id: pending } } });
    expect(await offers(triggered)).toMatchObject({ available: false, error: { code: "INVALID_STATE" } });
  });

  test("a list of N rows issues one referenced read per target table", async () => {
    const ids = [await milestone(), await milestone(), await milestone(), await milestone(), await milestone()];
    const statements: string[] = [];
    const decisions = await withDbSession(restricted!.db, session, async (trx) => {
      const executor = trx.getExecutor();
      const original = executor.executeQuery.bind(executor);
      executor.executeQuery = ((query: CompiledQuery) => {
        statements.push(query.sql);
        return original(query);
      }) as typeof executor.executeQuery;
      return transitionAvailabilityHandler(operation)(ids, { db: trx, session: session as never });
    });
    expect(ids.every((id) => decisions[id]?.available === true)).toBe(true);
    const targetReads = statements.filter((sql) => /"agreements"/.test(sql) && !/"agreement_milestones"/.test(sql));
    expect(targetReads).toHaveLength(1);
  });

  test("a referenced precondition reads the named record in this tenant and refuses a miss, a cross-tenant row, present and in", async () => {
    const passing = await milestone();
    expect(await transitionOperationHandler(operation)({ id: passing }, context())).toMatchObject({ value: { status: "triggered" } });

    const missing = await milestone("pending", tenant, randomUUID());
    await expect(transitionOperationHandler(operation)({ id: missing }, context())).rejects.toMatchObject({
      operationError: { code: "INVALID_STATE", message: "trigger requires agreementId.code on the Agreement that agreementId names in this tenant." },
    });
    expect((await row(missing))!.status).toBe("pending");

    const foreignAgreement = await agreement(otherTenant);
    const crossTenant = await milestone("pending", tenant, foreignAgreement);
    await expect(transitionOperationHandler(operation)({ id: crossTenant }, context())).rejects.toMatchObject({
      operationError: { code: "INVALID_STATE", message: "trigger requires agreementId.code on the Agreement that agreementId names in this tenant." },
    });

    const emptyCode = await agreement(tenant, null);
    const empty = await milestone("pending", tenant, emptyCode);
    const emptyBinding: TransitionBinding = {
      ...transitionBinding(operation),
      referenced: [{ ...transitionBinding(operation).referenced[0]!, present: false }],
    };
    expect(await executeTransition(restricted!.db, session, emptyBinding, { id: empty })).toMatchObject({ status: "triggered" });
    const stillSet = await milestone();
    await expect(executeTransition(restricted!.db, session, emptyBinding, { id: stillSet })).rejects.toMatchObject({
      operationError: { code: "INVALID_STATE", message: "trigger requires agreementId.code to be empty." },
    });

    const listed = await agreement(tenant, "approved");
    const { present: _present, ...via } = transitionBinding(operation).referenced[0]!;
    const inBinding: TransitionBinding = {
      ...transitionBinding(operation),
      referenced: [{ ...via, in: ["approved"] }],
    };
    expect(await executeTransition(restricted!.db, session, inBinding, { id: await milestone("pending", tenant, listed) })).toMatchObject({ status: "triggered" });
    await expect(executeTransition(restricted!.db, session, inBinding, { id: await milestone() })).rejects.toMatchObject({
      operationError: { code: "INVALID_STATE", message: "trigger requires agreementId.code to be one of approved." },
    });
  });

  test("in is compared in SQL against the typed column for datetime and numeric", async () => {
    const { present: _present, ...via } = transitionBinding(operation).referenced[0]!;
    const column = (name: string, type: string, sourceField: string) => ({
      name, type, required: false, primaryKey: false, generated: null, sourceField,
    });
    const bindingFor = (field: string, fieldColumn: { name: string; type: string; required: boolean; primaryKey: boolean; generated: null; sourceField: string }, allowed: Array<string | number | boolean>): TransitionBinding => ({
      ...transitionBinding(operation),
      referenced: [{ ...via, field, fieldColumn, in: allowed }],
    });
    const seed = async (values: { activatedAt?: string; amount?: string }) => {
      const id = randomUUID();
      await sql`insert into erp.agreements (id, tenant_id, activated_at, amount)
        values (${id}::uuid, ${tenant}::uuid, ${values.activatedAt ?? null}::timestamptz, ${values.amount ?? null}::numeric)`.execute(privileged!.db);
      return milestone("pending", tenant, id);
    };

    const instant = "2026-03-01T09:30:00.000Z";
    const datetime = bindingFor("activatedAt", column("activated_at", "timestamptz", "activatedAt"), [instant]);
    expect(await executeTransition(restricted!.db, session, datetime, { id: await seed({ activatedAt: "2026-03-01 09:30:00+00" }) }))
      .toMatchObject({ status: "triggered" });
    await expect(executeTransition(restricted!.db, session, datetime, { id: await seed({ activatedAt: "2026-03-01 09:31:00+00" }) })).rejects.toMatchObject({
      operationError: { code: "INVALID_STATE", message: "trigger requires agreementId.activatedAt to be one of 2026-03-01T09:30:00.000Z." },
    });

    const numeric = bindingFor("amount", column("amount", "numeric", "amount"), [1.5]);
    expect(await executeTransition(restricted!.db, session, numeric, { id: await seed({ amount: "1.50" }) }))
      .toMatchObject({ status: "triggered" });
    await expect(executeTransition(restricted!.db, session, numeric, { id: await seed({ amount: "1.51" }) })).rejects.toMatchObject({
      operationError: { code: "INVALID_STATE", message: "trigger requires agreementId.amount to be one of 1.5." },
    });
  });

  test("two in preconditions on the same target field with different sets do not overwrite each other", async () => {
    const { present: _present, ...via } = transitionBinding(operation).referenced[0]!;
    const binding: TransitionBinding = {
      ...transitionBinding(operation),
      referenced: [
        { ...via, in: ["approved"] },
        { ...via, via: "parentAgreementId", in: ["signed"] },
      ],
    };
    const signed = await milestone("pending", tenant, await agreement(tenant, "signed"));
    const approved = await milestone("pending", tenant, await agreement(tenant, "approved"));
    const decisions = await withDbSession(restricted!.db, session, async (trx) =>
      transitionAvailabilityFor(binding)([signed, approved], { db: trx, session: session as never }));
    // Keying by field name would let the later set win: signed would look available.
    expect(decisions[signed]).toMatchObject({
      available: false,
      error: { code: "INVALID_STATE", message: "trigger requires agreementId.code to be one of approved." },
    });
    expect(decisions[approved]).toMatchObject({
      available: false,
      error: { code: "INVALID_STATE", message: "trigger requires parentAgreementId.code to be one of signed." },
    });
    await expect(executeTransition(restricted!.db, session, binding, { id: signed })).rejects.toMatchObject({
      operationError: { message: "trigger requires agreementId.code to be one of approved." },
    });
  });
});
