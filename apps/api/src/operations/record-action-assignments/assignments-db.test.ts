// SPDX-License-Identifier: BUSL-1.1
/**
 * The assignment surface against a migrated scratch database, through the
 * RESTRICTED app role — the role the API connects as, NOSUPERUSER and
 * NOBYPASSRLS — and against the two entities the repository's own authoring
 * layer declares an action on.
 *
 * What each group is here to prove, in order of how badly it would hurt:
 *
 *   1. the listing is bounded by ordinary record authorization. A record this
 *      session may not view does not appear, whatever it grants; the ACL
 *      itself never leaves; an entity whose read roles the session lacks is
 *      omitted AND reported;
 *   2. both halves take the integration-management authority, and a machine
 *      carrier is refused whichever way it authenticated. A change needs the
 *      entity's write roles and the record's own edit permission on top;
 *   3. a change is tenant-bound on both sides: the record and the integration;
 *   4. a change preserves everything it was not asked to change, and the right
 *      it grants is the one `app.record_action_allows` then answers — the read
 *      model and the authorizer agree because they read the same ACL;
 *   6. the route's integration and the locator's must agree, so a detail route
 *      under one integration cannot reach another;
 *   7. a grant and a simultaneous disable of its subject resolve one way or
 *      the other and never both, in either commit order;
 *   5. two concurrent changes to the same record serialize on the ACL row, so
 *      neither is lost, and a stale expectedVersion is refused.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { APP_ROLE } from "../../db/migrations/app-role.js";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import { listRecordActionAssignments, readRecordActionAssignment } from "./read-model.js";
import { setRecordActionAssignment, type SetAssignmentInput } from "./mutation.js";
import { recordActionsOperationHandler } from "./operations.js";
import { RECORD_ACTION_GRANT_TARGET, recordActionGrantInputs } from "./registry.js";
import { formatAssignmentLocator, parseAssignmentLocator } from "./locator.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = process.env.SCRATCH_APP_ROLE_PASSWORD ?? "openshapeforge_app";
const TEST_TIMEOUT = 180_000;
const scratch = `record_action_assignments_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

const RUN = "ExternalProcessRun";
const METER = "MeterConnection";
const WRITE_ROLE = "Organization.All.ReadWrite";
const READ_ROLE = "Organization.All.Read";
const METER_WRITE_ROLE = "Energy.All.ReadWrite";
/** The authority this whole surface takes, read half included (authority.ts). */
const MANAGE_KEYS = "Platform.ApiKeys.Manage";

const tenantA = randomUUID();
const tenantB = randomUUID();
const manager = randomUUID();
const outsider = randomUUID();
const integration = randomUUID();
const otherIntegration = randomUUID();
const disabledIntegration = randomUUID();
const tenantBIntegration = randomUUID();

/** Records, so the keyset has something to page over. `sortedRuns` is the order. */
const runRows = [randomUUID(), randomUUID(), randomUUID()].sort();
const hiddenRun = randomUUID();
const tenantBRun = randomUUID();
const meterRow = randomUUID();
/** A second entity's granted row, so the keyset has to cross an entity boundary. */
const pagedMeter = randomUUID();
const concurrentRun = randomUUID();

function url(name: string, app = false): string {
  const parsed = new URL(ADMIN_URL);
  if (parsed.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  parsed.pathname = `/${name}`;
  if (app) {
    parsed.username = APP_ROLE;
    parsed.password = APP_ROLE_PASSWORD;
  }
  return parsed.toString();
}

type Session = TrustedSessionContext & DbSessionInput;

/** A session as the SERVER would have classified it, never as a caller asks. */
function session(overrides: Partial<Session> = {}): Session {
  return {
    tenantId: tenantA,
    userId: manager,
    roles: [MANAGE_KEYS, WRITE_ROLE, READ_ROLE, METER_WRITE_ROLE],
    groups: [],
    relationGroupIds: [],
    scope: "self",
    credential: "bearer",
    principalKind: "person",
    ...overrides,
  } as Session;
}

/** A session the server could not classify; `principalKind` is absent, not empty. */
function unclassified(overrides: Partial<Session> = {}): Session {
  const { principalKind, ...rest } = session(overrides);
  return rest as Session;
}

/**
 * A change, with the route's integration defaulting to the one the locator
 * names — the agreeing case, which is every call but the ones that test the
 * disagreement on purpose.
 */
function setAssignment(
  carrier: Session,
  input: Omit<SetAssignmentInput, "integrationId"> & { integrationId?: string },
): Promise<Awaited<ReturnType<typeof setRecordActionAssignment>>> {
  const parsed = parseAssignmentLocator(input.assignment);
  return setRecordActionAssignment(app.db, carrier, {
    ...input,
    integrationId: input.integrationId ?? parsed?.integrationId ?? "",
  });
}

/**
 * The two integrations as the stored axis orders them.
 *
 * Both are random uuids and the canonical axis sorts every subject list, so a
 * literal pair of them is a coin flip from run to run.
 */
const bothIntegrations = () => [integration, otherIntegration].sort();

const aclFor = (integrations: string[], extra: Record<string, unknown> = {}) => JSON.stringify({
  view: { users: [manager] },
  edit: { users: [manager] },
  delete: { users: [manager] },
  ...extra,
  ...(integrations.length ? { actions: { start: { integrations }, follow: { integrations } } } : {}),
});

let server: SQL;
let admin: DatabaseRuntime;
let app: DatabaseRuntime;

beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(scratch)) throw new Error("unsafe scratch database name");
  server = new SQL(ADMIN_URL, { max: 1 });
  await server.unsafe(`create database "${scratch}"`);
  admin = createDatabaseRuntime({ databaseUrl: url(scratch), maxConnections: 4 });
  await admin.db.connection().execute((conn) => runMigrationChain(conn));

  await admin.db.connection().execute(async (conn) => {
    for (const [id, tenant, status] of [
      [integration, tenantA, "active"],
      [otherIntegration, tenantA, "active"],
      [disabledIntegration, tenantA, "disabled"],
      [tenantBIntegration, tenantB, "active"],
    ] as const) {
      await sql`
        insert into platform.api_key_integrations
          (id, tenant_id, display_name, keycloak_client_id, status, created_by)
        values (${id}::uuid, ${tenant}::uuid, ${`integration ${status}`},
          ${`client-${id}`}, ${status}, ${manager}::uuid)
      `.execute(conn);
    }
    // Three visible runs that all grant start+follow, one the manager cannot
    // view that grants the same, and one in the other tenant that does too.
    for (const [index, id] of runRows.entries()) {
      await sql`
        insert into erp.external_process_runs (id, tenant_id, name, definition, status, notes, "authorization")
        values (${id}::uuid, ${tenantA}::uuid, ${`run ${index}`}, 'graph', 'ready', 'private note',
          ${sql.raw(`'${aclFor([integration])}'::jsonb`)})
      `.execute(conn);
    }
    await sql`
      insert into erp.external_process_runs (id, tenant_id, name, definition, status, "authorization")
      values (${hiddenRun}::uuid, ${tenantA}::uuid, 'hidden run', 'graph', 'ready',
        ${sql.raw(`'${JSON.stringify({ view: { users: [outsider] }, actions: { start: { integrations: [integration] } } })}'::jsonb`)})
    `.execute(conn);
    await sql`
      insert into erp.external_process_runs (id, tenant_id, name, definition, status, "authorization")
      values (${tenantBRun}::uuid, ${tenantB}::uuid, 'other tenant run', 'graph', 'ready',
        ${sql.raw(`'${aclFor([integration])}'::jsonb`)})
    `.execute(conn);
    await sql`
      insert into erp.external_process_runs (id, tenant_id, name, definition, status, "authorization")
      values (${concurrentRun}::uuid, ${tenantA}::uuid, 'concurrent run', 'graph', 'ready',
        ${sql.raw(`'${aclFor([])}'::jsonb`)})
    `.execute(conn);
    // The non-process use case. empty: public, so the record is ordinary
    // tenant data while the action stays closed.
    await sql`
      insert into erp.meter_connections (id, tenant_id, name, meter_key, location, "authorization")
      values (${meterRow}::uuid, ${tenantA}::uuid, 'connection 1', 'MK-1', 'Depot', '{}'::jsonb)
    `.execute(conn);
    await sql`
      insert into erp.meter_connections (id, tenant_id, name, meter_key, location, "authorization")
      values (${pagedMeter}::uuid, ${tenantA}::uuid, 'connection 2', 'MK-2', 'Depot',
        ${sql.raw(`'${JSON.stringify({ actions: { submitReading: { integrations: [integration] } } })}'::jsonb`)})
    `.execute(conn);
  });
  app = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 4 });
}, TEST_TIMEOUT);

afterAll(async () => {
  await app?.close();
  await admin?.close();
  await server?.unsafe(`drop database if exists "${scratch}" with (force)`);
  await server?.close();
});

async function storedAcl(entity: string, id: string): Promise<Record<string, unknown>> {
  const table = entity === RUN ? sql.id("erp", "external_process_runs") : sql.id("erp", "meter_connections");
  const result = await admin.db.connection().execute(async (conn) =>
    (await sql<{ document: Record<string, unknown> }>`
      select "authorization" as document from ${table} where id = ${id}::uuid
    `.execute(conn)).rows[0]!);
  return result.document;
}

/** The authorizer's own answer, for the integration the ACL names. */
async function allows(entity: string, id: string, action: string, integrationId: string): Promise<boolean> {
  const machine = session({
    userId: randomUUID(), principalKind: "service", roles: [],
    // A resolved API-key session names its credential row beside its
    // integration (auth/trusted-context.ts, VerifiedAppPrincipal).
    // `app.record_action_allows` never reads it — the credential fence is its
    // own function — so a synthetic id is the honest fixture here.
    appPrincipal: { integrationId, credentialId: randomUUID() },
  });
  return withDbSession(app.db, machine, async (trx) =>
    (await sql<{ allowed: boolean | null }>`
      select app.record_action_allows(${entity}, ${id}, ${action}) as allowed
    `.execute(trx)).rows[0]?.allowed === true);
}

describe("the listing stays inside ordinary record authorization", () => {
  test("reports the records this session may read, and not the one it may not", async () => {
    const page = await listRecordActionAssignments(app.db, session(), { integrationId: integration, first: 100 });
    const runs = page.assignments.filter((row) => row.entity === RUN);
    expect([...new Set(runs.map((row) => row.recordId))].sort()).toEqual(runRows);
    // Grants it, in this tenant, and invisible to this manager: absent.
    expect(runs.some((row) => row.recordId === hiddenRun)).toBe(false);
    expect(await allows(RUN, hiddenRun, "start", integration)).toBe(true);
    // Another tenant's record that names the same integration: absent.
    expect(runs.some((row) => row.recordId === tenantBRun)).toBe(false);
    expect(page.assignments.every((row) => row.manageable)).toBe(true);
    expect(page.visibility).toEqual({
      scope: "readable-records", omittedEntities: [], namesWithheld: false,
    });
    // There is no "complete": the hidden run above grants the same action and
    // is simply not a row here, so no field of this page may claim totality.
    expect(page.visibility).not.toHaveProperty("complete");
  }, TEST_TIMEOUT);

  test("returns the record's name and action, and nothing of its authorization", async () => {
    const page = await listRecordActionAssignments(app.db, session(), {
      integrationId: integration, entity: RUN, action: "start", first: 100,
    });
    expect(page.assignments.map((row) => row.action)).toEqual(["start", "start", "start"]);
    expect(page.assignments.map((row) => row.recordName).sort()).toEqual(["run 0", "run 1", "run 2"]);
    const serialized = JSON.stringify(page);
    // No ACL document, no other subject, and nothing of the row the action did
    // not declare.
    expect(serialized).not.toContain("private note");
    expect(serialized).not.toContain("\"view\"");
    expect(serialized).not.toContain(manager);
    expect(serialized).not.toContain(otherIntegration);
    expect(page.totalCount).toBeNull();
  }, TEST_TIMEOUT);

  test("an integration holds only what names it, and an undeclared action yields nothing", async () => {
    const other = await listRecordActionAssignments(app.db, session(), { integrationId: otherIntegration });
    expect(other.assignments).toEqual([]);
    const undeclared = await listRecordActionAssignments(app.db, session(), {
      integrationId: integration, action: "publish",
    });
    expect(undeclared.assignments).toEqual([]);
    // A record permission is not an action and can never be named as one.
    for (const action of ["view", "edit", "delete"]) {
      const page = await listRecordActionAssignments(app.db, session(), { integrationId: integration, action });
      expect(page.assignments).toEqual([]);
    }
  }, TEST_TIMEOUT);

  test("the subject must be an integration of this tenant", async () => {
    for (const subject of [tenantBIntegration, randomUUID()]) {
      expect(listRecordActionAssignments(app.db, session(), { integrationId: subject }))
        .rejects.toThrow(/No such integration/);
    }
    // A disabled one is still listable: a leftover grant has to be findable
    // before it can be removed.
    const page = await listRecordActionAssignments(app.db, session(), {
      integrationId: disabledIntegration,
    });
    expect(page.assignments).toEqual([]);
  }, TEST_TIMEOUT);

  test("an entity whose read roles the session lacks is omitted and reported", async () => {
    const withoutMeter = session({ roles: [MANAGE_KEYS, WRITE_ROLE, READ_ROLE] });
    const page = await listRecordActionAssignments(app.db, withoutMeter, { integrationId: integration });
    expect(page.visibility.omittedEntities).toEqual([{ entity: METER, reason: "no-read-authority" }]);
    expect(page.assignments.every((row) => row.entity === RUN)).toBe(true);
  }, TEST_TIMEOUT);

  test("a session that may read but not write sees the rows as unmanageable", async () => {
    const reader = session({ roles: [MANAGE_KEYS, READ_ROLE] });
    const page = await listRecordActionAssignments(app.db, reader, { integrationId: integration, entity: RUN });
    expect(page.assignments.length).toBeGreaterThan(0);
    expect(page.assignments.every((row) => row.manageable === false)).toBe(true);
  }, TEST_TIMEOUT);

  test("pages by keyset without repeating or losing a row, in either direction", async () => {
    // The corpus is deliberately awkward in all three ways a keyset over
    // (entity, record, action) can break: several records per entity, several
    // ACTIONS on one record — so a page can end in the middle of a record —
    // and several entities, so a page can end at an entity boundary.
    for (const direction of ["asc", "desc"] as const) {
      const all = await listRecordActionAssignments(app.db, session(), {
        integrationId: integration, first: 100, direction,
      });
      expect(all.assignments.length).toBe(7);
      expect(all.nextCursor).toBeNull();
      expect(new Set(all.assignments.map((row) => row.entity))).toEqual(new Set([RUN, METER]));
      // Several actions land on one record, which is the case the cursor has
      // to resume INSIDE rather than past.
      expect(all.assignments.filter((row) => row.recordId === runRows[0]).length).toBe(2);

      // Every page size from 1 to one more than the corpus: the boundary falls
      // in a different place each time, including exactly on the last row.
      for (const first of [1, 2, 3, 6, 7, 8]) {
        const seen: string[] = [];
        let after: string | undefined;
        for (let page = 0; page < 20; page += 1) {
          const result = await listRecordActionAssignments(app.db, session(), {
            integrationId: integration, first, direction, ...(after ? { after } : {}),
          });
          expect(result.assignments.length).toBeLessThanOrEqual(first);
          seen.push(...result.assignments.map((row) => row.id));
          if (!result.nextCursor) break;
          after = result.nextCursor;
        }
        // Same rows, same order, no row seen twice and none skipped at a
        // boundary — the failure a cursor naming the first NOT-returned row
        // produces, which is one lost row per page.
        expect(seen).toEqual(all.assignments.map((row) => row.id));
        expect(new Set(seen).size).toBe(seen.length);
      }
    }

    // Ascending and descending visit the same set in opposite order.
    const up = await listRecordActionAssignments(app.db, session(), {
      integrationId: integration, first: 100, direction: "asc",
    });
    const down = await listRecordActionAssignments(app.db, session(), {
      integrationId: integration, first: 100, direction: "desc",
    });
    expect(down.assignments.map((row) => row.id)).toEqual([...up.assignments].reverse().map((row) => row.id));
  }, TEST_TIMEOUT);

  test("a cursor is refused rather than guessed at", async () => {
    for (const after of ["not-a-cursor", Buffer.from("[1,2]").toString("base64url")]) {
      expect(listRecordActionAssignments(app.db, session(), { integrationId: integration, after }))
        .rejects.toThrow(/cursor is not valid/);
    }
  }, TEST_TIMEOUT);
});

describe("a change needs every authority, and a person's carrier", () => {
  const locator = (entity: string, recordId: string, action: string, integrationId = integration) =>
    formatAssignmentLocator({ entity, recordId, action, integrationId });

  test("every carrier but a verified person is refused, on both halves of the surface", async () => {
    const target = locator(RUN, concurrentRun, "start");
    const carriers: Array<[Session, RegExp]> = [
      [session({
        appPrincipal: { integrationId: integration, credentialId: randomUUID() },
      }), /verified person/],
      [session({ principalKind: "service" }), /verified person/],
      // Absence is not a person either: a bearer the verifier could classify
      // as neither, and the in-mesh bundle of a producer that predates the
      // signed class, are both refused rather than left to the role check.
      [unclassified(), /verified person/],
      [unclassified({ credential: "trusted-context" }), /verified person/],
      [session({ credential: "api-key" }), /API keys cannot manage API keys/],
      [session({ credential: "grant" }), /capability grant/],
    ];
    for (const [carrier, message] of carriers) {
      expect(setAssignment(carrier, { assignment: target, assigned: true })).rejects.toThrow(message);
      // The READ half refuses for the same reason, so a machine cannot survey
      // the estate it is not allowed to change.
      expect(listRecordActionAssignments(app.db, carrier, { integrationId: integration }))
        .rejects.toThrow(message);
    }
    // None of them changed anything.
    expect(await storedAcl(RUN, concurrentRun)).toEqual({
      view: { users: [manager] }, edit: { users: [manager] }, delete: { users: [manager] },
    });
  }, TEST_TIMEOUT);

  test("a carrier the server could not classify is refused, roles and all", async () => {
    // Absence proves nothing. The same session with the class the server
    // actually derived IS admitted, so the refusal is the missing verdict and
    // not the roles — which are identical in both calls.
    expect(listRecordActionAssignments(app.db, unclassified(), {
      integrationId: integration, entity: RUN,
    })).rejects.toThrow(/verified person/);
    const page = await listRecordActionAssignments(app.db, session(), {
      integrationId: integration, entity: RUN,
    });
    expect(page.assignments.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT);

  test("the integration-management role is required, not the organization's access role", async () => {
    // The hole this closes: an ordinary organization administrator holding
    // every entity write role could otherwise grant any tenant integration
    // reach into any record it can edit, and survey every integration's
    // estate, without ever holding the right that provisions an integration.
    const orgAdmin = session({
      roles: ["Organization.Access.Manage", WRITE_ROLE, READ_ROLE, METER_WRITE_ROLE],
    });
    expect(listRecordActionAssignments(app.db, orgAdmin, { integrationId: integration }))
      .rejects.toThrow(/Not authorized to manage record action assignments/);
    expect(readRecordActionAssignment(app.db, orgAdmin, {
      entity: RUN, recordId: runRows[0]!, action: "start", integrationId: integration,
    })).rejects.toThrow(/Not authorized to manage record action assignments/);
    expect(setAssignment(orgAdmin, { assignment: locator(RUN, concurrentRun, "start"), assigned: true }))
      .rejects.toThrow(/Not authorized to manage record action assignments/);
    expect(await storedAcl(RUN, concurrentRun)).not.toHaveProperty("actions");
  }, TEST_TIMEOUT);

  test("the route's integration must be the one the assignment names", async () => {
    // A detail route under integration B carrying a locator for integration A
    // is two different requests. Refused, so the surface's own scoping is not
    // decorative — and refused even though this session may manage both.
    expect(setAssignment(session(), {
      assignment: locator(RUN, concurrentRun, "start", integration),
      integrationId: otherIntegration,
      assigned: true,
    })).rejects.toThrow(/does not belong to the integration in the request path/);
    expect(await storedAcl(RUN, concurrentRun)).not.toHaveProperty("actions");
  }, TEST_TIMEOUT);

  test("a person without the entity's write roles is refused", async () => {
    const reader = session({ roles: [MANAGE_KEYS, READ_ROLE] });
    expect(setAssignment(reader, {
      assignment: locator(RUN, concurrentRun, "start"), assigned: true,
    })).rejects.toThrow();
  }, TEST_TIMEOUT);

  test("a person with the roles but without the record's edit permission is refused", async () => {
    const stranger = session({ userId: outsider });
    expect(setAssignment(stranger, {
      assignment: locator(RUN, runRows[0]!, "follow"), assigned: true,
    })).rejects.toThrow();
    expect((await storedAcl(RUN, runRows[0]!)).actions)
      .toEqual({ start: { integrations: [integration] }, follow: { integrations: [integration] } });
  }, TEST_TIMEOUT);

  test("neither tenant boundary can be crossed", async () => {
    // The record is the other tenant's.
    expect(setAssignment(session(), {
      assignment: locator(RUN, tenantBRun, "start"), assigned: true,
    })).rejects.toThrow(/No ExternalProcessRun record in this tenant/);
    // The integration is the other tenant's.
    expect(setAssignment(session(), {
      assignment: locator(RUN, concurrentRun, "start", tenantBIntegration), assigned: true,
    })).rejects.toThrow(/integration/);
    // The session claims the other tenant; the record is this one's.
    expect(setAssignment(session({ tenantId: tenantB }), {
      assignment: locator(RUN, concurrentRun, "start"), assigned: true,
    })).rejects.toThrow();
    expect(await storedAcl(RUN, tenantBRun)).toHaveProperty("actions");
  }, TEST_TIMEOUT);

  test("an undeclared action, an unknown entity and a disabled integration are refused", async () => {
    for (const assignment of [
      locator(RUN, concurrentRun, "publish"),
      locator("Relation", concurrentRun, "start"),
      locator(METER, meterRow, "start"),
    ]) {
      expect(setAssignment(session(), { assignment, assigned: true }))
        .rejects.toThrow();
    }
    // A disabled integration may not be GIVEN a hold.
    expect(setAssignment(session(), {
      assignment: locator(RUN, concurrentRun, "start", disabledIntegration), assigned: true,
    })).rejects.toThrow(/active integration/);
  }, TEST_TIMEOUT);
});

describe("a change is minimal, atomic and is what the authorizer then answers", () => {
  test("granting one action leaves every other subject and permission untouched", async () => {
    const before = await storedAcl(RUN, concurrentRun);
    expect(await allows(RUN, concurrentRun, "start", integration)).toBe(false);
    const change = await setAssignment(session(), {
      assignment: formatAssignmentLocator({ entity: RUN, recordId: concurrentRun, action: "start", integrationId: integration }),
      assigned: true,
    });
    expect(change.changed).toBe(true);
    expect(change.assigned).toBe(true);
    const after = await storedAcl(RUN, concurrentRun);
    expect(after).toEqual({ ...before, actions: { start: { integrations: [integration] } } });
    // The read model and the authorizer now agree, because they read the same
    // ACL rather than two copies of it.
    expect(await allows(RUN, concurrentRun, "start", integration)).toBe(true);
    expect(await allows(RUN, concurrentRun, "follow", integration)).toBe(false);
    expect(await allows(RUN, concurrentRun, "start", otherIntegration)).toBe(false);
    const read = await readRecordActionAssignment(app.db, session(), {
      entity: RUN, recordId: concurrentRun, action: "start", integrationId: integration,
    });
    expect(read?.recordName).toBe("concurrent run");
    expect(read?.manageable).toBe(true);
  }, TEST_TIMEOUT);

  test("the change leaves the entity's own audit trail behind it", async () => {
    // Not a second log: the write is the entity's ordinary update, so it is
    // the entity's own audit trigger that records it, under the session this
    // transaction established. The actor KIND and the operation id come from
    // the canonical dispatch wrapper (withAuditContext), which calling the
    // handler's function directly does not establish — so what is asserted
    // here is the trail and its subject, not the dispatch metadata.
    const events = await admin.db.connection().execute(async (conn) =>
      (await sql<{ event_type: string; payload: Record<string, unknown> }>`
        select event_type, payload from platform.entity_events
         where aggregate_id = ${concurrentRun} and tenant_id = ${tenantA}::uuid
         order by occurred_at desc limit 1
      `.execute(conn)).rows);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("updated");
    const audit = (events[0]!.payload as { audit: Record<string, unknown> }).audit;
    expect(audit.entityType).toBe(RUN);
    expect(audit.actorSubject).toBe(manager);
    expect(audit.actorId).toBe(manager);
    expect(audit.changedFields).toBeArray();
  }, TEST_TIMEOUT);

  test("a second integration joins the same action without displacing the first", async () => {
    await setAssignment(session(), {
      assignment: formatAssignmentLocator({ entity: RUN, recordId: concurrentRun, action: "start", integrationId: otherIntegration }),
      assigned: true,
    });
    expect((await storedAcl(RUN, concurrentRun)).actions)
      .toEqual({ start: { integrations: bothIntegrations() } });
    expect(await allows(RUN, concurrentRun, "start", integration)).toBe(true);
    expect(await allows(RUN, concurrentRun, "start", otherIntegration)).toBe(true);
  }, TEST_TIMEOUT);

  test("revoking removes exactly one subject, and the entry once nobody is left", async () => {
    const target = (integrationId: string) => formatAssignmentLocator({
      entity: RUN, recordId: concurrentRun, action: "start", integrationId,
    });
    await setAssignment(session(), { assignment: target(integration), assigned: false });
    expect((await storedAcl(RUN, concurrentRun)).actions)
      .toEqual({ start: { integrations: [otherIntegration] } });
    expect(await allows(RUN, concurrentRun, "start", integration)).toBe(false);
    // A disabled integration's leftover grant can still be cleaned up.
    await setAssignment(session(), {
      assignment: target(disabledIntegration), assigned: false,
    });
    await setAssignment(session(), { assignment: target(otherIntegration), assigned: false });
    expect(await storedAcl(RUN, concurrentRun)).not.toHaveProperty("actions");
    // Repeating a revoke is not an error and writes nothing.
    const repeat = await setAssignment(session(), {
      assignment: target(otherIntegration), assigned: false,
    });
    expect(repeat.changed).toBe(false);
  }, TEST_TIMEOUT);

  test("the second, non-process use case behaves the same and honours its version", async () => {
    const target = formatAssignmentLocator({
      entity: METER, recordId: meterRow, action: "submitReading", integrationId: integration,
    });
    // expectedVersion is the caller's own fence, not a demand of the entity:
    // the ACL row is locked either way, so omitting it cannot lose a change —
    // supplying a STALE one is what this refuses.
    const version = (await withDbSession(app.db, session(), async (trx) =>
      (await sql<{ updated_at: Date }>`
        select updated_at from erp.meter_connections where id = ${meterRow}::uuid
      `.execute(trx)).rows[0]!)).updated_at.toISOString();
    expect(setAssignment(session(), {
      assignment: target, assigned: true, expectedVersion: new Date(0).toISOString(),
    })).rejects.toThrow(/changed since you loaded it/);
    const change = await setAssignment(session(), {
      assignment: target, assigned: true, expectedVersion: version,
    });
    expect(change.changed).toBe(true);
    expect(change.version).not.toBe(version);
    expect(await storedAcl(METER, meterRow)).toEqual({ actions: { submitReading: { integrations: [integration] } } });
    expect(await allows(METER, meterRow, "submitReading", integration)).toBe(true);
    // The record stays ordinary tenant data (empty: public) while the action
    // remains closed to everyone the entry does not name.
    expect(await allows(METER, meterRow, "submitReading", otherIntegration)).toBe(false);
  }, TEST_TIMEOUT);

  test("two concurrent changes to one record serialize, and neither is lost", async () => {
    const start = formatAssignmentLocator({ entity: RUN, recordId: runRows[1]!, action: "start", integrationId: otherIntegration });
    const follow = formatAssignmentLocator({ entity: RUN, recordId: runRows[1]!, action: "follow", integrationId: otherIntegration });
    const [first, second] = await Promise.all([
      setAssignment(session(), { assignment: start, assigned: true }),
      setAssignment(session(), { assignment: follow, assigned: true }),
    ]);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(true);
    expect((await storedAcl(RUN, runRows[1]!)).actions).toEqual({
      start: { integrations: bothIntegrations() },
      follow: { integrations: bothIntegrations() },
    });
    for (const action of ["start", "follow"]) {
      expect(await allows(RUN, runRows[1]!, action, integration)).toBe(true);
      expect(await allows(RUN, runRows[1]!, action, otherIntegration)).toBe(true);
    }
  }, TEST_TIMEOUT);

  test("a stale expectedVersion is refused after a concurrent change", async () => {
    const recordId = runRows[2]!;
    const target = (integrationId: string) => formatAssignmentLocator({
      entity: RUN, recordId, action: "start", integrationId,
    });
    const before = await readRecordActionAssignment(app.db, session(), {
      entity: RUN, recordId, action: "start", integrationId: integration,
    });
    expect(before?.version).toBeString();
    await setAssignment(session(), { assignment: target(otherIntegration), assigned: true });
    expect(setAssignment(session(), {
      assignment: target(integration), assigned: false, expectedVersion: before!.version!,
    })).rejects.toThrow(/changed since you loaded it/);
    expect((await storedAcl(RUN, recordId)).actions).toEqual({
      start: { integrations: bothIntegrations() },
      follow: { integrations: [integration] },
    });
  }, TEST_TIMEOUT);
});

/**
 * The handlers as a transport reaches them, rather than their functions.
 *
 * Worth doing separately because the route parameter only exists at this
 * layer: `getAssignment` and `setAssignment` take the integration from the
 * path, and `grantAssignment` is the collection action that makes an empty
 * list usable. A check that lived only in the functions would leave the
 * handlers free to pass whatever they liked.
 */
describe("the handlers bind the route's integration, and the first grant works", () => {
  const call = (handler: string, input: Record<string, unknown>, carrier: Session = session()) =>
    recordActionsOperationHandler({ key: `record-actions.${handler}`, handler })(
      input, { db: app.db, session: carrier } as never);

  const firstGrantRun = randomUUID();
  /** The second entity's first grant: another owner, another declared action. */
  const firstGrantMeter = randomUUID();

  /**
   * One variant of the generated form, by the two rules the compiler generated
   * it with (registry.ts, `RECORD_ACTION_GRANT_TARGET` and
   * `recordActionGrantInputs`) — so this test submits the input a browser
   * would, rather than names it agreed with itself.
   */
  const variantOf = (entity: string, recordId: string, action: string) => {
    const names = recordActionGrantInputs(entity);
    return { entity, [names.record]: recordId, [names.action]: action };
  };
  const grantOf = (entity: string, recordId: string, action: string) =>
    ({ [RECORD_ACTION_GRANT_TARGET]: variantOf(entity, recordId, action) });

  beforeAll(async () => {
    await admin.db.connection().execute(async (conn) => {
      await sql`
        insert into erp.external_process_runs (id, tenant_id, name, definition, status, "authorization")
        values (${firstGrantRun}::uuid, ${tenantA}::uuid, 'first grant run', 'graph', 'ready',
          ${sql.raw(`'${aclFor([])}'::jsonb`)})
      `.execute(conn);
      await sql`
        insert into erp.meter_connections (id, tenant_id, name, meter_key, location, "authorization")
        values (${firstGrantMeter}::uuid, ${tenantA}::uuid, 'first grant connection', 'MK-3', 'Depot',
          '{}'::jsonb)
      `.execute(conn);
    });
  }, TEST_TIMEOUT);

  test("the collection action gives an integration its first action on a record", async () => {
    // The empty-list case: no assignment row exists for this record yet, so
    // there is nothing to open a detail route on. The collection action takes
    // the record type and, under the inputs of THAT type, the record and the
    // action — the variant shape the compiler generates the form in
    // (packages/compiler/src/record-action-grants.ts).
    const before = await listRecordActionAssignments(app.db, session(), {
      integrationId: otherIntegration, entity: RUN, recordId: firstGrantRun, first: 1,
    });
    expect(before.assignments).toEqual([]);
    const result = await call("grantAssignment", {
      integrationId: otherIntegration, ...grantOf(RUN, firstGrantRun, "start"),
    }) as { value: { changed: boolean; assigned: boolean; id: string } };
    expect(result.value.changed).toBe(true);
    expect(result.value.assigned).toBe(true);
    const after = await listRecordActionAssignments(app.db, session(), {
      integrationId: otherIntegration, entity: RUN, recordId: firstGrantRun, first: 10,
    });
    expect(after.assignments.map((row) => row.action)).toEqual(["start"]);
    expect(after.assignments[0]!.id).toBe(result.value.id);
    expect(await allows(RUN, firstGrantRun, "start", otherIntegration)).toBe(true);
    // Only what was asked for: the human permissions and the other action are
    // exactly as they were.
    expect(await storedAcl(RUN, firstGrantRun)).toEqual({
      view: { users: [manager] }, edit: { users: [manager] }, delete: { users: [manager] },
      actions: { start: { integrations: [otherIntegration] } },
    });
  }, TEST_TIMEOUT);

  test("the first grant is listed on reload, and a second entity's variant works the same way", async () => {
    // What a manager actually does next: the page reloads and the row is
    // there, under the locator the grant returned. The second entity proves
    // the variant is data and not a second code path — a different owner,
    // different write roles and a different declared action, one handler.
    const reloaded = await listRecordActionAssignments(app.db, session(), {
      integrationId: otherIntegration, entity: RUN, recordId: firstGrantRun, first: 10,
    });
    expect(reloaded.assignments.map((row) => [row.entity, row.action, row.manageable]))
      .toEqual([[RUN, "start", true]]);
    const meter = await call("grantAssignment", {
      integrationId: otherIntegration, ...grantOf(METER, firstGrantMeter, "submitReading"),
    }, session({ roles: [MANAGE_KEYS, METER_WRITE_ROLE] })) as { value: { id: string } };
    const meterRows = await listRecordActionAssignments(app.db, session(), {
      integrationId: otherIntegration, entity: METER, recordId: firstGrantMeter, first: 10,
    });
    expect(meterRows.assignments.map((row) => row.id)).toEqual([meter.value.id]);
    expect(await allows(METER, firstGrantMeter, "submitReading", otherIntegration)).toBe(true);
  }, TEST_TIMEOUT);

  test("the inputs of the record type the caller named are the only ones read", async () => {
    // A form switched from one record type to the other without clearing the
    // first: the other variant's inputs are present, and the one that counts
    // is the named type's. Nothing else can be acted on by leaving a value
    // behind.
    const stale = {
      integrationId: otherIntegration,
      [RECORD_ACTION_GRANT_TARGET]: {
        ...variantOf(RUN, firstGrantRun, "follow"),
        ...variantOf(METER, meterRow, "submitReading"),
        entity: RUN,
      },
    };
    await call("grantAssignment", stale);
    expect(await allows(RUN, firstGrantRun, "follow", otherIntegration)).toBe(true);
    expect(await allows(METER, meterRow, "submitReading", otherIntegration)).toBe(false);
    // And a record type whose own inputs are absent is refused rather than
    // falling back to whatever else the submission carried.
    expect(call("grantAssignment", {
      integrationId: otherIntegration,
      [RECORD_ACTION_GRANT_TARGET]: { ...variantOf(METER, meterRow, "submitReading"), entity: RUN },
    })).rejects.toThrow(/record and action of ExternalProcessRun are required/);
    // And an input with no variant at all is refused on the one input the
    // form submits, rather than read from the root it is not at.
    expect(call("grantAssignment", { integrationId: otherIntegration }))
      .rejects.toThrow(/record type, the record and the action are required/);
    expect(call("grantAssignment", {
      integrationId: otherIntegration, ...variantOf(RUN, firstGrantRun, "start"),
    })).rejects.toThrow(/record type, the record and the action are required/);
  }, TEST_TIMEOUT);

  test("the collection action refuses an entity, record or action it may not reach", async () => {
    for (const input of [
      // An action this entity does not declare.
      grantOf(RUN, firstGrantRun, "publish"),
      // An entity that carries no manageable action at all. Its variant does
      // not exist, so the handler finds no record and no action under it.
      grantOf("Relation", firstGrantRun, "start"),
      // Not an entity name at all.
      { [RECORD_ACTION_GRANT_TARGET]: { entity: "relation; drop table", recordId: firstGrantRun } },
      // Another tenant's record.
      grantOf(RUN, tenantBRun, "start"),
    ]) {
      expect(call("grantAssignment", { integrationId: integration, ...input })).rejects.toThrow();
    }
    for (const integrationId of [
      // Another tenant's integration.
      tenantBIntegration,
      // A disabled subject may not be given a hold.
      disabledIntegration,
    ]) {
      expect(call("grantAssignment", { integrationId, ...grantOf(RUN, firstGrantRun, "start") }))
        .rejects.toThrow();
    }
    expect(call("grantAssignment", {
      integrationId: integration, ...grantOf(RUN, firstGrantRun, "start"),
    }, session({ roles: [WRITE_ROLE, READ_ROLE] }))).rejects.toThrow(/Not authorized/);
  }, TEST_TIMEOUT);

  test("the single read and the change refuse a locator the route does not own", async () => {
    const own = formatAssignmentLocator({
      entity: RUN, recordId: firstGrantRun, action: "start", integrationId: otherIntegration,
    });
    const read = await call("getAssignment", { integrationId: otherIntegration, id: own }) as
      { value: { recordId: string } };
    expect(read.value.recordId).toBe(firstGrantRun);
    // Same locator, a route scoped to a DIFFERENT integration this session may
    // also manage: refused on both halves rather than answered about the one
    // the locator names.
    expect(call("getAssignment", { integrationId: integration, id: own }))
      .rejects.toThrow(/does not belong to the integration in the request path/);
    expect(call("setAssignment", { integrationId: integration, id: own, assigned: false }))
      .rejects.toThrow(/does not belong to the integration in the request path/);
    expect(await allows(RUN, firstGrantRun, "start", otherIntegration)).toBe(true);
  }, TEST_TIMEOUT);
});

/**
 * A grant and a simultaneous disable of the subject it names.
 *
 * The window this closes: a plain status read in a READ COMMITTED transaction
 * does not see an uncommitted disable, so the grant would land on an
 * integration that is disabled a moment later — inert, and silently effective
 * again if anyone re-activates it. `for share` turns that into one of two
 * honest outcomes, and both are asserted here.
 */
describe("a grant and a concurrent disable resolve one way, never both", () => {
  const raceRun = randomUUID();
  const raceIntegration = randomUUID();

  beforeAll(async () => {
    await admin.db.connection().execute(async (conn) => {
      await sql`
        insert into platform.api_key_integrations
          (id, tenant_id, display_name, keycloak_client_id, status, created_by)
        values (${raceIntegration}::uuid, ${tenantA}::uuid, 'race integration',
          ${`client-${raceIntegration}`}, 'active', ${manager}::uuid)
      `.execute(conn);
      await sql`
        insert into erp.external_process_runs (id, tenant_id, name, definition, status, "authorization")
        values (${raceRun}::uuid, ${tenantA}::uuid, 'race run', 'graph', 'ready',
          ${sql.raw(`'${aclFor([])}'::jsonb`)})
      `.execute(conn);
    });
  }, TEST_TIMEOUT);

  const target = (integrationId: string) => formatAssignmentLocator({
    entity: RUN, recordId: raceRun, action: "start", integrationId,
  });

  async function setStatus(status: string): Promise<void> {
    await admin.db.connection().execute(async (conn) => {
      await sql`
        update platform.api_key_integrations set status = ${status}
         where id = ${raceIntegration}::uuid
      `.execute(conn);
    });
  }

  test("a disable held open blocks the grant, which then refuses the status it committed", async () => {
    // The disable takes the integration's row lock and holds it. The grant
    // reaches `for share` on the same row and waits; when the disable commits
    // it re-reads and no longer matches `active`.
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const disable = admin.db.connection().execute(async (conn) => {
      await sql`begin`.execute(conn);
      await sql`
        update platform.api_key_integrations set status = 'disabled'
         where id = ${raceIntegration}::uuid
      `.execute(conn);
      locked.resolve();
      await release.promise;
      await sql`commit`.execute(conn);
    });
    await locked.promise;
    const grant = setAssignment(session(), { assignment: target(raceIntegration), assigned: true })
      .then(() => "granted" as const, () => "refused" as const);
    const beforeCommit = await Promise.race([grant, Bun.sleep(100).then(() => "waiting" as const)]);
    release.resolve();
    const [, outcome] = await Promise.all([disable, grant]);
    expect(beforeCommit).toBe("waiting");
    expect(outcome).toBe("refused");
    expect(await storedAcl(RUN, raceRun)).not.toHaveProperty("actions");
    expect(await allows(RUN, raceRun, "start", raceIntegration)).toBe(false);
  }, TEST_TIMEOUT);

  test("the other order leaves a hold its administrator can see and revoke", async () => {
    await setStatus("active");
    const change = await setAssignment(session(), {
      assignment: target(raceIntegration), assigned: true,
    });
    expect(change.changed).toBe(true);
    // Now disable it. The hold stays, which is the documented policy: a
    // disabled integration authenticates nothing, and a leftover grant has to
    // be FINDABLE before it can be removed.
    await setStatus("disabled");
    const page = await listRecordActionAssignments(app.db, session(), {
      integrationId: raceIntegration, entity: RUN, recordId: raceRun, first: 10,
    });
    expect(page.assignments.map((row) => row.action)).toEqual(["start"]);
    const removed = await setAssignment(session(), {
      assignment: target(raceIntegration), assigned: false,
    });
    expect(removed.changed).toBe(true);
    expect(await storedAcl(RUN, raceRun)).not.toHaveProperty("actions");
    // And it cannot be given back while it is disabled.
    expect(setAssignment(session(), { assignment: target(raceIntegration), assigned: true }))
      .rejects.toThrow(/active integration/);
  }, TEST_TIMEOUT);
});
