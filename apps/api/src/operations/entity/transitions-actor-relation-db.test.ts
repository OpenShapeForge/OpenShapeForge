// SPDX-License-Identifier: BUSL-1.1
/**
 * A transition's `actor: relation` stamp under a session that carries no
 * token claims. The session layer resolves the acting Relation for every
 * credential kind through the one identity ↔ Relation link, so a
 * trusted-context session linked through platform.identity_relations is
 * stamped like a bearer session would be; one without a link, or whose link
 * belongs to another tenant, is refused with FORBIDDEN. Scratch database
 * built from the manifest, the restricted app role, the real session
 * resolver on signed trusted-context headers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { resolveSessionContext } from "../../auth/identity.js";
import { __resetIdentityLinkForTests, sessionRelation } from "../../auth/identity-link.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { APP_ROLE, DEV_APP_ROLE_PASSWORD_DEFAULT } from "../../db/migrations/app-role.js";
import rawCatalog from "../../generated/operations/catalog.json" with { type: "json" };
import type { OperationContract } from "../runtime.js";
import { createGeneratedEntityForTable } from "./mutations.js";
import { executeTransition, transitionBinding, type TransitionBinding } from "./transitions.js";
import { getGeneratedCrudTables } from "./catalog.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const SECRET = "transitions-actor-relation-test-secret";
const scratchName = `actor_relation_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const ROLES = ["Agreements.All.Read", "Agreements.All.ReadWrite"];

let admin: SQL, privileged: DatabaseRuntime, restricted: DatabaseRuntime;
// The process is shared with every other file of the run: the signing secret
// this file installs is put back afterwards, or the suites after it would
// sign with one secret and be verified against another.
const previousSecret = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;

function scratchUrl(role?: { username: string; password: string }): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev" || url.pathname === "/hubble_dev") throw new Error("admin URL must not point at an application database");
  if (role) { url.username = role.username; url.password = role.password; }
  url.pathname = `/${scratchName}`;
  return url.toString();
}

/** The session the API builds for signed trusted-context headers, with the database in hand. */
async function trustedSession(tenantId: string, userId: string) {
  const headers = new Headers();
  applyTrustedContextHeaders(headers, { tenantId, userId, roles: ROLES }, { secret: SECRET });
  return resolveSessionContext(headers, { db: restricted.db });
}

const milestoneTable = getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === "AgreementMilestone")!;
const trigger = (rawCatalog as { operations: OperationContract[] }).operations.find((candidate) => candidate.key === "AgreementMilestone.trigger")!;

/** The trigger rule with its actor stamp landing the linked Relation, as a Relation reference field would. */
function relationStampedBinding(): TransitionBinding {
  const base = transitionBinding(trigger);
  return {
    ...base,
    rule: {
      ...base.rule,
      stamps: (base.rule.stamps ?? []).map((stamp) => (stamp.value === "actor" ? { ...stamp, actor: "relation" as const } : stamp)),
    },
  };
}

async function tenant(): Promise<string> {
  const id = randomUUID();
  await sql`insert into platform.tenants (id, slug, name, status) values (${id}::uuid, ${`actor-${id.slice(0, 8)}`}, 'Actor tenant', 'active')`.execute(privileged.db);
  return id;
}

async function relation(tenantId: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into erp.relations (id, tenant_id, display_name, relation_type) values (${id}::uuid, ${tenantId}::uuid, 'Reviewer', 'person')`.execute(privileged.db);
  return id;
}

/** An identity whose subject is the user id, linked to a Relation in `tenantId`. */
async function linkedUser(tenantId: string, relationId: string): Promise<string> {
  const userId = randomUUID();
  const identity = randomUUID();
  await sql`insert into platform.identities (id, issuer, subject, display_name) values (${identity}::uuid, 'https://issuer.test/realms/test', ${userId}, 'Linked person')`.execute(privileged.db);
  await sql`insert into platform.identity_relations (identity_id, tenant_id, relation_id, status, linked_at, linked_by) values (${identity}::uuid, ${tenantId}::uuid, ${relationId}::uuid, 'linked', now(), 'test')`.execute(privileged.db);
  return userId;
}

/** A milestone on an agreement of the session's tenant: the trigger rule's precondition reads the agreement's code. */
async function milestone(session: Awaited<ReturnType<typeof trustedSession>>): Promise<string> {
  const agreementId = randomUUID();
  await sql`insert into erp.agreements (id, tenant_id, code, agreement_type) values (${agreementId}::uuid, ${session.tenantId}::uuid, ${`AGR-${agreementId.slice(0, 8)}`}, 'service')`.execute(privileged.db);
  const row = await createGeneratedEntityForTable(restricted.db, session, milestoneTable, { agreementId, description: "Go-live", amount: 100 });
  return String(row.id);
}

const fails = (promise: unknown, code: string) => expect(Promise.resolve(promise)).rejects.toMatchObject({ operationError: { code } });

describe("actor: relation stamps under a trusted-context session", () => {
  beforeAll(async () => {
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = SECRET;
    admin = new SQL(ADMIN_URL, { max: 1 });
    await admin.unsafe(`create database "${scratchName}"`);
    privileged = createDatabaseRuntime({ databaseUrl: scratchUrl(), maxConnections: 2 });
    await privileged.db.connection().execute((conn) => runMigrationChain(conn));
    restricted = createDatabaseRuntime({
      databaseUrl: scratchUrl({ username: APP_ROLE, password: process.env.OPENSHAPEFORGE_APP_PASSWORD ?? DEV_APP_ROLE_PASSWORD_DEFAULT }),
      maxConnections: 4,
    });
  }, 120_000);

  afterAll(async () => {
    if (previousSecret === undefined) delete process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
    else process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = previousSecret;
    __resetIdentityLinkForTests();
    await restricted?.close();
    await privileged?.close();
    await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
    await admin?.close();
  });

  test("a session linked through identity_relations acts as its Relation: the stamp lands the Relation id", async () => {
    const tenantId = await tenant();
    const relationId = await relation(tenantId);
    const userId = await linkedUser(tenantId, relationId);
    const session = await trustedSession(tenantId, userId);
    expect(session.credential).toBe("trusted-context");
    expect(sessionRelation(session)).toEqual({ relationId, displayName: "Reviewer" });

    const id = await milestone(session);
    const result = await executeTransition(restricted.db, session, relationStampedBinding(), { id });
    expect(result).toMatchObject({ status: "triggered", triggeredBy: relationId });
    const stored = (await sql<{ triggered_by: string }>`select triggered_by from erp.agreement_milestones where id = ${id}::uuid`.execute(privileged.db)).rows[0]!;
    expect(stored.triggered_by).toBe(relationId);
  }, 60_000);

  test("a session with no link is refused with FORBIDDEN, and the record stays", async () => {
    const tenantId = await tenant();
    const session = await trustedSession(tenantId, randomUUID());
    expect(sessionRelation(session)).toBeNull();
    const id = await milestone(session);
    await fails(executeTransition(restricted.db, session, relationStampedBinding(), { id }), "FORBIDDEN");
    expect((await sql<{ status: string }>`select status from erp.agreement_milestones where id = ${id}::uuid`.execute(privileged.db)).rows[0]!.status).toBe("pending");
  }, 60_000);

  test("a link in another tenant is invisible here: FORBIDDEN, never the other tenant's Relation", async () => {
    const home = await tenant();
    const elsewhere = await tenant();
    const userId = await linkedUser(elsewhere, await relation(elsewhere));
    const session = await trustedSession(home, userId);
    expect(sessionRelation(session)).toBeNull();
    const id = await milestone(session);
    await fails(executeTransition(restricted.db, session, relationStampedBinding(), { id }), "FORBIDDEN");
    // The same person's session in the tenant that holds the link acts as that Relation.
    expect(sessionRelation(await trustedSession(elsewhere, userId))?.relationId).toBeString();
  }, 60_000);
});
