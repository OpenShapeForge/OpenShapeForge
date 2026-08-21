// SPDX-License-Identifier: BUSL-1.1
/**
 * Shared harness for the manifest-driven GraphQL e2e suite.
 *
 * Owns: transport (in-process graphql-yoga or E2E_API_URL over HTTP), the
 * trusted-context/bearer auth helpers, request + entity-event capture for the
 * HTML report, the describe/test wrappers that attribute captures to their
 * test, and row cleanup.
 *
 * All mutable state lives in a globalThis store so the suite behaves the same
 * whether bun runs test files with a shared module cache or isolated ones.
 * Every spec file calls `registerSuiteLifecycle()` once; the last afterAll to
 * run drains the remaining created rows and persists the capture.
 */
import { afterAll, beforeAll, describe as bunDescribe, expect, test as bunTest } from "bun:test";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../../db/connection.js";
import { listEntityEvents } from "../../../platform/entity-events.js";
import { getGeneratedCrudTables } from "../../generated-crud.js";
import { createGraphqlYoga } from "../../yoga.js";

process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ??= "openshapeforge-local-dev-context-secret";
process.env.DATABASE_URL ??= "postgres://openshapeforge:openshapeforge@localhost:5434/openshapeforge_dev";

const SECRET = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;

export type Identity = { tenantId: string; userId: string; roles: string[] };
export type GeneratedTable = ReturnType<typeof getGeneratedCrudTables>[number];

export type GqlResponse = {
  data?: Record<string, any> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
};

type CapturedRequest = {
  suite: string;
  test: string;
  auth: string;
  query: string;
  variables?: Record<string, unknown> | undefined;
  status: number;
  durationMs: number;
  response: unknown;
};

type CapturedEventRead = {
  suite: string;
  test: string;
  aggregateType: string;
  aggregateId: string;
  tenant: string;
  events: unknown[];
};

export type CreatedRow = { table: GeneratedTable; id: string; identity: Identity };

type Store = {
  seed: string;
  tenantA: Identity;
  tenantB: Identity;
  readOnly: Identity;
  noRoles: Identity;
  capturedRequests: CapturedRequest[];
  capturedEventReads: CapturedEventRead[];
  createdRows: CreatedRow[];
  runtime: DatabaseRuntime | null;
  yoga: ReturnType<typeof createGraphqlYoga> | null;
  keycloakToken: Promise<string | null> | null;
  keycloakRolelessToken: Promise<string | null> | null;
  keycloakTokens: Map<string, Promise<string | null>> | null;
  tenantRowsEnsured: Promise<void> | null;
};

/**
 * Roles held by the default e2e identities. Function-level authorization
 * (#94) gates every generated operation, so the CRUD/security suites must
 * present a role that grants read+write on the shipped entities. The three
 * core entities (relation, contact-detail, relation-group) all authorize
 * writes with the ReadWrite role; it also appears in each entity's read list,
 * so it satisfies every operation. Field-level redaction (#96/#101) treats it
 * as a write grant, so classified columns stay visible to these identities.
 *
 * The compiler emits both the authored (Dutch) and Keycloak-normalized
 * (English) spelling of every role, so either matches; these use the
 * normalized spelling that bearer tokens actually carry.
 *
 * Derived from the generated manifest rather than hardcoded: the CRUD and
 * relationship suites iterate EVERY entity the manifest ships, so the grant
 * list must grow with the catalog. Hardcoding "Relations.All.ReadWrite" broke
 * the whole generated sweep with "Not authorized to create …" the day the
 * 145-entity ERP catalog landed (#403) and would break it again on the next
 * domain. The read-only identity gets every role that appears in a read list
 * but never in a write list, which keeps "can read everything, can write
 * nothing" true whatever the catalog contains.
 */
const authorizationRoleLists = getGeneratedCrudTables().map(
  (table) => table.source?.authorization?.roles,
);
const writeRoles = new Set(
  authorizationRoleLists.flatMap((roles) => [
    ...(roles?.create ?? []),
    ...(roles?.update ?? []),
    ...(roles?.delete ?? []),
  ]),
);
export const E2E_READWRITE_ROLES = [...writeRoles].sort();
export const E2E_READONLY_ROLES = [
  ...new Set(authorizationRoleLists.flatMap((roles) => roles?.read ?? [])),
]
  .filter((role) => !writeRoles.has(role))
  .sort();

// readOnly/noRoles reuse tenantA's tenant with fresh users so role denial is
// isolated from RLS/tenant denial.
const tenantAId = randomUUID();
const store: Store = ((globalThis as Record<string, any>).__openshapeforgeE2E ??= {
  seed: randomUUID().slice(0, 8),
  tenantA: { tenantId: tenantAId, userId: randomUUID(), roles: [...E2E_READWRITE_ROLES] },
  tenantB: { tenantId: randomUUID(), userId: randomUUID(), roles: [...E2E_READWRITE_ROLES] },
  readOnly: { tenantId: tenantAId, userId: randomUUID(), roles: [...E2E_READONLY_ROLES] },
  noRoles: { tenantId: tenantAId, userId: randomUUID(), roles: [] },
  capturedRequests: [],
  capturedEventReads: [],
  createdRows: [],
  runtime: null,
  yoga: null,
  keycloakToken: null,
  keycloakRolelessToken: null,
  keycloakTokens: null,
  tenantRowsEnsured: null,
} satisfies Store);

export const seed = store.seed;
export const tenantA = store.tenantA;
export const tenantB = store.tenantB;
export const readOnly = store.readOnly;
export const noRoles = store.noRoles;
export const createdRows = store.createdRows;
export const remoteUrl = process.env.E2E_API_URL;

// ---------------------------------------------------------------------------
// describe/test wrappers — attribute captured traffic to its test
// ---------------------------------------------------------------------------

const suiteStack: string[] = [];
let currentLabel: { suite: string; test: string } | null = null;

export function describe(name: string, fn: () => void) {
  // bun may defer the describe body; maintain the stack inside the callback
  // so tests defined in it snapshot the correct suite chain.
  bunDescribe(name, () => {
    suiteStack.push(name);
    try {
      fn();
    } finally {
      suiteStack.pop();
    }
  });
}

type TestFn = () => Promise<void> | void;
function labelledTest(runner: (name: string, fn: TestFn) => void) {
  return (name: string, fn: TestFn) => {
    const suite = suiteStack.join(" › ");
    runner(name, async () => {
      currentLabel = { suite, test: name };
      try {
        await fn();
      } finally {
        currentLabel = null;
      }
    });
  };
}

export const test = Object.assign(labelledTest(bunTest), {
  skipIf: (condition: unknown) => labelledTest(condition ? bunTest.skip : bunTest),
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// Also used in remote mode: entity-event assertions read the journal directly
// from Postgres (through the same RLS session layer the API uses).
export function getRuntime(): DatabaseRuntime {
  store.runtime ??= createDatabaseRuntime();
  return store.runtime;
}

function yogaHandler() {
  store.yoga ??= createGraphqlYoga({ db: getRuntime().db });
  return store.yoga;
}

export async function gql(
  identity: Identity | null,
  query: string,
  variables?: Record<string, unknown>,
  options: { bearer?: string } = {},
): Promise<GqlResponse> {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.bearer) {
    headers.set("authorization", `Bearer ${options.bearer}`);
  } else if (identity) {
    applyTrustedContextHeaders(headers, identity, { secret: SECRET });
  }
  const body = JSON.stringify({ query, variables });
  const request = new Request(`${remoteUrl ?? "http://e2e.internal"}/api/graphql`, {
    method: "POST",
    headers,
    body,
  });
  const startedAt = performance.now();
  const response = remoteUrl ? await fetch(request) : await yogaHandler().fetch(request);
  const parsed = (await response.json()) as GqlResponse;
  store.capturedRequests.push({
    suite: currentLabel?.suite ?? "(outside tests)",
    test: currentLabel?.test ?? "(setup/cleanup)",
    auth: options.bearer
      ? "bearer <redacted>"
      : identity
        ? `trusted-context tenant=…${identity.tenantId.slice(-6)}`
        : "none",
    query: query.replace(/\s+/g, " ").trim(),
    variables,
    status: response.status,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    response: parsed,
  });
  return parsed;
}

export async function expectData(
  identity: Identity,
  query: string,
  variables?: Record<string, unknown>,
): Promise<Record<string, any>> {
  const result = await gql(identity, query, variables);
  expect(result.errors ?? []).toEqual([]);
  expect(result.data).toBeTruthy();
  return result.data!;
}

// ---------------------------------------------------------------------------
// Entity-event journal reads
// ---------------------------------------------------------------------------

/** aggregate_type mirrors the engine: the entity's singleQueryName. */
export function aggregateTypeOf(table: GeneratedTable): string {
  return table.source!.graphql!.singleQueryName;
}

export async function eventsFor(
  identity: Identity,
  table: GeneratedTable,
  aggregateId: string,
) {
  const { events } = await listEntityEvents(
    getRuntime().db,
    { ...identity, groups: [] },
    { aggregateType: aggregateTypeOf(table), aggregateId },
  );
  store.capturedEventReads.push({
    suite: currentLabel?.suite ?? "(outside tests)",
    test: currentLabel?.test ?? "(setup/cleanup)",
    aggregateType: aggregateTypeOf(table),
    aggregateId,
    tenant: `…${identity.tenantId.slice(-6)}`,
    events,
  });
  return events;
}

// ---------------------------------------------------------------------------
// Keycloak bearer support
// ---------------------------------------------------------------------------

async function fetchKeycloakToken(
  username: string,
  password: string,
): Promise<string | null> {
  const issuer = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;
  if (!issuer) return null;
  try {
    const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: process.env.E2E_KEYCLOAK_CLIENT_ID ?? "openshapeforge-gateway",
        client_secret: process.env.E2E_KEYCLOAK_CLIENT_SECRET ?? "dev-secret",
        username,
        password,
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { access_token?: string };
    return body.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Password for a seeded realm user.
 *
 * A development realm carries the committed literal; a production realm carries
 * a generated one, supplied as E2E_USER_PASSWORD_<USERNAME>. The fallback keeps
 * local runs working with no environment at all, which is the same bargain the
 * compiler strikes when it authors these as `${env:VAR:-test}`.
 */
function passwordFor(username: string): string {
  const key = `E2E_USER_PASSWORD_${username.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
  return process.env[key] ?? "test";
}

/**
 * A token for any realm user, memoized per username so a spec can hold several
 * identities at once without re-authenticating.
 */
export function keycloakTokenFor(
  username: string,
  password = passwordFor(username),
): Promise<string | null> {
  store.keycloakTokens ??= new Map();
  let token = store.keycloakTokens.get(username);
  if (!token) {
    token = fetchKeycloakToken(username, password);
    store.keycloakTokens.set(username, token);
  }
  return token;
}

/** A token for a user that HOLDS realm roles (acme-directie by default). */
export function getKeycloakToken(): Promise<string | null> {
  const username = process.env.E2E_KEYCLOAK_USERNAME ?? "acme-directie";
  store.keycloakToken ??= fetchKeycloakToken(
    username,
    process.env.E2E_KEYCLOAK_PASSWORD ?? passwordFor(username),
  );
  return store.keycloakToken;
}

/**
 * A token for a real, ENABLED realm user that holds NO realm roles.
 *
 * This is the counterpart the bearer coverage was missing. Proving a token with
 * the right role is accepted does not prove roles are read at all — an
 * authorizer that ignored the token's roles and allowed everything would pass
 * that test unchanged. Only a valid token that must be REFUSED distinguishes
 * "roles are enforced" from "requests are waved through".
 *
 * The role-less identity has to come from Keycloak rather than a synthetic
 * trusted-context header, because the claim path under test is exactly the one
 * that maps realm_access.roles out of a JWT.
 */
export function getRolelessKeycloakToken(): Promise<string | null> {
  const username = process.env.E2E_KEYCLOAK_NOACCESS_USERNAME ?? "acme-noaccess";
  store.keycloakRolelessToken ??= fetchKeycloakToken(
    username,
    process.env.E2E_KEYCLOAK_NOACCESS_PASSWORD ?? passwordFor(username),
  );
  return store.keycloakRolelessToken;
}

// ---------------------------------------------------------------------------
// Lifecycle: cleanup + capture persistence (idempotent, per spec file)
// ---------------------------------------------------------------------------

function persistCapture() {
  const reportDir = resolve(import.meta.dir, "../../../../../..", ".e2e-report");
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    join(reportDir, "requests.json"),
    JSON.stringify(
      {
        transport: remoteUrl ?? "in-process",
        requests: store.capturedRequests,
        eventReads: store.capturedEventReads,
      },
      null,
      2,
    ),
    "utf8",
  );
}

/**
 * Call once per spec file. Drains rows created so far (children before
 * parents) and rewrites the cumulative capture; the last file to finish
 * leaves the complete picture on disk.
 */
/**
 * The harness identities carry random tenant ids that exist nowhere. That was
 * fine while nothing referenced a tenant, but the ERP catalog gave erp.tenants
 * inbound foreign keys (label_rules.tenant_id, tenant_settings.tenant_id), so
 * a row created under a tenant with no erp.tenants row now fails the
 * constraint. Insert the two identities' tenants once per run, through the
 * privileged connection the harness already holds. Remote mode skips this:
 * the deployed environment provisions its tenants for real, and most cluster
 * specs run without any database access.
 */
export function ensureTenantRows(): Promise<void> {
  if (remoteUrl) return Promise.resolve();
  store.tenantRowsEnsured ??= (async () => {
    const db = getRuntime().db;
    for (const { tenantId } of [tenantA, tenantB]) {
      await sql`
        INSERT INTO erp.tenants (id, tenant_id, slug, name)
        VALUES (${tenantId}, ${tenantId}, ${`e2e-${tenantId}`}, ${`e2e tenant ${tenantId}`})
        ON CONFLICT (id) DO NOTHING
      `.execute(db);
    }
  })();
  return store.tenantRowsEnsured;
}

export function registerSuiteLifecycle() {
  beforeAll(ensureTenantRows);
  afterAll(async () => {
    for (const row of store.createdRows.splice(0).reverse()) {
      const graphql = row.table.source!.graphql!;
      await gql(row.identity, `mutation($id: ID!) { ${graphql.deleteMutationName}(id: $id) }`, {
        id: row.id,
      }).catch(() => {});
    }
    persistCapture();
  });
}
