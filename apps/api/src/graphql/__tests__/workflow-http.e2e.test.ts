// SPDX-License-Identifier: BUSL-1.1
/**
 * The workflow surface as a client actually reaches it: over HTTP, against a
 * booted server, authenticated by a token the identity provider minted.
 *
 * ## What the in-process suites structurally cannot see
 *
 * The five other workflow e2e suites assemble a schema and call `graphql()`
 * with a context they built by hand. That is the right shape for pinning
 * resolver behaviour, and it is blind by construction to everything between a
 * resolver and a caller: the fastify instance, the route table, the module
 * initialisation `createApiApp` performs while it boots, the session derived
 * from an `Authorization` header, and the error handling graphql-yoga wraps
 * every execution in. Each of those can be wrong on its own while every
 * resolver is right.
 *
 * - A module whose `init` throws is dropped from the registry, and its entire
 *   GraphQL surface disappears with it. A suite that calls `initRuntimeModules`
 *   itself proves that its own call succeeded, not that the boot path makes it.
 * - A schema that composes inside a test can still fail to compose at boot,
 *   where the module's fields meet the generated entity surface and the module
 *   composition guard.
 * - A resolver handed a synthetic `roles: ["directie"]` is not the same
 *   resolver handed whatever `resolveSessionContext` maps out of a JWT. The
 *   authorization answer is only as good as the roles that actually arrive.
 * - An error that carries `extensions.code` when `graphql()` executes it may
 *   arrive at a client with a different code, or none: yoga's masked-errors
 *   layer sits between the two and rewrites anything it does not recognise as
 *   a `GraphQLError`.
 *
 * So this file asserts almost nothing about workflow semantics — the suites
 * that own those already do it better, against an isolated tenant per test. It
 * asserts the reachability, the wiring, and the codes, because those are the
 * facts that only a real request can establish.
 *
 * ## How it gets a server
 *
 * It boots one: `createApiApp` with the modules `loadRuntimeModules` resolves —
 * byte for byte what `startApiRole` does — listening on an ephemeral port. A
 * test that attached to a server someone had started by hand would prove
 * whatever that process happened to be built from, which is not a property of
 * this branch. Booting here also makes module initialisation part of the
 * subject rather than part of the setup: `createApiApp` runs `initRuntimeModules`
 * inside the registration that `listen` awaits, so a module that cannot start
 * fails this file at `beforeAll`.
 *
 * ## Why a scratch database
 *
 * The same reason `workflow-definitions.e2e.test.ts` uses one, plus a stronger
 * one here: the tenant is not chosen by the test. It is whatever `tid` the
 * seeded realm user carries, so every run of this file lands in the same tenant
 * of whatever database it points at, and a shared database would accumulate
 * definitions across runs until the catalog and list assertions meant nothing.
 * A throwaway database, migrated with the loaded modules' seeds and dropped at
 * the end, keeps the assertions exact and leaves the development database
 * untouched. The seeds are not optional: the module hydrates its node catalog
 * from those rows during `init`, and an unseeded catalog would leave the boot
 * assertion below asserting an empty list against an empty list.
 *
 * ## Skipping
 *
 * Bearer verification needs an issuer AND a JWKS URI; without both,
 * `resolveSessionContext` fails closed on every token and there is no way to
 * authenticate at all. Absent configuration is not a failure — it is a machine
 * without a realm — so the suite skips, and skips before it creates a database
 * or binds a port.
 *
 * Run (cwd apps/api), with a realm on :8181:
 *   set -o pipefail; \
 *   OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER=http://localhost:8181/realms/openshapeforge \
 *   OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI=http://localhost:8181/realms/openshapeforge/protocol/openid-connect/certs \
 *   bun test src/graphql/__tests__/workflow-http.e2e.test.ts 2>&1
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { createDatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { loadRuntimeModules } from "../../modules/registry.js";
import { createApiApp } from "../../roles/api.js";
import { getKeycloakToken, getRolelessKeycloakToken } from "./e2e/harness.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const TEST_TIMEOUT = 90_000;

/** Compiler output; the same directory `workflow-catalogs-seed.ts` loads from. */
const GENERATED_WORKFLOW_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../generated/workflow",
);

/** The domain node packs' own root, owned by the second plugin. */
const GENERATED_DOMAIN_NODES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../generated/workflow-domain-nodes",
);

// ---------------------------------------------------------------------------
// Preconditions: a configured verifier and two real identities
// ---------------------------------------------------------------------------

const bearerConfigured = Boolean(
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER &&
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI,
);

/**
 * The two identities this file needs, from the realm rather than from a
 * fixture. They differ in exactly one thing that matters — `acme-directie`
 * holds the `directie` realm role and `acme-noaccess` holds none — and they
 * carry the SAME `tid`. Sharing the tenant is what makes the refusal in the
 * authorization test attributable to the role: a denial across two tenants
 * would be indistinguishable from tenant isolation doing the work.
 */
const writerToken = bearerConfigured ? await getKeycloakToken() : null;
const rolelessToken = bearerConfigured ? await getRolelessKeycloakToken() : null;

const enabled = Boolean(writerToken && rolelessToken);
const httpTest = test.skipIf(!enabled);

// ---------------------------------------------------------------------------
// Scratch database + booted server
// ---------------------------------------------------------------------------

type Suite = {
  admin: SQL;
  database: string;
  app: ReturnType<typeof createApiApp>;
  baseUrl: string;
};

let suite: Suite;

function scratchUrl(database: string): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  url.pathname = `/${database}`;
  return url.toString();
}

async function startSuite(): Promise<Suite> {
  const database = `wfhttp_e2e_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(database)) {
    throw new Error(`unsafe scratch database name: ${database}`);
  }

  const admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${database}"`);
  const databaseUrl = scratchUrl(database);

  // Resolved once and handed to `createApiApp` unchanged: a registry loaded
  // twice could differ, and then the schema under test would not be the schema
  // whose seeds this database carries.
  const modules = await loadRuntimeModules();
  expect(modules.failures).toEqual([]);

  const migrationRuntime = createDatabaseRuntime({ databaseUrl, maxConnections: 1 });
  try {
    const moduleSeeds = modules.loaded.flatMap((module) => module.seeds ?? []);
    await migrationRuntime.db
      .connection()
      .execute((connection) => runMigrationChain(connection, { moduleSeeds }));
  } finally {
    // The server opens its own pool from the same URL; two would just compete.
    await migrationRuntime.close();
  }

  const app = createApiApp({ databaseUrl, modules });
  // Port 0: the operating system picks a free one, so two suites running side
  // by side cannot collide on a hardcoded port.
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  return { admin, database, app, baseUrl };
}

async function stopSuite(): Promise<void> {
  if (!suite) return;
  await suite.app.close();
  await suite.admin.unsafe(`drop database if exists "${suite.database}" with (force)`);
  await suite.admin.close();
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

type GqlResponse = {
  data?: Record<string, any> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
};

/**
 * One GraphQL request over the wire. `fetch` rather than `app.inject`: inject
 * hands fastify a synthetic request object and never opens a socket, which
 * would leave the HTTP layer itself — parsing, framing, the listening server —
 * outside the subject of a file that exists to include it.
 */
async function post(
  bearer: string | null,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<{ status: number; body: GqlResponse }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;

  const response = await fetch(`${suite.baseUrl}/api/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  return { status: response.status, body: (await response.json()) as GqlResponse };
}

async function expectData(
  bearer: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const { status, body } = await post(bearer, query, variables);
  // Messages rather than the error objects: a failure here should print what
  // went wrong instead of a structural diff.
  expect(body.errors?.map((error) => error.message) ?? []).toEqual([]);
  expect(status).toBe(200);
  expect(body.data).toBeTruthy();
  return body.data as Record<string, any>;
}

/** The `extensions.code` of the first error, for the paths that must refuse. */
async function expectErrorCode(
  bearer: string | null,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<unknown> {
  const { body } = await post(bearer, query, variables);
  expect(body.errors?.length ?? 0).toBeGreaterThan(0);
  return body.errors?.[0]?.extensions?.code;
}

// ---------------------------------------------------------------------------
// Documents and fixtures
// ---------------------------------------------------------------------------

const LIST_DEFINITIONS = /* GraphQL */ `
  query ListDefinitions {
    workflowDefinitions {
      id
      name
      triggerTypes
      publishedVersion
      latestVersion
    }
  }
`;

const NODE_TYPES = /* GraphQL */ `
  query NodeTypes {
    workflowNodeTypes {
      type
      category
    }
  }
`;

const CREATE_DEFINITION = /* GraphQL */ `
  mutation CreateDefinition($input: CreateWorkflowDefinitionInput!) {
    createWorkflowDefinition(input: $input) {
      id
      name
      updatedAt
      latestVersion
      publishedVersion
    }
  }
`;

const SAVE_VERSION = /* GraphQL */ `
  mutation SaveVersion($input: SaveWorkflowDefinitionVersionInput!) {
    saveWorkflowDefinitionVersion(input: $input) {
      id
      updatedAt
      latestVersion
      publishedVersion
    }
  }
`;

const PUBLISH_VERSION = /* GraphQL */ `
  mutation PublishVersion($input: PublishWorkflowDefinitionVersionInput!) {
    publishWorkflowDefinitionVersion(input: $input) {
      version
      publishedAt
      publishedBy
    }
  }
`;

const DEFINITION_BY_ID = /* GraphQL */ `
  query DefinitionById($id: ID!) {
    workflowDefinition(id: $id) {
      id
      name
      triggerTypes
      publishedVersion
      latestVersion
    }
  }
`;

/**
 * A graph that publishes cleanly: unique node ids, a catalog-known type on
 * every node, both ends of every edge resolving. Publish refuses a graph the
 * validator reports errors for, so a careless document would fail the round
 * trip for a reason that has nothing to do with the transport.
 */
const TRIGGERED_GRAPH = {
  name: "http round trip",
  version: "1",
  nodes: [
    { id: "start", type: "triggerManual", position: { x: 0, y: 0 } },
    { id: "finish", type: "end", position: { x: 240, y: 0 } },
  ],
  edges: [{ id: "start-finish", source: "start", target: "finish" }],
};

/**
 * Every node type the migration chain seeded into
 * `platform.workflow_node_catalog_entries`.
 *
 * All three documents, because `hydrateNodeCatalog` reads the table unfiltered:
 * the standard, entity and domain catalogs share it — `node_type` is the
 * primary key, so the slices cannot collide — and the module's in-memory store
 * holds their union. The third is emitted by a different plugin into its own
 * generated root, which is why this reads two directories rather than one.
 */
async function seededNodeTypes(): Promise<string[]> {
  const documents: [string, string][] = [
    [GENERATED_WORKFLOW_DIR, "node-catalog.seed.json"],
    [GENERATED_WORKFLOW_DIR, "entity-catalog.seed.json"],
    [GENERATED_DOMAIN_NODES_DIR, "node-catalog.seed.json"],
  ];
  const types: string[] = [];
  for (const [dir, file] of documents) {
    const seed = JSON.parse(await readFile(join(dir, file), "utf8")) as {
      entries: { nodeType: string }[];
    };
    types.push(...seed.entries.map((entry) => entry.nodeType));
  }
  return types.sort();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!enabled) return;
  suite = await startSuite();
}, TEST_TIMEOUT);

afterAll(async () => {
  await stopSuite();
}, TEST_TIMEOUT);

describe("workflow over HTTP", () => {
  httpTest(
    "a real bearer token reaches the workflow surface",
    async () => {
      const { status, body } = await post(writerToken!, LIST_DEFINITIONS);

      // A field the schema does not carry fails validation, so an empty error
      // list here is the whole assertion: the module's query survived boot and
      // the route answered it.
      expect(body.errors?.map((error) => error.message) ?? []).toEqual([]);
      expect(status).toBe(200);
      expect(Array.isArray(body.data?.workflowDefinitions)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  httpTest(
    "the module initialised during boot, so the node catalog answers in full",
    async () => {
      const data = await expectData(writerToken!, NODE_TYPES);
      const returned = (data.workflowNodeTypes as { type: string }[])
        .map((node) => node.type)
        .sort();

      // This is the assertion that proves boot-time wiring rather than schema
      // composition. `init` hydrates the catalog from the rows the migration
      // chain seeded; had it thrown, the module would have been dropped and
      // `workflowNodeTypes` would not exist as a field at all. Comparing the
      // whole set rather than a count also catches a hydration that read the
      // wrong slice of the shared catalog table.
      expect(returned).toEqual(await seededNodeTypes());
      expect(returned.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  httpTest(
    "a definition is created, versioned, published and read back over HTTP",
    async () => {
      const bearer = writerToken!;
      const created = (
        await expectData(bearer, CREATE_DEFINITION, {
          input: { name: `http round trip ${randomUUID().slice(0, 8)}` },
        })
      ).createWorkflowDefinition as { id: string; updatedAt: string };

      const saved = (
        await expectData(bearer, SAVE_VERSION, {
          input: {
            definitionId: created.id,
            expectedUpdatedAt: created.updatedAt,
            definition: TRIGGERED_GRAPH,
          },
        })
      ).saveWorkflowDefinitionVersion as { latestVersion: number; publishedVersion: number | null };
      expect(saved.latestVersion).toBe(1);
      expect(saved.publishedVersion).toBeNull();

      const published = (
        await expectData(bearer, PUBLISH_VERSION, {
          input: { definitionId: created.id, version: 1 },
        })
      ).publishWorkflowDefinitionVersion as { version: number; publishedBy: string | null };
      expect(published.version).toBe(1);
      // The stamp comes from the session the token produced, so this is also
      // the only place that shows the resolved `userId` is the token's subject
      // rather than something the transport invented.
      expect(published.publishedBy).toBeTruthy();

      const read = (
        await expectData(bearer, DEFINITION_BY_ID, { id: created.id })
      ).workflowDefinition as {
        triggerTypes: string[];
        publishedVersion: number | null;
        latestVersion: number | null;
      };
      expect(read.publishedVersion).toBe(1);
      expect(read.latestVersion).toBe(1);
      // Derived from the published graph, which is the only reason a JSON
      // document that crossed the wire as a variable can be asserted from here.
      expect(read.triggerTypes).toEqual(["triggerManual"]);
    },
    TEST_TIMEOUT,
  );

  httpTest(
    "an unauthenticated request to a workflow field is refused",
    async () => {
      expect(await expectErrorCode(null, LIST_DEFINITIONS)).toBe("UNAUTHENTICATED");
    },
    TEST_TIMEOUT,
  );

  httpTest(
    "a real token holding no writer role is refused a create",
    async () => {
      const code = await expectErrorCode(rolelessToken!, CREATE_DEFINITION, {
        input: { name: `refused ${randomUUID().slice(0, 8)}` },
      });

      // The roles this refusal is based on came out of a JWT rather than out of
      // a literal in this file, which is the one thing the in-process suites
      // cannot show. The two identities share a tenant, so a passing assertion
      // here cannot be explained by tenant isolation.
      expect(code).toBe("FORBIDDEN");

      // A refused mutation must not have written on its way to refusing. The
      // writer reads the list back because the roleless identity cannot.
      const { workflowDefinitions } = await expectData(writerToken!, LIST_DEFINITIONS);
      expect(
        (workflowDefinitions as { name: string }[]).some((definition) =>
          definition.name.startsWith("refused "),
        ),
      ).toBe(false);
    },
    TEST_TIMEOUT,
  );

  httpTest(
    "an error code survives the transport unchanged",
    async () => {
      const bearer = writerToken!;
      const created = (
        await expectData(bearer, CREATE_DEFINITION, {
          input: { name: `stale token ${randomUUID().slice(0, 8)}` },
        })
      ).createWorkflowDefinition as { id: string; updatedAt: string };

      const input = {
        definitionId: created.id,
        expectedUpdatedAt: created.updatedAt,
        definition: TRIGGERED_GRAPH,
      };
      await expectData(bearer, SAVE_VERSION, { input });

      // The first save moved `updated_at`, so replaying the same document now
      // presents a stale optimistic-concurrency token. The in-process suites
      // pin this as CONCURRENT_MODIFICATION; a client branches on the code, so
      // the code is what has to arrive — not the sentence, and not whatever the
      // transport's error handling would rather say.
      expect(await expectErrorCode(bearer, SAVE_VERSION, { input })).toBe(
        "CONCURRENT_MODIFICATION",
      );
    },
    TEST_TIMEOUT,
  );

  // -------------------------------------------------------------------------
  // The module's REST contribution
  // -------------------------------------------------------------------------

  /**
   * `restRoutes` is the module contract's other half, and until the webhook
   * trigger landed nothing implemented it — so the host's registration loop in
   * `roles/api.ts` had never once been executed with a module that contributes
   * a route. These three tests are the only thing standing under it.
   *
   * They are here rather than in a unit test because mounting is precisely the
   * part a unit test cannot see: the route exists as a function either way, and
   * the question is whether `createApiApp` ever calls it.
   */
  async function postWebhook(
    bearer: string | null,
    definitionId: string,
    body: Record<string, unknown> = {},
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...extraHeaders,
    };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const response = await fetch(
      `${suite.baseUrl}/api/workflow/triggers/webhook/${definitionId}`,
      { method: "POST", headers, body: JSON.stringify(body) },
    );
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  /** A published definition with a manual trigger, which a webhook may start. */
  async function publishTriggerable(bearer: string): Promise<string> {
    const created = (
      await expectData(bearer, CREATE_DEFINITION, {
        input: { name: `webhook ${randomUUID().slice(0, 8)}` },
      })
    ).createWorkflowDefinition as { id: string; updatedAt: string };

    const saved = (
      await expectData(bearer, SAVE_VERSION, {
        input: {
          definitionId: created.id,
          expectedUpdatedAt: created.updatedAt,
          definition: TRIGGERED_GRAPH,
        },
      })
    ).saveWorkflowDefinitionVersion as { latestVersion: number };

    await expectData(bearer, PUBLISH_VERSION, {
      input: { definitionId: created.id, version: saved.latestVersion },
    });
    return created.id;
  }

  httpTest(
    "the module's webhook route is mounted and starts a run",
    async () => {
      const bearer = writerToken!;
      const definitionId = await publishTriggerable(bearer);

      const { status, body } = await postWebhook(bearer, definitionId, {
        source: "http round trip",
      });

      expect(status).toBe(202);
      expect(body.definitionId).toBe(definitionId);
      // An id, not just an acknowledgement: a 202 that enqueued nothing would
      // be indistinguishable from a route that accepted and dropped the call.
      expect(typeof body.instanceId).toBe("string");
      expect(body.instanceId.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  httpTest(
    "an unauthenticated webhook call is refused, not unrouted",
    async () => {
      const definitionId = await publishTriggerable(writerToken!);

      const { status } = await postWebhook(null, definitionId);

      // 401 rather than 404 is the whole assertion. Before the module
      // contributed `restRoutes` this path did not exist, and an unmounted
      // route answers 404 — which is also what a *mounted* route would answer
      // for a bad definition id, so authentication is the axis that separates
      // "not wired" from "wired and guarding".
      expect(status).toBe(401);
    },
    TEST_TIMEOUT,
  );

  httpTest(
    "a webhook call without the writer role is refused",
    async () => {
      const definitionId = await publishTriggerable(writerToken!);

      // Same tenant as the writer, no roles — so the refusal is attributable to
      // the role rather than to tenant isolation.
      const { status } = await postWebhook(rolelessToken!, definitionId);

      expect(status).toBe(403);
    },
    TEST_TIMEOUT,
  );
});
