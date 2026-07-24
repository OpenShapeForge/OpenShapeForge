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
import { afterAll, describe as bunDescribe, expect, test as bunTest } from "bun:test";
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
  capturedRequests: CapturedRequest[];
  capturedEventReads: CapturedEventRead[];
  createdRows: CreatedRow[];
  runtime: DatabaseRuntime | null;
  yoga: ReturnType<typeof createGraphqlYoga> | null;
  keycloakToken: Promise<string | null> | null;
};

const store: Store = ((globalThis as Record<string, any>).__openshapeforgeE2E ??= {
  seed: randomUUID().slice(0, 8),
  tenantA: { tenantId: randomUUID(), userId: randomUUID(), roles: [] },
  tenantB: { tenantId: randomUUID(), userId: randomUUID(), roles: [] },
  capturedRequests: [],
  capturedEventReads: [],
  createdRows: [],
  runtime: null,
  yoga: null,
  keycloakToken: null,
} satisfies Store);

export const seed = store.seed;
export const tenantA = store.tenantA;
export const tenantB = store.tenantB;
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

export function getKeycloakToken(): Promise<string | null> {
  store.keycloakToken ??= (async () => {
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
          username: process.env.E2E_KEYCLOAK_USERNAME ?? "acme-directie",
          password: process.env.E2E_KEYCLOAK_PASSWORD ?? "test",
        }),
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { access_token?: string };
      return body.access_token ?? null;
    } catch {
      return null;
    }
  })();
  return store.keycloakToken;
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
export function registerSuiteLifecycle() {
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
