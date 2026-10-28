// SPDX-License-Identifier: BUSL-1.1
/**
 * ONE chain, end to end: a credential this realm issued, the resolver that
 * reads it, and the record action it authorizes.
 *
 * Everything the credential fence rests on is proven elsewhere against a
 * scratch database with sessions shaped like the resolver's output
 * (`db/__tests__/record-action-credential-fence-db.test.ts`), and a real
 * Keycloak credential is proven to authenticate and to be fenced on its own
 * row in `./application-record-action.e2e.test.ts`. Those two are ADJACENT:
 * one has the real dispatcher with a session a test wrote, the other has a
 * real session and a direct SQL call. Neither shows the join, and the join is
 * where a mistake would live.
 *
 * So this file runs exactly one path and nothing else:
 *
 *   the real provisioning service mints an `osf_live_…` credential against a
 *   real realm client
 *     → the real session resolver (`auth/identity.ts`, the function every
 *       transport calls) reads the presented credential: indexed lookup,
 *       constant-time secret compare, a real client_credentials exchange, a
 *       real JWKS verification, the tenant cross-check, the identity link
 *     → the session it returns is passed UNALTERED to the canonical
 *       `invokeOperation` for `Notebook.deliver`
 *       → whose `auth.recordAction` check asks the credential fence and the
 *         record ACL in one transaction, and whose shipped plugin handler
 *         writes the delivery row.
 *
 * Then the questions that only this join can answer:
 *
 *   1. the resolved session carries the credential ROW the store resolved, and
 *      a record whose ACL names the integration that session reports is
 *      delivered — real handler, real effect, committed;
 *   2. revoking THAT credential through the real management service refuses
 *      the next action from the SAME session object, while a second credential
 *      of the same integration still acts: the refusal is the credential and
 *      not the record;
 *   3. a request with no credential, and one with a well-formed credential no
 *      row backs, resolve to no session and reach the action not at all;
 *   4. a real credential of ANOTHER tenant reaches neither this tenant's
 *      granted record nor its own tenant's copy of the grant;
 *   5. expiry is read AT THE GATE. A credential that expires while the effect
 *      runs does not retract an admission already given — the invocation
 *      commits — while every later check, including one inside the same
 *      transaction, refuses. That is the documented semantics, not continuous
 *      validity at commit.
 *
 * WHAT THIS FILE DOES NOT CLAIM
 * -----------------------------
 * Not a transport proof. In this build an entity-authored plugin Operation has
 * no REST/GraphQL/MCP route (neither does the pre-existing `notebook.import`),
 * so there is no HTTP route to drive `Notebook.deliver` from; the resolver is
 * therefore called with the request headers it would be called with, and its
 * output is handed to the dispatcher directly. Not a browser proof and not a
 * workflow proof: `Notebook.deliver` is the repository's own non-workflow use
 * of the named-action axis.
 *
 * NOTHING HERE SKIPS
 * ------------------
 * A missing realm or database is a FAILURE of this file, not a quiet pass:
 * `beforeAll` throws with what is missing, and the first test re-asserts the
 * facts the rest depend on. There is no `skipIf` in this file on purpose — a
 * credential fence that silently proved nothing is the failure mode that got
 * us here.
 *
 * Run (repo root), against an ISOLATED Keycloak holding this tree's generated
 * realm and an isolated Postgres cluster carrying the roles from
 * `bun run db:provision-roles` — never a shared realm or a shared database:
 *   E2E_KEYCLOAK_URL=http://127.0.0.1:8194 \
 *   SCRATCH_ADMIN_DATABASE_URL=postgres://openshapeforge:openshapeforge@127.0.0.1:55194/postgres \
 *     bun test apps/api/src/auth/api-key/__tests__/record-action-credential-chain.e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { operationErrorOf } from "@openshapeforge/operations";
import type { ModuleOperationHandler, RuntimeModule } from "../../../modules/contract.js";
import type { TrustedSessionContext } from "../../trusted-context.js";

const KEYCLOAK_URL = process.env.E2E_KEYCLOAK_URL ?? "http://localhost:8181";
const REALM = process.env.E2E_KEYCLOAK_REALM ?? "openshapeforge";
const REALM_URL = `${KEYCLOAK_URL}/realms/${REALM}`;
const ADMIN_CLIENT = "openshapeforge-apikey-provisioner";
const ADMIN_SECRET = process.env.E2E_KEYCLOAK_ADMIN_SECRET ??
  "openshapeforge-apikey-provisioner-secret";
const ROLE_CLIENT = process.env.OPENSHAPEFORGE_API_KEY_ROLE_CLIENT_ID ?? "erp-provider";
const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = process.env.SCRATCH_APP_ROLE_PASSWORD ?? "openshapeforge_app";

/**
 * Every hook and every test carries an explicit bound, and they are chosen so
 * that their SUM is under 90 seconds: this suite cannot run longer than that
 * even if every step takes its maximum, and it cannot hang. Nothing here waits
 * on a lock, so the only deliberate wait is the expiry window below; a check
 * that approaches its bound is a stack that cannot run the suite rather than a
 * slow assertion.
 *
 * 30 + 15 + 4×6 + 15 = 84 seconds.
 */
const SETUP_TIMEOUT = 30_000;
const TEARDOWN_TIMEOUT = 15_000;
const TEST_TIMEOUT = 6_000;
/**
 * The expiry window of the one short-lived credential, in milliseconds.
 *
 * Long enough that a real exchange and JWKS verification fit inside it before
 * the effect begins — they take tens of milliseconds against a warm realm —
 * and short enough that the effect can outlive it inside one invocation.
 */
const EXPIRY_WINDOW_MS = 5_000;
/**
 * That window plus a budget of its own: the one check that waits on purpose.
 * The slack is twice the window, because the window is a deadline this file
 * has to beat (mint, resolve, admit) while the slack only has to cover a
 * handful of round trips after it.
 */
const EXPIRY_TIMEOUT = EXPIRY_WINDOW_MS + 10_000;

/** The issuer as the realm MINTS it, read from its own discovery document. */
async function discoverIssuer(): Promise<string | null> {
  try {
    const response = await fetch(`${REALM_URL}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const issuer = ((await response.json()) as { issuer?: unknown }).issuer;
    return typeof issuer === "string" && issuer.length > 0 ? issuer : null;
  } catch (error) {
    console.warn("[record action credential chain] issuer discovery failed:", error);
    return null;
  }
}

const ISSUER = process.env.E2E_KEYCLOAK_ISSUER ?? (await discoverIssuer());

// Set BEFORE the app modules read them. The resolver caches the verifier and
// the keyring lazily and exposes a reset, so ordering only has to hold at
// first use.
process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = ISSUER ?? "";
process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI =
  `${REALM_URL}/protocol/openid-connect/certs`;
process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = ROLE_CLIENT;
process.env.OPENSHAPEFORGE_API_KEY_SECRET_KEYS =
  `chain:${randomBytes(32).toString("base64")}`;
process.env.OPENSHAPEFORGE_KEYCLOAK_BASE_URL = KEYCLOAK_URL;
process.env.OPENSHAPEFORGE_KEYCLOAK_REALM = REALM;
process.env.OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_ID = ADMIN_CLIENT;
process.env.OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_SECRET = ADMIN_SECRET;

const { API_KEY_MANAGE_ROLE } = await import("../ceiling.js");
const { mintApiKey } = await import("../format.js");
const { readApiKeyProvisioningConfig } = await import("../runtime-config.js");
const { createIntegration, issueKey, revokeKey } = await import("../service.js");
const { resolveSessionContext, __resetSessionResolverForTests } = await import("../../identity.js");
const { __resetExchangeCacheForTests } = await import("../exchange.js");
const { createDatabaseRuntime } = await import("../../../db/connection.js");
const { runMigrationChain } = await import("../../../db/migration-chain.js");
const { APP_ROLE } = await import("../../../db/migrations/app-role.js");
const { ModulePlatformRuntime } = await import("../../../modules/platform.js");
const { loadRuntimeModules } = await import("../../../modules/registry.js");
const { bindOperationHandlers, invokeOperation } = await import("../../../operations/runtime.js");
const { HttpError } = await import("../../../rest/http-error.js");

type DatabaseRuntime = Awaited<ReturnType<typeof createDatabaseRuntime>>;
type ProvisioningConfig = NonNullable<ReturnType<typeof readApiKeyProvisioningConfig>>;

/** The entity read role the integrations hold. No role authorizes the action. */
const READ_ROLE = "General.All.Read";

const scratch = `ra_credential_chain_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
/** The customer this chain belongs to, and another one for the boundary. */
const tenant = randomUUID();
const otherTenant = randomUUID();
/** The human who provisions and revokes. An API key may do neither. */
const manager = randomUUID();

let server: SQL;
let admin: DatabaseRuntime;
let app: DatabaseRuntime;
let provisioning: ProvisioningConfig;
let loadedModules: readonly RuntimeModule[];

/**
 * One integration, two credentials, as a rotation leaves it. The second is
 * what makes a refusal attributable: if the first is refused after its revoke
 * and the second still acts, the record's grant is not what changed.
 */
let integrationId = "";
let primaryKey = "";
let primaryKeyId = "";
let secondaryKey = "";
/** The other tenant's own application and credential, fully provisioned. */
let otherIntegrationId = "";
let otherTenantKey = "";

/** Sessions the real resolver produced, reused exactly as returned. */
let primarySession: TrustedSessionContext;
let secondarySession: TrustedSessionContext;
let otherTenantSession: TrustedSessionContext;

/** Notebooks: this tenant's granted record, an ungranted one, and two abroad. */
const granted = randomUUID();
const ungranted = randomUUID();
/** In the other tenant, granting THIS tenant's integration. */
const foreignGrantingHere = randomUUID();
/** In the other tenant, granting the other tenant's own integration. */
const foreignGrantingThere = randomUUID();
/** This tenant's record, for the expiring credential. */
const expiring = randomUUID();

function url(name: string, asApp = false): string {
  const parsed = new URL(ADMIN_URL);
  parsed.pathname = `/${name}`;
  if (asApp) {
    parsed.username = APP_ROLE;
    parsed.password = APP_ROLE_PASSWORD;
  }
  return parsed.toString();
}

/** The management carrier the provisioning service requires: a human. */
function management(tenantId = tenant) {
  return {
    tenantId,
    userId: manager,
    roles: [API_KEY_MANAGE_ROLE, READ_ROLE],
    groups: [] as string[],
    credential: "bearer" as const,
  };
}

/**
 * What the provisioning service is handed in a deployment — including the
 * RESTRICTED runtime connection. Minting and revoking a credential are
 * ordinary authenticated requests, so they run under the same role and the
 * same tenant policies as the actions they govern.
 */
function serviceDeps() {
  return { db: app.db, ...provisioning };
}

/** The request a holder makes: one header, the credential, nothing else. */
function presenting(credential: string): Headers {
  return new Headers({ authorization: `Bearer ${credential}` });
}

/**
 * The session the deployment's own resolver makes of a presented credential.
 *
 * `resolveSessionContext` is the function every transport calls: the API-key
 * branch with its lookup, exchange and JWKS verification, the identity link,
 * the member-access check and the organization address check. Its result is
 * what the rest of this file passes on — never a session this test assembled.
 */
function resolve(headers: Headers): Promise<TrustedSessionContext> {
  return resolveSessionContext(headers, { db: app.db });
}

function acl(actions: Record<string, unknown>): string {
  return JSON.stringify({ actions });
}

function code(error: unknown): string | undefined {
  return operationErrorOf(error)?.code ??
    (error instanceof HttpError ? error.code : undefined);
}

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return code(error);
  }
  return undefined;
}

type Delivery = { status: string; deliveryId: string; notebookName: string };

/**
 * `Notebook.deliver` through the canonical dispatcher, on the session the
 * resolver returned.
 *
 * `handler` replaces the shipped `deliverToNotebook` — the one piece of PLUGIN
 * code in the chain — so a test can stand inside the Operation's own
 * transaction after the fence and the ACL lookup have passed. The dispatcher,
 * the policy, the fence and the database stay the shipped ones; a module is
 * not core, and substituting one is how this file reaches the inside of an
 * invocation without weakening anything it is proving.
 */
async function deliver(
  session: TrustedSessionContext,
  notebookId: string,
  handler?: ModuleOperationHandler,
): Promise<Delivery> {
  const modules = handler
    ? loadedModules.map((module) => module.name === "notebook"
      ? { ...module, operationHandlers: { ...module.operationHandlers, deliverToNotebook: handler } }
      : module)
    : loadedModules;
  const bound = bindOperationHandlers(modules).get("Notebook.deliver");
  if (!bound) throw new Error("Notebook.deliver has no bound runtime handler.");
  const host = new ModulePlatformRuntime(app.db);
  const result = await invokeOperation(bound, {
    notebookId,
    reference: `ref-${randomUUID()}`,
  }, {
    transport: "operation",
    session,
    platform: host.services,
    db: app.db,
  });
  return (result as { value: Delivery }).value;
}

/** The delivery rows an integration has recorded for a notebook, committed. */
async function committedDeliveries(
  tenantId: string,
  notebookId: string,
): Promise<{ reference: string; integration_id: string }[]> {
  return (await sql<{ reference: string; integration_id: string }>`
    select reference, integration_id from notebook.notebook_deliveries
     where tenant_id = ${tenantId}::uuid and notebook_id = ${notebookId}::uuid
     order by created_at
  `.execute(admin.db)).rows;
}

beforeAll(async () => {
  // Readiness is a precondition, never a reason to pass quietly.
  const missing: string[] = [];
  if (!ISSUER) missing.push(`a reachable realm at ${REALM_URL}`);
  const configured = readApiKeyProvisioningConfig();
  if (!configured) missing.push("API key provisioning configuration");
  if (!/^[a-z0-9_]+$/.test(scratch)) missing.push("a safe scratch database name");
  if (missing.length > 0) {
    throw new Error(
      `This suite proves a real credential chain and cannot be approximated. Missing: ${
        missing.join(", ")
      }. See the header for how to run it.`,
    );
  }
  provisioning = configured!;
  __resetSessionResolverForTests();
  __resetExchangeCacheForTests();

  // An isolated database of this suite's own: created, migrated and dropped
  // here, so nothing it writes can reach another task's runtime.
  server = new SQL(ADMIN_URL, { max: 1 });
  await server.unsafe(`create database "${scratch}"`);
  admin = createDatabaseRuntime({ databaseUrl: url(scratch), maxConnections: 4 });
  await admin.db.connection().execute((conn) => runMigrationChain(conn));
  // The restricted runtime role. Every session below — provisioning included
  // — runs as the role a deployment serves with, not as the owner that
  // migrated.
  app = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 6 });

  const modules = await loadRuntimeModules();
  expect(modules.failures).toEqual([]);
  loadedModules = modules.loaded;

  // Both customers as rows: the dispatcher's keyed receipt and the identity
  // link the resolver records for a service account are tenant-scoped by
  // foreign key.
  await sql`
    insert into platform.tenants (id, slug, name, status) values
      (${tenant}::uuid, ${`chain-${tenant.slice(0, 8)}`}, 'Credential chain tenant', 'active'),
      (${otherTenant}::uuid, ${`chain-other-${otherTenant.slice(0, 8)}`},
        'Credential chain other tenant', 'active')
  `.execute(admin.db);

  // The real provisioning service, against the real realm: a realm client, a
  // service account carrying the tenant, the entity read role, and one
  // `osf_live_…` credential returned once.
  const created = await createIntegration(serviceDeps(), management(), {
    displayName: `credential chain ${randomUUID().slice(0, 8)}`,
    roles: [READ_ROLE],
  });
  integrationId = created.integrationId;
  primaryKey = created.token;
  primaryKeyId = created.keyId;
  // Asserted as a boolean, never as the value: a failing `toStartWith` would
  // print the credential itself into the run's output.
  expect(primaryKey.startsWith("osf_live_")).toBe(true);

  // Rotation: a second credential of the same realm client and the same grant.
  secondaryKey = (await issueKey(serviceDeps(), management(), {
    integrationId,
    displayName: "rotated in",
  })).token;

  // The other customer's own application, provisioned the same way.
  const abroad = await createIntegration(serviceDeps(), management(otherTenant), {
    displayName: `credential chain abroad ${randomUUID().slice(0, 8)}`,
    roles: [READ_ROLE],
  });
  otherIntegrationId = abroad.integrationId;
  otherTenantKey = abroad.token;

  await sql`
    insert into notebook.notebooks (id, tenant_id, name, body, permissions) values
      (${granted}::uuid, ${tenant}::uuid, 'Granted notes', 'confidential body',
        ${sql.raw(`'${acl({ deliver: { integrations: [integrationId] } })}'::jsonb`)}),
      (${expiring}::uuid, ${tenant}::uuid, 'Expiring notes', 'confidential body',
        ${sql.raw(`'${acl({ deliver: { integrations: [integrationId] } })}'::jsonb`)}),
      (${ungranted}::uuid, ${tenant}::uuid, 'Ungranted notes', 'confidential body',
        ${sql.raw("'{}'::jsonb")}),
      (${foreignGrantingHere}::uuid, ${otherTenant}::uuid, 'Abroad, granting here',
        'confidential body',
        ${sql.raw(`'${acl({ deliver: { integrations: [integrationId] } })}'::jsonb`)}),
      (${foreignGrantingThere}::uuid, ${otherTenant}::uuid, 'Abroad, granting abroad',
        'confidential body',
        ${sql.raw(`'${acl({ deliver: { integrations: [otherIntegrationId] } })}'::jsonb`)})
  `.execute(admin.db);

  primarySession = await resolve(presenting(primaryKey));
  secondarySession = await resolve(presenting(secondaryKey));
  otherTenantSession = await resolve(presenting(otherTenantKey));
}, SETUP_TIMEOUT);

afterAll(async () => {
  for (const id of [integrationId, otherIntegrationId]) {
    if (!id) continue;
    try {
      await provisioning?.admin.deleteClient(`osf-int-${id}`);
    } catch {
      // Best effort: the realm is this task's own and disposable.
    }
  }
  await app?.close();
  await admin?.close();
  await server?.unsafe(`drop database if exists "${scratch}" with (force)`);
  await server?.close();
}, TEARDOWN_TIMEOUT);

describe("a credential this realm issued, resolved and dispatched", () => {
  test("the stack under test is the real one, and nothing here was skipped", async () => {
    // The facts every assertion below reads as policy. A suite that cannot
    // establish them must fail rather than report a pass.
    expect(ISSUER).toBeTruthy();
    const discovered = await discoverIssuer();
    expect(discovered).toBe(ISSUER!);
    const role = (await sql<{ superuser: boolean; bypass: boolean; name: string }>`
      select rolsuper as superuser, rolbypassrls as bypass, current_user as name
        from pg_roles where rolname = current_user
    `.execute(app.db)).rows[0]!;
    expect(role.name).toBe(APP_ROLE);
    expect(role.superuser).toBe(false);
    expect(role.bypass).toBe(false);
    // The fence exists in this database and is the invoker function the app
    // role executes. Its privileges are proven in the fence suite; what
    // matters here is that the chain below runs against a database that has
    // it, so a pass cannot mean "no fence was installed".
    const fence = (await sql<{ definer: boolean }>`
      select prosecdef as definer from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'record_action_principal_live'
    `.execute(admin.db)).rows;
    expect(fence).toEqual([{ definer: false }]);
  }, TEST_TIMEOUT);

  test("the resolver returns the credential row it read, and that session delivers", async () => {
    // What the resolver made of the presented credential. Not asserted to be
    // what this test wanted — asserted to be the rows the service wrote.
    expect(primarySession.credential).toBe("api-key");
    expect(primarySession.principalKind).toBe("service");
    expect(primarySession.tenantId).toBe(tenant);
    expect(primarySession.appPrincipal).toEqual({
      integrationId,
      credentialId: primaryKeyId,
    });
    const stored = (await sql<{ id: string; integration_id: string; revoked_at: Date | null }>`
      select id, integration_id, revoked_at from platform.api_keys
       where id = ${primarySession.appPrincipal!.credentialId}::uuid
    `.execute(admin.db)).rows;
    expect(stored).toEqual([{
      id: primaryKeyId, integration_id: integrationId, revoked_at: null,
    }]);

    // The ACL names the integration the RESOLVED session reports, so the
    // grant is keyed on the resolver's own answer rather than on a value
    // this file chose and hoped matched.
    const recordAcl = (await sql<{ integrations: string[] }>`
      select array(
        select jsonb_array_elements_text(
          permissions -> 'actions' -> 'deliver' -> 'integrations')
      ) as integrations
        from notebook.notebooks where id = ${granted}::uuid
    `.execute(admin.db)).rows[0]!;
    expect(recordAcl.integrations).toEqual([primarySession.appPrincipal!.integrationId]);

    // The whole point: the session the resolver returned, unaltered, through
    // the canonical dispatcher, into the shipped plugin handler.
    const delivered = await deliver(primarySession, granted);
    expect(delivered.status).toBe("accepted");
    expect(delivered.notebookName).toBe("Granted notes");
    const committed = await committedDeliveries(tenant, granted);
    expect(committed).toHaveLength(1);
    expect(committed[0]!.integration_id).toBe(integrationId);

    // And the same session reaches no record that does not name it.
    expect(await refusal(deliver(primarySession, ungranted))).toBe("FORBIDDEN");
  }, TEST_TIMEOUT);

  test("revoking that credential refuses the next action and leaves the grant", async () => {
    // The rotated-in credential acts too, so both are live before the revoke.
    expect((await deliver(secondarySession, granted)).status).toBe("accepted");

    await revokeKey(serviceDeps(), management(), primaryKeyId);

    // SAME session object, not re-resolved: a holder with an Operation queue
    // does not re-authenticate between calls, and the withdrawal has to
    // reach the action rather than only the door.
    expect(await refusal(deliver(primarySession, granted))).toBe("FORBIDDEN");
    // The record's grant never mentioned a credential, and still does not:
    // the other half of the rotation goes on delivering.
    expect((await deliver(secondarySession, granted)).status).toBe("accepted");
    // The door is closed as well: the revoked credential resolves to nothing.
    const afterRevoke = await resolve(presenting(primaryKey));
    expect(afterRevoke.credential).toBe("none");
    expect(afterRevoke.tenantId).toBeNull();
    expect(afterRevoke.appPrincipal ?? null).toBeNull();
    // Three accepted deliveries, none of them the refused one.
    expect(await committedDeliveries(tenant, granted)).toHaveLength(3);
  }, TEST_TIMEOUT);

  test("no credential, and a well-formed credential no row backs, reach nothing", async () => {
    // A request that presents nothing at all. Outside host mode an absent
    // Authorization header leaves the trusted-context branch, which names
    // nobody and — by its own contract — can never name an application
    // principal however it is signed.
    const anonymous = await resolve(new Headers());
    expect(anonymous.tenantId).toBeNull();
    expect(anonymous.userId).toBeNull();
    expect(anonymous.appPrincipal ?? null).toBeNull();
    expect(await refusal(deliver(anonymous, granted))).toBeDefined();

    // A credential of the right SHAPE — minted by the same function the
    // service mints with, so it parses and checksums — that no row backs.
    // This is the resolver's unknown-key path, not its parser.
    const unbacked = mintApiKey();
    expect(unbacked.token.startsWith("osf_live_")).toBe(true);
    const unknown = await resolve(presenting(unbacked.token));
    expect(unknown.credential).toBe("none");
    expect(unknown.appPrincipal ?? null).toBeNull();
    expect(await refusal(deliver(unknown, granted))).toBeDefined();

    // Nothing was delivered by either.
    expect(await committedDeliveries(tenant, granted)).toHaveLength(3);
  }, TEST_TIMEOUT);

  test("another tenant's real credential reaches neither tenant's record", async () => {
    expect(otherTenantSession.credential).toBe("api-key");
    expect(otherTenantSession.tenantId).toBe(otherTenant);
    expect(otherTenantSession.appPrincipal?.integrationId).toBe(otherIntegrationId);

    // This tenant's granted record, from abroad: the ACL names an integration
    // of another tenant, and the tenant fence answers before the grant does.
    expect(await refusal(deliver(otherTenantSession, granted))).toBe("FORBIDDEN");
    // And the reverse: a record abroad that names THIS tenant's integration
    // is not reachable by this tenant's live credential either.
    expect(await refusal(deliver(secondarySession, foreignGrantingHere))).toBe("FORBIDDEN");
    // The control: abroad, naming its own integration, the same credential
    // that was just refused twice does act. So the refusals are the boundary
    // and not a broken credential.
    expect((await deliver(otherTenantSession, foreignGrantingThere)).status).toBe("accepted");
    expect(await committedDeliveries(tenant, granted)).toHaveLength(3);
    expect(await committedDeliveries(otherTenant, foreignGrantingHere)).toEqual([]);
  }, TEST_TIMEOUT);

  /**
   * The semantics Grok's review asked to be stated rather than assumed.
   *
   * The fence reads `clock_timestamp()` WHEN IT IS ASKED. It is asked at the
   * transaction gate of an action and again by the bounded read, and each
   * answer is a point-in-time one. It is NOT a claim about the moment of
   * commit: an invocation admitted while the credential was live commits even
   * if the credential expires while its effect runs. Revocation is the case
   * that cannot interleave, because a revoke is an UPDATE that the fence's
   * `for share` lock serializes against; expiry is the passage of time, which
   * no lock can hold back.
   */
  test("expiry is read at the gate, and an admitted action still finishes", async () => {
    // A real credential of the same real realm client, with a real expiry a
    // few seconds out. `expiresInDays` is the service's own parameter and the
    // service's own arithmetic; a fraction of a day is the only way to ask
    // for a window a test can outlive.
    const shortLived = await issueKey(serviceDeps(), management(), {
      integrationId,
      displayName: "expiring",
      expiresInDays: EXPIRY_WINDOW_MS / 86_400_000,
    });
    const expiresAt = shortLived.expiresAt!;
    expect(expiresAt).toBeInstanceOf(Date);

    // Resolved while live, through the same real exchange and verification.
    const session = await resolve(presenting(shortLived.token));
    expect(session.appPrincipal?.credentialId).toBe(shortLived.keyId);
    expect(Date.now()).toBeLessThan(expiresAt.getTime());

    // One invocation that is admitted before the expiry and still running
    // after it. The probe reads the record while the credential is live, then
    // waits out the window inside the Operation's transaction, then re-asks —
    // and writes its effect regardless, because the admission it was given is
    // not withdrawn by the clock.
    let reReadAfterExpiry: string | undefined;
    let readBeforeExpiry: unknown;
    const reference = `expiry-${randomUUID()}`;
    const delivered = await deliver(session, expiring, async (_input, context) => {
      const platform = context.platform!;
      const live = context.session!;
      const record = { entityName: "Notebook", id: expiring, action: "deliver" } as const;
      readBeforeExpiry = await platform.records.readForAction(live, record);
      while (Date.now() <= expiresAt.getTime() + 500) {
        await new Promise((done) => setTimeout(done, 50));
      }
      reReadAfterExpiry = await refusal(platform.records.readForAction(live, record));
      return platform.db.withSession(live, async (trx) => {
        const row = (await sql<{ id: string }>`
          insert into notebook.notebook_deliveries
            (tenant_id, notebook_id, integration_id, reference, notebook_name)
          values (${live.tenantId}::uuid, ${expiring}::uuid,
            ${live.appPrincipal!.integrationId}::uuid, ${reference}, 'Expiring notes')
          returning id
        `.execute(trx)).rows[0]!;
        return {
          value: {
            status: "accepted" as const,
            deliveryId: row.id,
            notebookName: "Expiring notes",
            priorDeliveries: 0,
          },
        };
      });
    });

    // Admitted: the bounded read answered before the expiry.
    expect(readBeforeExpiry).toEqual({ name: "Expiring notes" });
    // Point in time, not continuous: the SAME transaction's later ask is
    // refused, because the fence re-read the row against the wall clock.
    expect(reReadAfterExpiry).toBe("FORBIDDEN");
    // And the invocation it had already admitted committed anyway — after
    // the credential expired. This is the documented semantics.
    expect(delivered.status).toBe("accepted");
    expect(Date.now()).toBeGreaterThan(expiresAt.getTime());
    expect((await committedDeliveries(tenant, expiring)).map((row) => row.reference))
      .toEqual([reference]);

    // Every later gate refuses, so the admission was for that invocation and
    // nothing more — and the door is closed too.
    expect(await refusal(deliver(session, expiring))).toBe("FORBIDDEN");
    expect((await resolve(presenting(shortLived.token))).credential).toBe("none");
    expect(await committedDeliveries(tenant, expiring)).toHaveLength(1);
  }, EXPIRY_TIMEOUT);
});
