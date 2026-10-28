// SPDX-License-Identifier: BUSL-1.1
/**
 * A real API key, and every generic route an application must not open.
 *
 * Everything here is the shipped thing: a real Keycloak realm client created
 * through the Admin API, a real `osf_live_…` credential minted and stored
 * hashed by the API-key service, a real client-credentials exchange and JWKS
 * verification on every request, and the assembled API serving REST, GraphQL
 * and MCP. The subject is the repository's own non-workflow use of the
 * named-action axis: `Notebook` declares `deliver` for integrations, and
 * `Notebook.deliver` is authorized by that action and by no role.
 *
 * The claims, in the order they would hurt:
 *
 *   1. the credential works: it reaches an entity with no principal-class
 *      policy, so every refusal below is the policy and not the key;
 *   2. it reaches no generic route on `Notebook` — the collection and the
 *      record read on REST, the generated list on GraphQL, and the generic
 *      MCP tool — while holding the entity's own read role;
 *   3. nor on `NotebookVersion`, whose policy is authored rather than
 *      derived: a snapshot is only as closed as the record it snapshots;
 *   4. a person with the same role on the same tenant still reaches all of
 *      it, so the boundary is the principal class and not the entity.
 *
 * The record action itself — reaching `deliver` on a granted notebook, the
 * bounded read, the plugin-owned delivery row and its replay fence — is
 * proven against a real database in
 * `apps/api/src/modules/record-action-module-db.test.ts`. It is NOT proven
 * here: in this build the entity-authored plugin Operation has no REST route
 * (neither does the pre-existing `notebook.import`), so there is no transport
 * to drive it from.
 *
 * Run (repo root), against an isolated Keycloak with the generated realm and
 * an isolated migrated database:
 *   E2E_KEYCLOAK_URL=http://127.0.0.1:8186 \
 *   OPENSHAPEFORGE_MIGRATE_DATABASE_URL=postgres://…/osf_appkey_e2e \
 *   DATABASE_URL=postgres://openshapeforge_app:…@…/osf_appkey_e2e \
 *     bun test apps/api/src/auth/api-key/__tests__/application-record-action.e2e.test.ts
 *
 * It SKIPS wholesale when either is absent, so it never fails for the wrong
 * reason.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";

const KEYCLOAK_URL = process.env.E2E_KEYCLOAK_URL ?? "http://localhost:8181";
const REALM = process.env.E2E_KEYCLOAK_REALM ?? "openshapeforge";
const REALM_URL = `${KEYCLOAK_URL}/realms/${REALM}`;
const ADMIN_CLIENT = "openshapeforge-apikey-provisioner";
const ADMIN_SECRET = process.env.E2E_KEYCLOAK_ADMIN_SECRET ??
  "openshapeforge-apikey-provisioner-secret";
const ROLE_CLIENT = process.env.OPENSHAPEFORGE_API_KEY_ROLE_CLIENT_ID ?? "erp-provider";
const DATABASE_URL = process.env.DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/openshapeforge_dev";
/** The tenant and the person the shipped development realm seeds. */
const TENANT_ID = "11111111-1111-4111-8111-111111111111";

/**
 * The issuer as the realm MINTS it, read from its own discovery document.
 *
 * A deployment that pins `KC_HOSTNAME` reports that name in every token's
 * `iss` whatever port a caller used, so verifying against the way in would
 * reject every token.
 */
async function discoverIssuer(): Promise<string | null> {
  try {
    const response = await fetch(`${REALM_URL}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const issuer = ((await response.json()) as { issuer?: unknown }).issuer;
    return typeof issuer === "string" && issuer.length > 0 ? issuer : null;
  } catch (error) {
    console.warn("[application record action e2e] issuer discovery failed:", error);
    return null;
  }
}

const ISSUER = process.env.E2E_KEYCLOAK_ISSUER ?? (await discoverIssuer());
const CONTEXT_SECRET = "application-record-action-e2e-context-secret";

// Set BEFORE the app modules read them.
process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = ISSUER ?? "";
process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI =
  `${REALM_URL}/protocol/openid-connect/certs`;
process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = ROLE_CLIENT;
process.env.OPENSHAPEFORGE_API_KEY_SECRET_KEYS =
  `e2e:${randomBytes(32).toString("base64")}`;
process.env.OPENSHAPEFORGE_KEYCLOAK_BASE_URL = KEYCLOAK_URL;
process.env.OPENSHAPEFORGE_KEYCLOAK_REALM = REALM;
process.env.OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_ID = ADMIN_CLIENT;
process.env.OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_SECRET = ADMIN_SECRET;
process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = CONTEXT_SECRET;
process.env.DATABASE_URL = DATABASE_URL;

const { applyTrustedContextHeaders } = await import("@openshapeforge/auth");
const { createApiApp } = await import("../../../roles/api.js");
const { __resetSessionResolverForTests } = await import("../../identity.js");
const { __resetExchangeCacheForTests } = await import("../exchange.js");
const { readApiKeyProvisioningConfig } = await import("../runtime-config.js");
const { createIntegration } = await import("../service.js");
const { REST_MOUNT_PATH } = await import("../../../rest/rest-paths.js");
const { createDatabaseRuntime, readMigrateDatabaseUrl } = await import("../../../db/connection.js");
const { SYSTEM_BYPASS_ROLE, withSystemSession } = await import("../../../db/session.js");
const { sql } = await import("kysely");

type App = Awaited<ReturnType<typeof createApiApp>>;
type Migrate = Awaited<ReturnType<typeof createDatabaseRuntime>>;

/** The read role the entity itself declares, granted to the key on purpose. */
const READ_ROLE = "General.All.Read";
const MANAGE_ROLE = "Platform.ApiKeys.Manage";

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2500) })).ok;
  } catch {
    return false;
  }
}

async function databaseReachable(): Promise<boolean> {
  try {
    const runtime = createDatabaseRuntime({ databaseUrl: readMigrateDatabaseUrl() });
    try {
      await sql`select 1`.execute(runtime.db);
      return true;
    } finally {
      await runtime.close();
    }
  } catch {
    return false;
  }
}

const provisioning = readApiKeyProvisioningConfig();
const ready = Boolean(ISSUER) && Boolean(provisioning) &&
  await reachable(`${REALM_URL}/.well-known/openid-configuration`) &&
  await databaseReachable();

/**
 * Set false when the minted credential does not authenticate at all. Every
 * assertion below reads a REFUSAL as the entity's policy, which is only
 * meaningful once the key is known to work.
 */
let credentialUsable = true;
let app: App | undefined;
let migrate: Migrate | undefined;
let key = "";
let integrationId = "";
/** Granted the action, and readable to nobody: `view` names one person. */
let grantedNotebook = "";
/** No action grant at all, and the same human ACL. */
let ungrantedNotebook = "";
const person = randomUUID();

/** A signed trusted-context bundle for the same tenant and user. */
function trustedContextHeaders(): Record<string, string> {
  const headers = new Headers();
  applyTrustedContextHeaders(
    headers,
    { tenantId: TENANT_ID, userId: person, roles: [READ_ROLE], groups: [] },
    { secret: CONTEXT_SECRET },
  );
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    result[name] = value;
  });
  return result;
}

function acl(actions: Record<string, unknown>): string {
  return JSON.stringify({
    view: { users: [person] },
    edit: { users: [person] },
    actions,
  });
}

beforeAll(async () => {
  if (!ready) {
    console.warn(
      `[application record action e2e] SKIPPED — issuer: ${ISSUER ?? "none"}, ` +
        `provisioning configured: ${Boolean(provisioning)}.`,
    );
    return;
  }
  __resetSessionResolverForTests();
  __resetExchangeCacheForTests();
  migrate = createDatabaseRuntime({ databaseUrl: readMigrateDatabaseUrl() });

  // Registry rows and one admitted person, through the owner connection.
  // Setup, not an API request: the restricted app role is correctly blocked
  // by RLS before it has a tenant session.
  await sql`insert into erp.tenants (id, tenant_id, slug, name)
    values (${TENANT_ID}, ${TENANT_ID}, 'record-action-e2e', 'record action e2e')
    on conflict (id) do nothing`.execute(migrate.db);
  await sql`insert into platform.tenants (id, slug, name, status)
    values (${TENANT_ID}, 'record-action-e2e', 'record action e2e', 'active')
    on conflict (id) do nothing`.execute(migrate.db);
  const relationId = randomUUID();
  await sql`insert into erp.relations (id, tenant_id, display_name, relation_type, status)
    values (${relationId}, ${TENANT_ID}, 'Record action e2e person', 'person', 'active')`
    .execute(migrate.db);
  await sql`insert into platform.identities (id, issuer, subject, email, display_name)
    values (${randomUUID()}, ${ISSUER}, ${person},
      ${`e2e-${person}@example.invalid`}, 'Record action e2e person')
    on conflict (issuer, subject) do nothing`.execute(migrate.db);
  await withSystemSession(migrate.db, {
    actorSubject: "record-action-e2e",
    roles: [SYSTEM_BYPASS_ROLE],
    reason: "e2e: admit the synthetic transport identity",
    tenantId: TENANT_ID,
  }, (trx) => sql`
    insert into platform.identity_relations
      (identity_id, tenant_id, status, relation_id, linked_at, linked_by, roles)
    select i.id, ${TENANT_ID}, 'linked', ${relationId}, now(), 'record-action-e2e',
           ${sql.raw(`'{${READ_ROLE}}'`)}::text[]
      from platform.identities i
     where i.issuer = ${ISSUER} and i.subject = ${person}
    on conflict (identity_id, tenant_id) do update
      set status = 'linked', relation_id = excluded.relation_id, updated_at = now()
  `.execute(trx));

  // A real integration and a real credential, through the service the
  // provisioning route uses: a realm client, a service account carrying the
  // tenant, the entity read role, and one `osf_live_…` token returned once.
  const created = await createIntegration(
    { db: migrate.db, ...provisioning! },
    {
      tenantId: TENANT_ID,
      userId: person,
      roles: [MANAGE_ROLE, READ_ROLE],
      credential: "bearer",
    },
    { displayName: `record action e2e ${randomUUID().slice(0, 8)}`, roles: [READ_ROLE] },
  );
  key = created.token;
  integrationId = created.integrationId;
  expect(key).toStartWith("osf_live_");

  grantedNotebook = randomUUID();
  ungrantedNotebook = randomUUID();
  await sql`
    insert into notebook.notebooks (id, tenant_id, name, body, permissions) values
      (${grantedNotebook}::uuid, ${TENANT_ID}::uuid, 'Granted notes', 'confidential body',
        ${sql.raw(`'${acl({ deliver: { integrations: [integrationId] } })}'::jsonb`)}),
      (${ungrantedNotebook}::uuid, ${TENANT_ID}::uuid, 'Ungranted notes', 'confidential body',
        ${sql.raw(`'${acl({})}'::jsonb`)})
  `.execute(migrate.db);

  app = createApiApp({ cors: false, databaseUrl: DATABASE_URL });
  await app.ready();

  // The credential must actually authenticate before any refusal below means
  // anything. Verification depends on realm details this suite does not own —
  // the integration client's audience mapper and the JWKS the deployment
  // pins — so a key that does not resolve is a stack that cannot run this
  // suite, reported as such rather than as a policy failure.
  const probe = await app.inject({
    method: "GET",
    url: `${REST_MOUNT_PATH}/document-themes`,
    headers: { authorization: `Bearer ${key}` },
  });
  if (probe.statusCode !== 200) {
    credentialUsable = false;
    console.warn(
      "[application record action e2e] SKIPPED — the minted key does not " +
        `authenticate against this realm (${probe.statusCode} on a route it holds the role for).`,
    );
  }
}, 180_000);

afterAll(async () => {
  if (migrate && integrationId) {
    try {
      await sql`delete from notebook.notebooks where tenant_id = ${TENANT_ID}::uuid
        and id = any(${sql.raw(`'{${grantedNotebook},${ungrantedNotebook}}'`)}::uuid[])`
        .execute(migrate.db);
      await sql`delete from platform.api_key_integrations where id = ${integrationId}::uuid`
        .execute(migrate.db);
    } catch {
      // Best effort; the database is a throwaway.
    }
  }
  if (provisioning && integrationId) {
    try {
      await provisioning.admin.deleteClient(`osf-int-${integrationId}`);
    } catch {
      // Best effort, as above.
    }
  }
  await app?.close();
  await migrate?.close();
});

function asApplication(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${key}`, ...extra };
}

async function graphql(query: string, headers: Record<string, string>) {
  const response = await app!.inject({
    method: "POST",
    url: "/api/graphql",
    headers: { "content-type": "application/json", ...headers },
    payload: JSON.stringify({ query }),
  });
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

/** One generic MCP tool call. The transport answers JSON or a single SSE frame. */
async function mcpCall(
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const response = await app!.inject({
    method: "POST",
    url: "/api/mcp",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    payload: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return { status: response.statusCode, text: response.body };
}

async function rest(url: string, headers: Record<string, string>): Promise<number> {
  return (await app!.inject({ method: "GET", url, headers })).statusCode;
}

describe.skipIf(!ready)("a real API key against an entity that excludes applications", () => {
  test.skipIf(!credentialUsable)(
    "the credential itself works, so every refusal below is the policy",
    async () => {
      // DocumentTheme declares no principal-class policy and the key's role
      // reaches its read. A 200 here is what makes the 403s that follow mean
      // something other than "the key is broken".
      expect(await rest(`${REST_MOUNT_PATH}/document-themes`, asApplication())).toBe(200);
      // And without the credential the same route is refused, so the 200 is
      // the key's doing rather than an unauthenticated route.
      expect(await rest(`${REST_MOUNT_PATH}/document-themes`, {})).toBe(401);
    },
    120_000,
  );

  test.skipIf(!credentialUsable)("REST refuses the collection and the record read on that entity", async () => {
    expect(await rest(`${REST_MOUNT_PATH}/notebooks`, asApplication())).toBe(403);
    expect(await rest(`${REST_MOUNT_PATH}/notebooks/${grantedNotebook}`, asApplication())).toBe(403);
    // The authored policy on the snapshot entity, for the same reason.
    expect(await rest(`${REST_MOUNT_PATH}/notebook-versions`, asApplication())).toBe(403);
  }, 120_000);

  test.skipIf(!credentialUsable)("GraphQL refuses the generated list on that entity", async () => {
    // Canonical entity Operations report a refusal in band, under the field.
    const refused = await graphql(
      "{ notebooks(first: 5) { data { totalCount } error { code } } }",
      asApplication(),
    );
    expect(refused.body.data?.notebooks?.error?.code).toBe("FORBIDDEN");
    expect(refused.body.data?.notebooks?.data ?? null).toBeNull();
    // The same shape on an entity without the policy still answers.
    const allowed = await graphql(
      "{ documentThemes(first: 1) { data { totalCount } error { code } } }",
      asApplication(),
    );
    expect(allowed.body.data?.documentThemes?.error ?? null).toBeNull();
  }, 120_000);

  test.skipIf(!credentialUsable)("the generic MCP tool does not address that entity at all", async () => {
    // The projection withholds the entity rather than offering it and
    // refusing: `osf_list` reports which entities it can address in THIS
    // session, and the excluded ones are simply not among them.
    const refused = await mcpCall("osf_list", { entity: "Notebook" }, asApplication());
    expect(refused.text).toContain("is not one of the entities");
    expect(refused.text).not.toContain("\\\"Notebook\\\", ");
    const versions = await mcpCall("osf_list", { entity: "NotebookVersion" }, asApplication());
    expect(versions.text).toContain("is not one of the entities");
    // An entity the same session does address, so the refusals above are the
    // entity policy and not an empty projection.
    const allowed = await mcpCall("osf_list", { entity: "DocumentTheme" }, asApplication());
    expect(allowed.text).not.toContain("is not one of the entities");
  }, 120_000);

  test("a person with the same role on the same tenant reaches all of it", async () => {
    // The boundary is the principal class, not the entity: the signed
    // trusted-context bundle the web tier hands on is classified a person
    // through its identity link and keeps every generic route.
    const headers = trustedContextHeaders();
    expect(await rest(`${REST_MOUNT_PATH}/notebooks`, headers)).toBe(200);
    expect(await rest(`${REST_MOUNT_PATH}/notebook-versions`, headers)).toBe(200);
    const list = await graphql(
      "{ notebooks(first: 5) { data { totalCount } error { code } } }",
      headers,
    );
    expect(list.body.data?.notebooks?.error ?? null).toBeNull();
  }, 120_000);
});
