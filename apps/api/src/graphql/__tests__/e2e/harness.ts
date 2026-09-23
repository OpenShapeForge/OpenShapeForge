// SPDX-License-Identifier: BUSL-1.1
/**
 * Shared harness for the manifest-driven GraphQL e2e suite.
 *
 * Owns: transport (the in-process API app via inject, or E2E_API_URL over
 * HTTP), the trusted-context/bearer auth helpers, request + entity-event
 * capture for the HTML report, the describe/test wrappers that attribute
 * captures to their test, and row cleanup.
 *
 * All mutable state lives in a globalThis store so the suite behaves the same
 * whether bun runs test files with a shared module cache or isolated ones.
 * Every spec file calls `registerSuiteLifecycle()` once; the last afterAll to
 * run drains the remaining created rows and persists the capture.
 */
import {
  afterAll,
  beforeAll,
  describe as bunDescribe,
  expect,
  test as bunTest,
} from "bun:test";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { parse, print } from "graphql";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import {
  createDatabaseRuntime,
  readMigrateDatabaseUrl,
  type DatabaseRuntime,
} from "../../../db/connection.js";
import { SYSTEM_BYPASS_ROLE, withSystemSession } from "../../../db/session.js";
import { loadRuntimeModules, type ModuleRegistry } from "../../../modules/registry.js";
import { listEntityEvents } from "../../../platform/entity-events.js";
import { createApiApp } from "../../../roles/api.js";
import { getGeneratedCrudTables } from "../../generated-crud.js";
import persistedManifest from "../../../generated/graphql/persisted-operations.json" with { type: "json" };
import { seedKeycloakTokenPeople } from "./keycloak.js";
export {
  getKeycloakToken,
  getRolelessKeycloakToken,
  keycloakTokenFor,
} from "./keycloak.js";
export { seedKeycloakTokenPeople };

process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ??=
  "openshapeforge-local-dev-context-secret";
process.env.DATABASE_URL ??=
  "postgres://openshapeforge:openshapeforge@localhost:5434/openshapeforge_dev";
// The realm a trusted-context session's identity is issued by: the session
// layer refuses a linkable session that names none (503), so the harness's
// signed identities need one. Unreachable on purpose — the opt-in bearer
// tests still skip because no token can be fetched from it, and no JWKS is
// configured, so no bearer verifier switches on.
process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER ??= "http://127.0.0.1:9/realms/e2e";
// The sweeps put thousands of requests a minute through one identity — a load
// the API's per-caller limiter (600/min anonymous, five times that trusted)
// rightly refuses in production, and not what these suites measure. A
// deployment that set its own budget keeps it.
process.env.API_RATE_LIMIT_MAX ??= "1000000";
process.env.API_RATE_LIMIT_MAX_TRUSTED ??= "1000000";

const SECRET = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;

export type Identity = { tenantId: string; userId: string; roles: string[] };
export type GeneratedTable = ReturnType<typeof getGeneratedCrudTables>[number];
export type ApiApp = ReturnType<typeof createApiApp>;

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

export type CreatedRow = {
  table: GeneratedTable;
  id: string;
  identity: Identity;
};

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
  seedRuntime: DatabaseRuntime | null;
  app: Promise<{ instance: ApiApp }> | null;
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
const store: Store = ((
  globalThis as Record<string, any>
).__openshapeforgeE2E ??= {
  seed: randomUUID().slice(0, 8),
  tenantA: {
    tenantId: tenantAId,
    userId: randomUUID(),
    roles: [...E2E_READWRITE_ROLES],
  },
  tenantB: {
    tenantId: randomUUID(),
    userId: randomUUID(),
    roles: [...E2E_READWRITE_ROLES],
  },
  readOnly: {
    tenantId: tenantAId,
    userId: randomUUID(),
    roles: [...E2E_READONLY_ROLES],
  },
  noRoles: { tenantId: tenantAId, userId: randomUUID(), roles: [] },
  capturedRequests: [],
  capturedEventReads: [],
  createdRows: [],
  runtime: null,
  seedRuntime: null,
  app: null,
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
  skipIf: (condition: unknown) =>
    labelledTest(condition ? bunTest.skip : bunTest),
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

/** Owner connection for e2e setup that deliberately sits outside app RLS. */
export function getSeedRuntime(): DatabaseRuntime {
  store.seedRuntime ??= createDatabaseRuntime({
    databaseUrl: readMigrateDatabaseUrl(),
  });
  return store.seedRuntime;
}

/**
 * The in-process API: the same Fastify app the deployed process runs, with
 * the runtime modules loaded, so a plugin-backed Operation (a document's
 * create) reaches its handler exactly as it does in production — the handler
 * is bound to the app's own database runtime at boot, which a bare Yoga
 * instance never sees. Built once per process and never closed, like the
 * harness's database runtime: bun ends the process when the run is over.
 * Shared with the REST-based lease helper and the REST suites.
 */
export async function apiApp(): Promise<ApiApp> {
  // Held inside an object: a Fastify instance is itself a thenable, and a bare
  // promise of one would unwrap it (booting the app early as a side effect).
  store.app ??= (async () => {
    const modules: ModuleRegistry = await loadRuntimeModules();
    if (modules.failures.length > 0) {
      throw new Error(`Runtime modules failed to load: ${JSON.stringify(modules.failures)}`);
    }
    return {
      instance: createApiApp({
        cors: false,
        ...(process.env.DATABASE_URL ? { databaseUrl: process.env.DATABASE_URL } : {}),
        modules,
      }),
    };
  })();
  return (await store.app).instance;
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
  const canonical = print(parse(query));
  const hash = createHash("sha256").update(canonical).digest("hex");
  const isPersisted =
    (persistedManifest.operations as Record<string, string>)[hash] ===
    canonical;
  const body = JSON.stringify(
    isPersisted
      ? {
          variables,
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
        }
      : { query, variables },
  );
  const path = isPersisted ? "/api/graphql/persisted" : "/api/graphql";
  const startedAt = performance.now();
  let status: number;
  let parsed: GqlResponse;
  if (remoteUrl) {
    const response = await fetch(`${remoteUrl}${path}`, { method: "POST", headers, body });
    status = response.status;
    parsed = (await response.json()) as GqlResponse;
  } else {
    const response = await (await apiApp()).inject({
      method: "POST",
      url: path,
      headers: Object.fromEntries(headers.entries()),
      payload: body,
    });
    status = response.statusCode;
    parsed = JSON.parse(response.body) as GqlResponse;
  }
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
    status,
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
// Lifecycle: cleanup + capture persistence (idempotent, per spec file)
// ---------------------------------------------------------------------------

function persistCapture() {
  const reportDir = resolve(
    import.meta.dir,
    "../../../../../..",
    ".e2e-report",
  );
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
 * constraint — and the platform registry has its own: a keyed Operation (a
 * plugin-backed create) records an execution receipt whose tenant must exist
 * in platform.tenants, or the whole create is refused as REFERENCE_NOT_FOUND.
 * Insert the two identities' tenants in both registries once per run, through
 * the privileged connection the harness already holds. Remote mode skips
 * this: the deployed environment provisions its tenants for real, and most
 * cluster specs run without any database access.
 */
export function ensureTenantRows(): Promise<void> {
  if (remoteUrl) return Promise.resolve();
  store.tenantRowsEnsured ??= (async () => {
    // Tenant registry seeding is setup, not an API request: the restricted app
    // role is correctly blocked by RLS before it has a tenant session.
    const db = getSeedRuntime().db;
    for (const { tenantId } of [tenantA, tenantB]) {
      await sql`
        INSERT INTO erp.tenants (id, tenant_id, slug, name)
        VALUES (${tenantId}, ${tenantId}, ${`e2e-${tenantId}`}, ${`e2e tenant ${tenantId}`})
        ON CONFLICT (id) DO NOTHING
      `.execute(db);
      await sql`
        INSERT INTO platform.tenants (id, slug, name, status)
        VALUES (${tenantId}, ${`e2e-${tenantId}`}, ${`e2e tenant ${tenantId}`}, 'active')
        ON CONFLICT (id) DO NOTHING
      `.execute(db);
    }
    // The canonical create Operations that stamp an acting Relation must see
    // the same admitted identity state production sessions require. Trusted
    // context proves who signed the internal request; it deliberately does
    // not invent an organization membership or Relation link. Seed one
    // tenant-owned person and linked identity for every synthetic caller.
    const issuer = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER!;
    for (const identity of [tenantA, tenantB, readOnly, noRoles]) {
      const relationId = randomUUID();
      const identityId = randomUUID();
      const email = `e2e-${identity.userId}@example.invalid`;
      await sql`
        insert into erp.relations (id, tenant_id, display_name, relation_type, status)
        values (${relationId}, ${identity.tenantId}, ${`E2E ${identity.userId}`}, 'person', 'active')
      `.execute(db);
      await sql`
        insert into platform.identities (id, issuer, subject, email, display_name)
        values (${identityId}, ${issuer}, ${identity.userId}, ${email}, ${`E2E ${identity.userId}`})
        on conflict (issuer, subject) do update set display_name = excluded.display_name
      `.execute(db);
      await withSystemSession(
        db,
        {
          actorSubject: "e2e-seed",
          roles: [SYSTEM_BYPASS_ROLE],
          reason: "e2e: admit synthetic transport identity",
          tenantId: identity.tenantId,
        },
        (trx) => sql`
          insert into platform.identity_relations
            (identity_id, tenant_id, status, relation_id, linked_at, linked_by, roles)
          select i.id, ${identity.tenantId}, 'linked', ${relationId}, now(), 'e2e-seed',
                 (select coalesce(array_agg(value), '{}'::text[])
                    from jsonb_array_elements_text(${identity.roles}::jsonb))
            from platform.identities i
           where i.issuer = ${issuer} and i.subject = ${identity.userId}
          on conflict (identity_id, tenant_id) do update
            set status = 'linked', relation_id = excluded.relation_id,
                linked_at = now(), linked_by = 'e2e-seed', roles = excluded.roles,
                updated_at = now()
        `.execute(trx),
      );
    }
  })();
  return store.tenantRowsEnsured;
}

/** Seed tenant membership for real bearer identities through the owner connection. */
export async function ensureKeycloakTokenPeople(
  tokens: readonly (string | null)[],
): Promise<void> {
  await seedKeycloakTokenPeople(getSeedRuntime().db, tokens);
}

export function registerSuiteLifecycle() {
  beforeAll(ensureTenantRows);
  afterAll(async () => {
    // Reverse order (children before the parents they reference), in modest
    // concurrent batches: the full-catalog sweeps track thousands of rows,
    // and deleting them one at a time blew past the hook timeout, which bun
    // reports as an unnamed file-level failure.
    const rows = store.createdRows.splice(0).reverse();
    const batchSize = 25;
    for (let i = 0; i < rows.length; i += batchSize) {
      await Promise.all(
        rows.slice(i, i + batchSize).map((row) => {
          // A canonical delete is a product interaction — lease, version,
          // confirmation challenge — and an entity may have no GraphQL
          // mutation at all. Test cleanup must not re-enact that interaction
          // merely to remove a fixture, so the owner connection deletes the
          // exact row.
          if (!row.table.primaryKey) return Promise.resolve();
          const tenantWhere = row.table.tenantScoped
            ? sql`and ${sql.id("tenant_id")} = ${row.identity.tenantId}::uuid`
            : sql``;
          return sql`
            delete from ${sql.id(row.table.schema, row.table.table)}
            where ${sql.id(row.table.primaryKey)}::text = ${row.id}
              ${tenantWhere}
          `.execute(getSeedRuntime().db).then(() => {}).catch(() => {});
        }),
      );
    }
    persistCapture();
  }, 120_000);
}
