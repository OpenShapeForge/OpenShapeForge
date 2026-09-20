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
import { resolveApiKeySession } from "../../auth/api-key/resolve.js";
import { mintApiKey } from "../../auth/api-key/format.js";
import { resolveSessionContext, withSessionRelation } from "../../auth/identity.js";
import { __resetIdentityLinkForTests, invalidateIdentityLink, sessionRelation, toState } from "../../auth/identity-link.js";
import { linkCacheKey, linkGeneration, recordLinkWrite } from "../../auth/identity-link-session.js";
import { readLinkRowByIdentity } from "../../auth/identity-link-store.js";
import { withDbSession } from "../../db/session.js";
import { createGraphqlContext } from "../../graphql/context.js";
import { encryptSecret, type SecretKeyring } from "../../platform/secrets.js";
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
/** The realm this deployment trusts: what a trusted-context session's identity is issued by. */
const ISSUER = "https://issuer.test/realms/test";
const OTHER_ISSUER = "https://other.test/realms/other";
const scratchName = `actor_relation_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const ROLES = ["Agreements.All.Read", "Agreements.All.ReadWrite"];

let admin: SQL, privileged: DatabaseRuntime, restricted: DatabaseRuntime;
// The process is shared with every other file of the run: the signing secret
// this file installs is put back afterwards, or the suites after it would
// sign with one secret and be verified against another.
const previousSecret = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
const previousIssuer = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;

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

/** An identity of `issuer` whose subject is the user id, linked to a Relation in `tenantId`. */
async function linkedUser(tenantId: string, relationId: string, issuer = ISSUER, userId = randomUUID()): Promise<string> {
  const identity = randomUUID();
  await sql`insert into platform.identities (id, issuer, subject, display_name) values (${identity}::uuid, ${issuer}, ${userId}, 'Linked person')`.execute(privileged.db);
  await sql`insert into platform.identity_relations (identity_id, tenant_id, relation_id, status, linked_at, linked_by) values (${identity}::uuid, ${tenantId}::uuid, ${relationId}::uuid, 'linked', now(), 'test')`.execute(privileged.db);
  return userId;
}

/** What an administrator's link_identity leaves behind for an existing (pending) identity row. */
async function linkExisting(issuer: string, subject: string, tenantId: string, relationId: string): Promise<void> {
  await sql`update platform.identity_relations ir set relation_id = ${relationId}::uuid, status = 'linked', linked_at = now(), linked_by = 'admin'
    from platform.identities i where i.id = ir.identity_id and i.issuer = ${issuer} and i.subject = ${subject} and ir.tenant_id = ${tenantId}::uuid`.execute(privileged.db);
  invalidateIdentityLink(issuer, subject, tenantId);
}

const keyring: SecretKeyring = { activeKeyId: "k1", keys: new Map([["k1", Buffer.alloc(32, 7)]]) };

/**
 * An active integration with one key, as provisioning leaves it, and the
 * API-key resolver with the realm stubbed: the token exchange answers a
 * token, the verifier answers the service account (its subject is the
 * Keycloak user id) with the integration's roles. What is real is the
 * database: the key rows, the identity rows and the link.
 */
async function apiKeySession(tenantId: string, serviceAccountUserId: string) {
  const integrationId = randomUUID();
  const minted = mintApiKey();
  const secret = encryptSecret(keyring, integrationId, "clientSecret", "client-secret");
  await sql`insert into platform.api_key_integrations
      (id, tenant_id, display_name, keycloak_client_id, status, granted_roles, client_secret_ciphertext, client_secret_key_id, client_secret_algorithm, created_by)
    values (${integrationId}::uuid, ${tenantId}::uuid, 'Billing robot', ${`osf-int-${integrationId}`}, 'active', cast(${ROLES} as jsonb),
      ${secret.ciphertext}, ${secret.keyId}, ${secret.algorithm}, ${randomUUID()}::uuid)`.execute(privileged.db);
  await sql`insert into platform.api_keys (id, tenant_id, integration_id, lookup_id, secret_hash, display_name, created_by)
    values (${randomUUID()}::uuid, ${tenantId}::uuid, ${integrationId}::uuid, ${minted.lookupId}, ${minted.secretHash}, 'key', ${randomUUID()}::uuid)`.execute(privileged.db);
  const session = await resolveApiKeySession({
    db: restricted.db,
    keyring,
    issuer: ISSUER,
    verifyToken: async () => ({ tenantId, userId: serviceAccountUserId, roles: ROLES, groups: [] }),
    resolveScope: () => "tenant",
    fetch: (async () => new Response(JSON.stringify({ access_token: `token-${integrationId}`, expires_in: 60 }), { status: 200 })) as unknown as typeof fetch,
  }, minted.token);
  if (!session) throw new Error("the API key did not resolve");
  return withSessionRelation(session, { db: restricted.db });
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
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = ISSUER;
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
    if (previousIssuer === undefined) delete process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;
    else process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = previousIssuer;
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

  test("a first web session records its identity and a pending link, is refused the stamp, and is linked from there", async () => {
    const tenantId = await tenant();
    const userId = randomUUID();
    const session = await trustedSession(tenantId, userId);
    expect(sessionRelation(session)).toBeNull();
    // Nothing else could have made these rows: no bearer login ran for this person.
    expect(session.relation).toMatchObject({ status: "pending_confirmation", relationId: null, issuer: ISSUER, subject: userId });
    const rows = (await sql<{ display_name: string | null; email: string | null }>`select i.display_name, i.email from platform.identities i
      join platform.identity_relations ir on ir.identity_id = i.id where i.issuer = ${ISSUER} and i.subject = ${userId} and ir.tenant_id = ${tenantId}::uuid`.execute(privileged.db)).rows;
    expect(rows).toEqual([{ display_name: null, email: null }]);
    const id = await milestone(session);
    await fails(executeTransition(restricted.db, session, relationStampedBinding(), { id }), "FORBIDDEN");
    expect((await sql<{ status: string }>`select status from erp.agreement_milestones where id = ${id}::uuid`.execute(privileged.db)).rows[0]!.status).toBe("pending");
    // An administrator links the recorded identity by its id; the next session acts as that Relation.
    const relationId = await relation(tenantId);
    await linkExisting(ISSUER, userId, tenantId, relationId);
    expect(sessionRelation(await trustedSession(tenantId, userId))).toEqual({ relationId, displayName: "Reviewer" });
  }, 60_000);

  test("a session that could be linked but names no realm is unavailable, not nobody", async () => {
    const tenantId = await tenant();
    delete process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;
    try {
      await expect(trustedSession(tenantId, randomUUID())).rejects.toMatchObject({ status: 503, code: "AUTHENTICATION_UNAVAILABLE" });
    } finally {
      process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = ISSUER;
    }
    // A tenant or user that is no uuid can hold no link and is not refused here.
    const headers = new Headers();
    applyTrustedContextHeaders(headers, { tenantId: "tenant-a", userId: "dev", roles: ROLES }, { secret: SECRET });
    delete process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;
    try {
      expect((await resolveSessionContext(headers, { db: restricted.db })).credential).toBe("trusted-context");
    } finally {
      process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = ISSUER;
    }
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

  test("identities are named by issuer and subject: the same subject under another issuer is another identity", async () => {
    const tenantId = await tenant();
    const subject = randomUUID();
    const ours = await relation(tenantId);
    const theirs = await relation(tenantId);
    await linkedUser(tenantId, theirs, OTHER_ISSUER, subject);
    // Only the other realm knows this subject: the session, issued by ours, is not linked —
    // it recorded its own identity under our issuer, which is a different row.
    expect(sessionRelation(await trustedSession(tenantId, subject))).toBeNull();
    await linkExisting(ISSUER, subject, tenantId, ours);
    expect(sessionRelation(await trustedSession(tenantId, subject))?.relationId).toBe(ours);
    const identities = (await sql<{ issuer: string }>`select issuer from platform.identities where subject = ${subject} order by issuer`.execute(privileged.db)).rows.map((row) => row.issuer);
    expect(identities).toEqual([ISSUER, OTHER_ISSUER].sort());
  }, 60_000);

  test("an API-key session records its service account's identity on first use and acts as the Relation an administrator links it to", async () => {
    const tenantId = await tenant();
    const serviceAccount = randomUUID();
    const first = await apiKeySession(tenantId, serviceAccount);
    expect(first).toMatchObject({ credential: "api-key", issuer: ISSUER, userId: serviceAccount, userDisplayName: "Billing robot" });
    // Not linked yet — but the identity and an empty pending link now exist for link_identity to find.
    expect(sessionRelation(first)).toBeNull();
    const rows = (await sql<{ display_name: string; status: string; relation_id: string | null }>`
      select i.display_name, ir.status, ir.relation_id::text as relation_id from platform.identities i
      join platform.identity_relations ir on ir.identity_id = i.id
      where i.issuer = ${ISSUER} and i.subject = ${serviceAccount} and ir.tenant_id = ${tenantId}::uuid`.execute(privileged.db)).rows;
    expect(rows).toEqual([{ display_name: "Billing robot", status: "pending_confirmation", relation_id: null }]);
    const id = await milestone(first);
    await fails(executeTransition(restricted.db, first, relationStampedBinding(), { id }), "FORBIDDEN");

    const relationId = await relation(tenantId);
    await linkExisting(ISSUER, serviceAccount, tenantId, relationId);
    const linked = await apiKeySession(tenantId, serviceAccount);
    expect(sessionRelation(linked)).toEqual({ relationId, displayName: "Reviewer" });
    const result = await executeTransition(restricted.db, linked, relationStampedBinding(), { id });
    expect(result).toMatchObject({ status: "triggered", triggeredBy: relationId });
  }, 60_000);

  test("the GraphQL context carries the session's Relation, so a transition run through GraphQL stamps it", async () => {
    const tenantId = await tenant();
    const relationId = await relation(tenantId);
    const userId = await linkedUser(tenantId, relationId);
    const headers = new Headers();
    applyTrustedContextHeaders(headers, { tenantId, userId, roles: ROLES }, { secret: SECRET });
    const context = await createGraphqlContext(headers, { db: restricted.db });
    expect(sessionRelation(context.session)).toEqual({ relationId, displayName: "Reviewer" });
    expect(context.session).toMatchObject({ credential: "trusted-context", issuer: ISSUER, scope: "self" });
    // The session a GraphQL resolver hands the transition runtime is this one.
    const id = await milestone(context.session as Awaited<ReturnType<typeof trustedSession>>);
    const result = await executeTransition(restricted.db, context.session, relationStampedBinding(), { id });
    expect(result).toMatchObject({ status: "triggered", triggeredBy: relationId });
  }, 60_000);

  test("one cache for both paths: a link the bearer path makes is seen by the next trusted-context read", async () => {
    const tenantId = await tenant();
    const userId = randomUUID();
    // The trusted-context read caches "pending, unlinked" for this key.
    expect(sessionRelation(await trustedSession(tenantId, userId))).toBeNull();
    const key = linkCacheKey(ISSUER, userId, tenantId);
    const before = linkGeneration(key);
    // The bearer path links (a write through resolveIdentityLink records it the same way): the generation moves on.
    const relationId = await relation(tenantId);
    await sql`update platform.identity_relations ir set relation_id = ${relationId}::uuid, status = 'linked', linked_at = now(), linked_by = 'bearer'
      from platform.identities i where i.id = ir.identity_id and i.issuer = ${ISSUER} and i.subject = ${userId} and ir.tenant_id = ${tenantId}::uuid`.execute(privileged.db);
    recordLinkWrite(key, (await withDbSession(restricted.db, { tenantId, userId, roles: ROLES, scope: "tenant" }, (trx) => readLinkRowByIdentity(trx, { issuer: ISSUER, subject: userId }, tenantId)).then((row) => row && toState(row, { issuer: ISSUER, subject: userId }))));
    expect(linkGeneration(key)).toBeGreaterThan(before);
    expect(sessionRelation(await trustedSession(tenantId, userId))?.relationId).toBe(relationId);
  }, 60_000);

  test("an invalidation during a read wins: the read's result is not stored over it", async () => {
    const tenantId = await tenant();
    const relationId = await relation(tenantId);
    const userId = await linkedUser(tenantId, relationId);
    // First read fills the cache; an invalidation then bumps the generation.
    expect(sessionRelation(await trustedSession(tenantId, userId))?.relationId).toBe(relationId);
    const other = await relation(tenantId);
    const inFlight = (async () => {
      // A read that began before the invalidation and finishes after it.
      const started = trustedSession(tenantId, userId);
      await linkExisting(ISSUER, userId, tenantId, other);
      return started;
    })();
    await inFlight;
    // Whatever the racing read saw, the next read reflects the link as it is now.
    expect(sessionRelation(await trustedSession(tenantId, userId))?.relationId).toBe(other);
  }, 60_000);
});
