// SPDX-License-Identifier: BUSL-1.1
/**
 * The Team subtype of RelationGroup against PostgreSQL, through
 * `executeEntityOperation` only — the same generic entity path REST, MCP and
 * Web use. A Team is a relation group whose type is `team`, served from the
 * relation groups table under its own Operations: a create fixes the type
 * and refuses a caller's; every read and write sees team rows only, so a
 * department reached by id answers not found and is never changed or
 * deleted; the hidden type is absent from every answer and refused on input;
 * and the base guards still hold: another tenant sees nothing, the base's
 * edit lease is the record's one lease whichever projection took it, and the
 * base can still read and retype the same row.
 *
 * Scratch database on the task's own Postgres (docs/testing.md, "Migration
 * tests"); the shared development database is never touched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { APP_ROLE, DEV_APP_ROLE_PASSWORD_DEFAULT } from "../../db/migrations/app-role.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { acquireEditLeaseForEntityOperation, executeEntityOperation, getEntityOperationContracts } from "./runtime.js";
import type { EntityOperationInput, EntityOperationResult, GeneratedEntityRow } from "./types.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const database = `entity_subtype_${randomUUID().replaceAll("-", "")}`;

const groupRoles = ["Relations.RelationGroups.ReadWrite"];
const session = (tenantId: string, roles = groupRoles) => ({
  tenantId, userId: randomUUID(), roles, groups: [], scope: "tenant" as const,
});
type Session = ReturnType<typeof session>;

let admin: SQL;
let privileged: DatabaseRuntime;
let runtime: DatabaseRuntime;

const intentOf = (id: string) => id.split(".")[1] as "list" | "get" | "create" | "update" | "delete";

function run(actor: Session, id: string, input: EntityOperationInput): Promise<EntityOperationResult> {
  return executeEntityOperation(runtime.db, actor, { operation: { id, intent: intentOf(id) }, input });
}

function record(result: EntityOperationResult): GeneratedEntityRow {
  if ("error" in result) throw new Error(`${result.intent} failed: ${JSON.stringify(result.error)}`);
  if (result.intent === "list" || result.intent === "delete" || !result.data) throw new Error(`${result.intent} returned no record.`);
  return result.data;
}

const failure = (result: EntityOperationResult) => ("error" in result ? result.error : undefined);

function rows(result: EntityOperationResult): GeneratedEntityRow[] {
  if ("error" in result) throw new Error(`list failed: ${JSON.stringify(result.error)}`);
  if (result.intent !== "list") throw new Error("not a list");
  return result.data.items.map((item) => item.data);
}

async function stored(id: string): Promise<Record<string, unknown> | undefined> {
  const result = await sql<{ row: Record<string, unknown> }>`
    select to_jsonb(t.*) as row from erp.relation_groups t where id = ${id}::uuid
  `.execute(privileged.db);
  return result.rows[0]?.row;
}

async function version(id: string): Promise<string> {
  const result = await sql<{ version: string }>`select updated_at::text as version from erp.relation_groups where id = ${id}::uuid`.execute(privileged.db);
  return String(result.rows[0]!.version);
}

/** A relation group of another type, inserted as the base would store it. */
async function department(tenantId: string, name = "Finance"): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into erp.relation_groups (id, tenant_id, name, group_type, status)
    values (${id}::uuid, ${tenantId}::uuid, ${name}, 'department', 'active')
  `.execute(privileged.db);
  return id;
}

async function lease(actor: Session, operationId: string, targetId: string) {
  return acquireEditLeaseForEntityOperation(runtime.db, actor, { operationId, targetId });
}

beforeAll(async () => {
  const url = new URL(adminUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") {
    throw new Error("Scratch tests require a local postgres admin database, never an application database.");
  }
  admin = new SQL(adminUrl, { max: 1 });
  await admin.unsafe(`create database "${database}"`);
  url.pathname = `/${database}`;
  privileged = createDatabaseRuntime({ databaseUrl: url.toString() });
  await privileged.db.connection().execute((connection) => runMigrationChain(connection));
  url.username = APP_ROLE;
  url.password = process.env.OPENSHAPEFORGE_APP_PASSWORD ?? DEV_APP_ROLE_PASSWORD_DEFAULT;
  runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 4 });
}, 180_000);

afterAll(async () => {
  await runtime?.close();
  await privileged?.close();
  await admin?.unsafe(`drop database if exists "${database}" with (force)`);
  await admin?.close();
});

describe("the Team subtype is served from the relation groups table", () => {
  test("registers as its own entity over the base table, with the base's rows and the hidden type absent", () => {
    const team = getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === "Team")!;
    const group = getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === "RelationGroup")!;
    expect(team.name).toBe("erp.relation_groups@Team");
    expect(team.table).toBe(group.table);
    expect(team.subtype).toEqual({
      base: { entityName: "RelationGroup", entityId: "core.RelationGroup", slug: "relation-group", table: "erp.relation_groups" },
      scope: [{ field: "groupType", column: "group_type", value: "team" }],
      hiddenColumns: [{ field: "groupType", column: "group_type" }],
    });
    expect(team.columns.map((column) => column.name)).not.toContain("group_type");
    expect(group.columns.map((column) => column.name)).toContain("group_type");
    for (const intent of ["list", "get", "create", "update", "delete"]) {
      expect(getEntityOperationContracts().find((operation) => operation.id === `Team.${intent}`)?.entityName).toBe("Team");
    }
  });

  test("creates a team with the type fixed by the server and refuses a caller's type", async () => {
    const actor = session(randomUUID());
    const created = record(await run(actor, "Team.create", { values: { name: "Platform" } }));
    expect(created).toMatchObject({ name: "Platform", status: "active" });
    expect(created).not.toHaveProperty("group_type");
    expect(created).not.toHaveProperty("groupType");
    expect(await stored(String(created.id))).toMatchObject({ group_type: "team", tenant_id: actor.tenantId });

    expect(failure(await run(actor, "Team.create", { values: { name: "Escape", groupType: "department" } })))
      .toMatchObject({ code: "BAD_USER_INPUT", message: expect.stringContaining("groupType") });
    expect(failure(await run(actor, "Team.create", { values: { name: "Escape", group_type: "department" } })))
      .toMatchObject({ code: "BAD_USER_INPUT" });
  });

  test("lists, reads, updates and deletes team rows only; a department is unreachable even by id", async () => {
    const actor = session(randomUUID());
    const teamId = String(record(await run(actor, "Team.create", { values: { name: "Support" } })).id);
    const departmentId = await department(actor.tenantId);

    const listed = rows(await run(actor, "Team.list", { includeTotalCount: true }));
    expect(listed.map((row) => row.id)).toEqual([teamId]);
    expect(listed[0]).not.toHaveProperty("group_type");
    // The discriminator is no filter either: a filter on it names an unknown field.
    expect(failure(await run(actor, "Team.list", { filter: { groupType: "department" } }))).toMatchObject({ code: "BAD_USER_INPUT" });
    expect(rows(await run(actor, "Team.list", { filter: { name: "Fin" } }))).toEqual([]);

    expect(record(await run(actor, "Team.get", { id: teamId }))).toMatchObject({ id: teamId, name: "Support" });
    const got = await run(actor, "Team.get", { id: departmentId });
    expect("error" in got ? got.error : got.data).toBeNull();

    // The base still sees both and still owns the type.
    expect(rows(await run(actor, "RelationGroup.list", { sort: { field: "name", direction: "asc" } })).map((row) => row.name)).toEqual(["Finance", "Support"]);
    expect(record(await run(actor, "RelationGroup.get", { id: teamId }))).toMatchObject({ group_type: "team" });

    const departmentLease = await lease(actor, "Team.update", departmentId).catch((error) => error);
    expect(departmentLease).toMatchObject({ operationError: { code: "NOT_FOUND" } });

    const teamLease = await lease(actor, "Team.update", teamId);
    expect(teamLease.entityId).toBe("core.RelationGroup");
    expect(record(await run(actor, "Team.update", {
      id: teamId, values: { name: "Support desk" }, expectedVersion: teamLease.targetVersion, leaseToken: teamLease.leaseToken,
    }))).toMatchObject({ name: "Support desk" });
    expect(await stored(teamId)).toMatchObject({ name: "Support desk", group_type: "team" });

    const retype = await lease(actor, "Team.update", teamId);
    expect(failure(await run(actor, "Team.update", {
      id: teamId, values: { groupType: "department" }, expectedVersion: retype.targetVersion, leaseToken: retype.leaseToken,
    }))).toMatchObject({ code: "BAD_USER_INPUT" });
    expect(await stored(teamId)).toMatchObject({ group_type: "team" });

    const deleteDepartment = await run(actor, "Team.delete", { id: departmentId, expectedVersion: await version(departmentId), leaseToken: "none" });
    expect(deleteDepartment).toMatchObject({ error: { code: expect.stringMatching(/NOT_FOUND|LEASE_INVALID|CONFIRMATION_REQUIRED/) } });
    expect(await stored(departmentId)).toMatchObject({ group_type: "department", name: "Finance" });
  });

  test("the base's edit lease is the record's one lease through either projection", async () => {
    const holder = session(randomUUID());
    const other = { ...session(holder.tenantId) };
    const teamId = String(record(await run(holder, "Team.create", { values: { name: "Locked" } })).id);
    const held = await lease(holder, "Team.update", teamId);
    await expect(lease(other, "RelationGroup.update", teamId)).rejects.toMatchObject({ operationError: { code: "LOCKED" } });
    await expect(lease(other, "Team.update", teamId)).rejects.toMatchObject({ operationError: { code: "LOCKED" } });
    // The holder's own lease is consumed by the Team update it was taken for.
    expect(record(await run(holder, "Team.update", {
      id: teamId, values: { name: "Unlocked" }, expectedVersion: held.targetVersion, leaseToken: held.leaseToken,
    }))).toMatchObject({ name: "Unlocked" });
  });

  test("a team deleted through its own Operation is gone from the base; a retyped team leaves the subtype", async () => {
    const actor = session(randomUUID());
    const teamId = String(record(await run(actor, "Team.create", { values: { name: "Temporary" } })).id);
    const held = await lease(actor, "Team.delete", teamId);
    const challenge = await run(actor, "Team.delete", { id: teamId, expectedVersion: held.targetVersion, leaseToken: held.leaseToken });
    const confirmation = (("error" in challenge ? challenge.error : undefined)?.data as { confirmation?: { challengeToken: string } } | undefined)?.confirmation;
    expect(confirmation?.challengeToken).toBeString();
    const deleted = await run(actor, "Team.delete", {
      id: teamId, expectedVersion: held.targetVersion, leaseToken: held.leaseToken,
      confirmationToken: confirmation!.challengeToken, confirmationAnswer: "Temporary",
    });
    expect(deleted).toMatchObject({ intent: "delete", data: { deleted: true } });
    expect(await stored(teamId)).toBeUndefined();

    const movingId = String(record(await run(actor, "Team.create", { values: { name: "Moving" } })).id);
    const baseLease = await lease(actor, "RelationGroup.update", movingId);
    expect(record(await run(actor, "RelationGroup.update", {
      id: movingId, values: { groupType: "project" }, expectedVersion: baseLease.targetVersion, leaseToken: baseLease.leaseToken,
    }))).toMatchObject({ group_type: "project" });
    expect(rows(await run(actor, "Team.list", {})).map((row) => row.id)).not.toContain(movingId);
  });

  test("another tenant and a session without the group roles reach nothing", async () => {
    const owner = session(randomUUID());
    const teamId = String(record(await run(owner, "Team.create", { values: { name: "Private" } })).id);
    const stranger = session(randomUUID());
    expect(rows(await run(stranger, "Team.list", {}))).toEqual([]);
    const got = await run(stranger, "Team.get", { id: teamId });
    expect("error" in got ? got.error : got.data).toBeNull();
    await expect(lease(stranger, "Team.update", teamId)).rejects.toMatchObject({ operationError: { code: "NOT_FOUND" } });

    const reader = session(owner.tenantId, ["Relations.All.Read"]);
    expect(record(await run(reader, "Team.get", { id: teamId }))).toMatchObject({ name: "Private" });
    expect(failure(await run(reader, "Team.create", { values: { name: "Denied" } }))).toMatchObject({ code: "FORBIDDEN" });
    expect(failure(await run(session(owner.tenantId, []), "Team.list", {}))).toMatchObject({ code: "FORBIDDEN" });
  });
});
