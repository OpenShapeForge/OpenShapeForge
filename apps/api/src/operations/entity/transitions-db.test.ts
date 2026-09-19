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
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { applyAppHelpersMigration } from "../../db/migrations/app-helpers.js";
import { withDbSession } from "../../db/session.js";
import { jsonbLiteral } from "../../db/sql-helpers.js";
import { createAgreementMilestone } from "../../billing/agreement-milestone-service.js";
import rawCatalog from "../../generated/operations/catalog.json" with { type: "json" };
import { bindOperationHandlers, type OperationContract } from "../runtime.js";
import { registerEntityOperationAvailability } from "./availability.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { updateGeneratedEntity } from "./mutations.js";
import { currentRecordOffers, offerTarget } from "./runtime.js";
import { executeTransition, transitionAvailabilityHandler, transitionBinding, transitionOperationHandler, type TransitionBinding } from "./transitions.js";
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
const operation = (rawCatalog as { operations: OperationContract[] }).operations
  .find((candidate) => candidate.key === "AgreementMilestone.trigger")!;
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
async function milestone(status = "pending", tenantId = tenant) {
  const record = await createAgreementMilestone(privileged!.db, { ...session, tenantId }, { agreementId: randomUUID(), description: "Go-live", amount: 100 });
  if (status !== "pending") await sql`update erp.agreement_milestones set status = ${status} where id = ${record.id}::uuid`.execute(privileged!.db);
  return record.id;
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
      create table erp.agreement_milestones(${columnDdl()}, "authorization" jsonb not null default '{}'::jsonb, unique(tenant_id,id));
      create table platform.entity_events(id uuid primary key default gen_random_uuid(), tenant_id uuid not null, aggregate_type text not null,
        aggregate_id text not null, event_type text not null, payload jsonb, sequence bigint generated always as identity, occurred_at timestamptz not null);
      create table platform.entity_edit_leases(id uuid primary key default gen_random_uuid(), tenant_id uuid not null, entity_id text not null,
        target_id text not null, operation_id text not null, owner_user_id uuid not null, owner_display_name text, token_hash text not null,
        acquired_version text not null, inactivity_timeout_seconds integer not null, acquired_at timestamptz not null default now(),
        last_activity_at timestamptz not null default now(), expires_at timestamptz not null);
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
    await sql`truncate erp.agreement_milestones, platform.entity_events`.execute(privileged!.db);
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
});
