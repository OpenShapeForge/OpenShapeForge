// SPDX-License-Identifier: BUSL-1.1
/**
 * The workflow definition lifecycle, driven over the assembled GraphQL schema.
 *
 * `workflow.definitions` and `workflow.definition_versions` are declared
 * `domainInternal` / `generatedCrud: false`, so nothing the generic entity
 * engine enforces applies to them. Every property below lives in the module's
 * resolvers instead of in a column, which means the only place it can be
 * observed is the schema those resolvers are spliced into. That is why this
 * file builds the schema the way boot does — `loadRuntimeModules` →
 * `initRuntimeModules` → `buildGraphqlSchema` — rather than calling the module
 * functions directly: a correct module wired into the schema wrongly is
 * indistinguishable from a broken one to a client, and only the composed
 * surface can tell the two apart.
 *
 * ## What it proves
 *
 * - Version numbers are assigned by the server, monotonic, and append-only: a
 *   save never rewrites a stored graph, so an earlier version still answers
 *   with the document it was saved with.
 * - `triggerTypes` is DERIVED from the published graph rather than stored. A
 *   draft that adds a trigger must not change what a list says can start this
 *   workflow, or a definition would advertise behaviour nothing can execute.
 * - "Latest published" is not "latest". A draft saved after a publish sits
 *   above it, and a run that started from it would execute unpublished work.
 * - Archiving is soft and permanent deletion refuses a definition that has
 *   runs — the two exist precisely so that removing a definition never erases
 *   the history of what already ran under it. The refusal is asserted on
 *   `extensions.code`; the message is for humans and free to change.
 * - Nothing crosses a tenant. That is the RLS policy and the explicit
 *   `tenant_id` predicate together, and it is the assertion here that matters
 *   most, because its failure mode is silent: a leak returns rows, not errors.
 *
 * ## Why this file carries its own harness
 *
 * `e2e/harness.ts` drives graphql-yoga against the shared development database
 * and cleans up by calling each generated entity's delete mutation. These
 * tables have no generated CRUD to clean up through, and the suite needs a
 * database it can migrate and seed from empty — `triggerTypes` and the tenant
 * assertions both read whole lists, which a shared database makes meaningless.
 * So it follows the scratch-database pattern from
 * `db/__tests__/workflow-catalogs-seed.test.ts` instead: create a throwaway
 * database through the admin URL, migrate it, drop it at the end. The live
 * openshapeforge_dev database is never touched.
 *
 * The catalog seeds reach the chain through the runtime module contract, so
 * they are collected from the loaded modules and handed to `runMigrationChain`
 * (see `db/__tests__/module-seeds.test.ts`). They are not optional here:
 * `init` hydrates the node catalog from those rows, and publish validates
 * against it — an unseeded catalog would leave the validator resolving every
 * node type to "unknown", which it records as a warning, so publish would pass
 * while checking nothing.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/graphql/__tests__/workflow-definitions.e2e.test.ts 2>&1
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { assertObjectType, graphql, type GraphQLSchema } from "graphql";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { withDbSession } from "../../db/session.js";
import { initRuntimeModules, loadRuntimeModules } from "../../modules/registry.js";
import { buildGraphqlSchema } from "../schema.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const TEST_TIMEOUT = 90_000;

/**
 * The realm role that may author workflows at all, checked before any
 * per-definition ACL (`WORKFLOW_WRITER_ROLES` in `definition-authorization.ts`).
 * Without it every write below is FORBIDDEN, whatever the ACL says.
 */
const WRITER_ROLE = "directie";

// ---------------------------------------------------------------------------
// Scratch database, module registry, schema
// ---------------------------------------------------------------------------

type Suite = {
  admin: SQL;
  database: string;
  runtime: DatabaseRuntime;
  schema: GraphQLSchema;
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
  const database = `wfdef_e2e_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(database)) {
    throw new Error(`unsafe scratch database name: ${database}`);
  }

  const admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${database}"`);

  const runtime = createDatabaseRuntime({
    databaseUrl: scratchUrl(database),
    maxConnections: 4,
  });

  const modules = await loadRuntimeModules();
  expect(modules.failures).toEqual([]);

  const moduleSeeds = modules.loaded.flatMap((module) => module.seeds ?? []);
  await runtime.db.connection().execute((conn) => runMigrationChain(conn, { moduleSeeds }));

  // A module that fails to initialise is dropped from `loaded`, and its
  // surfaces would then be absent from the schema — every test in this file
  // would fail on an unknown field rather than on what it set out to check.
  const initialized = await initRuntimeModules(modules, { db: runtime.db });
  expect(initialized.failures).toEqual([]);
  expect(initialized.loaded.map((module) => module.name)).toContain("workflow");

  return {
    admin,
    database,
    runtime,
    schema: buildGraphqlSchema(initialized.loaded, { db: runtime.db }),
  };
}

async function stopSuite(): Promise<void> {
  if (!suite) return;
  await suite.runtime.close();
  await suite.admin.unsafe(`drop database if exists "${suite.database}" with (force)`);
  await suite.admin.close();
}

// ---------------------------------------------------------------------------
// Sessions and transport
// ---------------------------------------------------------------------------

type WorkflowSession = {
  tenantId: string;
  userId: string;
  roles: string[];
  groups: string[];
  scope: "tenant";
};

/**
 * A writer identity, in a tenant of its own.
 *
 * The ids are generated rather than written out: `createDbSessionContext`
 * validates the version and variant nibbles before it will set the tenant GUC,
 * so a hand-typed placeholder is refused outright. A fresh tenant per test also
 * keeps one test's definitions out of another's list reads, which several of
 * these assertions depend on being exact.
 */
function writerSession(): WorkflowSession {
  return {
    tenantId: randomUUID(),
    userId: randomUUID(),
    roles: [WRITER_ROLE],
    groups: [],
    scope: "tenant",
  };
}

async function execute(
  session: WorkflowSession,
  source: string,
  variableValues: Record<string, unknown> = {},
) {
  return graphql({
    schema: suite.schema,
    source,
    contextValue: { db: suite.runtime.db, session },
    variableValues,
  });
}

async function expectData(
  session: WorkflowSession,
  source: string,
  variableValues: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const result = await execute(session, source, variableValues);
  // Messages rather than the GraphQLError objects: a failure here should print
  // what went wrong, not a structural diff of an error class.
  expect(result.errors?.map((error) => error.message) ?? []).toEqual([]);
  expect(result.data).toBeTruthy();
  return result.data as Record<string, any>;
}

/** The `extensions.code` of the first error, for the paths that must refuse. */
async function expectErrorCode(
  session: WorkflowSession,
  source: string,
  variableValues: Record<string, unknown> = {},
): Promise<unknown> {
  const result = await execute(session, source, variableValues);
  expect(result.errors?.length ?? 0).toBeGreaterThan(0);
  return result.errors?.[0]?.extensions?.code;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

const DEFINITION_FIELDS = /* GraphQL */ `
  fragment DefinitionFields on WorkflowDefinition {
    id
    name
    category
    isActive
    createdAt
    updatedAt
    triggerTypes
    publishedVersion
    latestVersion
  }
`;

const VERSION_FIELDS = /* GraphQL */ `
  fragment VersionFields on WorkflowDefinitionVersion {
    id
    definitionId
    version
    definition
    publishedAt
    publishedBy
    changelog
    createdAt
  }
`;

const CREATE_DEFINITION = /* GraphQL */ `
  ${DEFINITION_FIELDS}
  mutation CreateDefinition($input: CreateWorkflowDefinitionInput!) {
    createWorkflowDefinition(input: $input) {
      ...DefinitionFields
    }
  }
`;

const SAVE_VERSION = /* GraphQL */ `
  ${DEFINITION_FIELDS}
  mutation SaveVersion($input: SaveWorkflowDefinitionVersionInput!) {
    saveWorkflowDefinitionVersion(input: $input) {
      ...DefinitionFields
    }
  }
`;

const PUBLISH_VERSION = /* GraphQL */ `
  ${VERSION_FIELDS}
  mutation PublishVersion($input: PublishWorkflowDefinitionVersionInput!) {
    publishWorkflowDefinitionVersion(input: $input) {
      ...VersionFields
    }
  }
`;

const ARCHIVE_DEFINITION = /* GraphQL */ `
  ${DEFINITION_FIELDS}
  mutation ArchiveDefinition($definitionId: ID!) {
    archiveWorkflowDefinition(definitionId: $definitionId) {
      ...DefinitionFields
    }
  }
`;

const DELETE_DEFINITION = /* GraphQL */ `
  mutation DeleteDefinition($definitionId: ID!) {
    deleteWorkflowDefinitionPermanently(definitionId: $definitionId)
  }
`;

const DEFINITION_BY_ID = /* GraphQL */ `
  ${DEFINITION_FIELDS}
  query DefinitionById($id: ID!) {
    workflowDefinition(id: $id) {
      ...DefinitionFields
    }
  }
`;

const LIST_DEFINITIONS = /* GraphQL */ `
  ${DEFINITION_FIELDS}
  query ListDefinitions {
    workflowDefinitions {
      ...DefinitionFields
    }
  }
`;

// Spelled out rather than fragment-shared: WorkflowDefinitionVersionSummary is
// a different type from WorkflowDefinitionVersion precisely because it has no
// `definition`, and reusing one selection set would hide that.
const LIST_VERSIONS = /* GraphQL */ `
  query ListVersions($definitionId: ID!) {
    workflowDefinitionVersions(definitionId: $definitionId) {
      id
      definitionId
      version
      publishedAt
      publishedBy
      changelog
      createdAt
    }
  }
`;

const VERSION_BY_NUMBER = /* GraphQL */ `
  ${VERSION_FIELDS}
  query VersionByNumber($definitionId: ID!, $version: Int!) {
    workflowDefinitionVersion(definitionId: $definitionId, version: $version) {
      ...VersionFields
    }
  }
`;

const LATEST_PUBLISHED_VERSION = /* GraphQL */ `
  ${VERSION_FIELDS}
  query LatestPublishedVersion($definitionId: ID!) {
    latestPublishedWorkflowDefinitionVersion(definitionId: $definitionId) {
      ...VersionFields
    }
  }
`;

// ---------------------------------------------------------------------------
// Records and graphs
// ---------------------------------------------------------------------------

type Definition = {
  id: string;
  name: string;
  category: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  triggerTypes: string[];
  publishedVersion: number | null;
  latestVersion: number | null;
};

type VersionSummary = {
  id: string;
  definitionId: string;
  version: number;
  publishedAt: string | null;
  publishedBy: string | null;
  changelog: string | null;
  createdAt: string;
};

type Version = VersionSummary & {
  definition: { nodes: { id: string; type: string }[]; edges: unknown[] };
};

/**
 * Graphs that publish cleanly: unique node ids, a type the catalog knows on
 * every node, both ends of every edge resolving to a node. Publish refuses a
 * graph the validator reports an error for, so a carelessly assembled document
 * here would fail these tests for a reason unrelated to what they test.
 */
const TRIGGERED_GRAPH = {
  name: "triggered",
  version: "1",
  nodes: [
    { id: "start", type: "triggerManual", position: { x: 0, y: 0 } },
    { id: "finish", type: "end", position: { x: 240, y: 0 } },
  ],
  edges: [{ id: "start-finish", source: "start", target: "finish" }],
};

/** The same, minus anything `isTriggerNodeType` matches. */
const UNTRIGGERED_GRAPH = {
  name: "untriggered",
  version: "1",
  nodes: [{ id: "finish", type: "end", position: { x: 0, y: 0 } }],
  edges: [],
};

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function createDefinition(
  session: WorkflowSession,
  name: string,
): Promise<Definition> {
  const data = await expectData(session, CREATE_DEFINITION, { input: { name } });
  return data.createWorkflowDefinition as Definition;
}

/**
 * Append a version, presenting the definition's own `updatedAt` as the
 * optimistic-concurrency token. Taking it off the record rather than passing it
 * separately is what makes a chain of saves in a test read like a chain of
 * saves from a client.
 */
async function saveVersion(
  session: WorkflowSession,
  definition: Definition,
  graph: unknown,
  changelog?: string,
): Promise<Definition> {
  const data = await expectData(session, SAVE_VERSION, {
    input: {
      definitionId: definition.id,
      expectedUpdatedAt: definition.updatedAt,
      definition: graph,
      ...(changelog === undefined ? {} : { changelog }),
    },
  });
  return data.saveWorkflowDefinitionVersion as Definition;
}

async function publishVersion(
  session: WorkflowSession,
  definitionId: string,
  version: number,
): Promise<Version> {
  const data = await expectData(session, PUBLISH_VERSION, {
    input: { definitionId, version },
  });
  return data.publishWorkflowDefinitionVersion as Version;
}

async function readDefinition(
  session: WorkflowSession,
  id: string,
): Promise<Definition | null> {
  const data = await expectData(session, DEFINITION_BY_ID, { id });
  return data.workflowDefinition as Definition | null;
}

/** The same read, for the callers that would have to assert non-null anyway. */
async function rereadDefinition(
  session: WorkflowSession,
  id: string,
): Promise<Definition> {
  const definition = await readDefinition(session, id);
  if (!definition) throw new Error(`workflow definition ${id} is not readable`);
  return definition;
}

async function listDefinitions(session: WorkflowSession): Promise<Definition[]> {
  const data = await expectData(session, LIST_DEFINITIONS);
  return data.workflowDefinitions as Definition[];
}

async function listVersions(
  session: WorkflowSession,
  definitionId: string,
): Promise<VersionSummary[]> {
  const data = await expectData(session, LIST_VERSIONS, { definitionId });
  return data.workflowDefinitionVersions as VersionSummary[];
}

async function readVersion(
  session: WorkflowSession,
  definitionId: string,
  version: number,
): Promise<Version | null> {
  const data = await expectData(session, VERSION_BY_NUMBER, { definitionId, version });
  return data.workflowDefinitionVersion as Version | null;
}

async function readLatestPublishedVersion(
  session: WorkflowSession,
  definitionId: string,
): Promise<Version | null> {
  const data = await expectData(session, LATEST_PUBLISHED_VERSION, { definitionId });
  return data.latestPublishedWorkflowDefinitionVersion as Version | null;
}

function nodeTypesOf(version: Version | null): string[] {
  return (version?.definition.nodes ?? []).map((node) => node.type);
}

/**
 * Assert a nullable field is present and narrow it, for the assertions that go
 * on to compare it. `expect(...).not.toBeNull()` proves the same thing but does
 * not narrow, and the comparison would then be against `string | null`.
 */
function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

/**
 * A run of a definition, inserted directly.
 *
 * No mutation starts one — this deployment ships no engine — and what makes the
 * permanent delete refuse is precisely the existence of a `workflow.instances`
 * row, so the row is what the test needs. It goes in through `withDbSession`
 * because the table carries FORCE ROW LEVEL SECURITY: an insert outside a
 * tenant-scoped transaction is rejected by the policy, not merely unscoped.
 */
async function insertInstance(
  session: WorkflowSession,
  definitionId: string,
): Promise<string> {
  return withDbSession(suite.runtime.db, session, async (trx, scoped) => {
    const row = await trx
      .insertInto("workflow.instances")
      .values({
        tenant_id: scoped.tenantId,
        definition_id: definitionId,
        started_by: scoped.userId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  });
}

async function deleteInstance(
  session: WorkflowSession,
  instanceId: string,
): Promise<void> {
  await withDbSession(suite.runtime.db, session, async (trx, scoped) => {
    await trx
      .deleteFrom("workflow.instances")
      .where("tenant_id", "=", scoped.tenantId)
      .where("id", "=", instanceId)
      .execute();
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

beforeAll(async () => {
  suite = await startSuite();
}, TEST_TIMEOUT);

afterAll(async () => {
  await stopSuite();
}, TEST_TIMEOUT);

describe("workflow definitions", () => {
  test(
    "a definition is created empty, versioned by a save, and stamped by a publish",
    async () => {
      const session = writerSession();
      const created = await createDefinition(session, "order intake");

      // Nothing has been saved, so there is no graph to be latest or published.
      // Reporting 0 here instead of null would make "never saved" and "version
      // zero exists" the same answer.
      expect(created.latestVersion).toBeNull();
      expect(created.publishedVersion).toBeNull();
      expect(created.isActive).toBe(true);
      expect(created.category).toBe("process");

      const saved = await saveVersion(session, created, TRIGGERED_GRAPH);
      expect(saved.latestVersion).toBe(1);
      // A save appends a DRAFT: publishing is a separate decision, and a save
      // that published implicitly would put unreviewed work in front of runs.
      expect(saved.publishedVersion).toBeNull();
      // `updatedAt` is the optimistic-concurrency token; if a save left it
      // unchanged the same token could be replayed against a row that moved.
      expect(saved.updatedAt).not.toBe(created.updatedAt);

      const published = await publishVersion(session, created.id, 1);
      expect(published.version).toBe(1);
      expect(published.publishedBy).toBe(session.userId);
      // Publishing is what stamps this; a saved draft leaves it null.
      const publishedAt = requireValue(published.publishedAt, "publishedAt");

      const read = await rereadDefinition(session, created.id);
      expect(read.latestVersion).toBe(1);
      expect(read.publishedVersion).toBe(1);
      // Compared as an instant, because the two paths do NOT agree on the
      // string. `selectDefinitions` casts `created_at` to text and keeps the
      // microseconds the column default stored; the write path's
      // `loadDefinitionRecord` selects it raw and the driver truncates to
      // milliseconds. `updated_at` escapes that only because every write stamps
      // it with a millisecond-precision JS Date — `created_at` has no such
      // stamp, so one row reports two `createdAt` strings depending on which
      // resolver answered. Asserting the instant fails on a real divergence
      // without freezing that discrepancy in as expected behaviour.
      expect(Date.parse(read.createdAt)).toBe(Date.parse(created.createdAt));
      // Publishing set the definition's `updated_at` and the version's
      // `published_at` from one stamp. The read path casts the column to text
      // while the write path lets the driver hand back a Date, so the two
      // agreeing here is what makes a token survive a read/save round trip —
      // the microsecond-truncation regression the write path guards against.
      expect(read.updatedAt).toBe(publishedAt);
    },
    TEST_TIMEOUT,
  );

  test(
    "triggerTypes is derived from the published graph, not from the latest draft",
    async () => {
      const session = writerSession();

      const triggered = await createDefinition(session, "manually triggered");
      const savedTriggered = await saveVersion(session, triggered, TRIGGERED_GRAPH);
      // Saved but not published. The trigger exists in a draft and must not
      // count yet, which is the whole distinction between derived-from-published
      // and stored-on-the-definition.
      expect(savedTriggered.triggerTypes).toEqual([]);

      await publishVersion(session, triggered.id, 1);
      expect((await rereadDefinition(session, triggered.id)).triggerTypes).toEqual([
        "triggerManual",
      ]);

      const untriggered = await createDefinition(session, "no trigger at all");
      const savedUntriggered = await saveVersion(session, untriggered, UNTRIGGERED_GRAPH);
      await publishVersion(session, untriggered.id, 1);
      // Published, valid, and startable by nothing: the validator does not
      // require a trigger, so an empty list is a real state and not a miss.
      expect((await rereadDefinition(session, untriggered.id)).triggerTypes).toEqual([]);
      expect(savedUntriggered.latestVersion).toBe(1);
    },
    TEST_TIMEOUT,
  );

  test(
    "successive saves number versions 1, 2, 3",
    async () => {
      const session = writerSession();
      let definition = await createDefinition(session, "monotonic");

      const assigned: (number | null)[] = [];
      for (const step of [1, 2, 3]) {
        // Each save presents the token the previous one returned. A stale token
        // is CONCURRENT_MODIFICATION, so this loop completing at all is half the
        // assertion: every save handed back a fresh token.
        definition = await saveVersion(session, definition, {
          ...UNTRIGGERED_GRAPH,
          version: `draft-${step}`,
        });
        assigned.push(definition.latestVersion);
      }

      expect(assigned).toEqual([1, 2, 3]);
      // The server assigns the number; nothing in the document does. Three saves
      // of the same graph still produce three distinct versions.
      expect((await listVersions(session, definition.id)).map((entry) => entry.version)).toEqual(
        [3, 2, 1],
      );
    },
    TEST_TIMEOUT,
  );

  test(
    "the version list carries no graphs, and one version's graph is fetched by number",
    async () => {
      const session = writerSession();
      let definition = await createDefinition(session, "history");
      definition = await saveVersion(session, definition, UNTRIGGERED_GRAPH, "first");
      definition = await saveVersion(session, definition, TRIGGERED_GRAPH, "second");

      // Structural, not incidental: the summary type has no `definition` field
      // at all, so opening a history panel cannot be made to fetch every draft
      // document a definition ever accumulated.
      const summary = assertObjectType(
        suite.schema.getType("WorkflowDefinitionVersionSummary"),
      );
      const summaryFields = Object.keys(summary.getFields());
      expect(summaryFields).toContain("version");
      expect(summaryFields).not.toContain("definition");

      const listed = await listVersions(session, definition.id);
      expect(listed.map((entry) => entry.version)).toEqual([2, 1]);
      expect(listed.map((entry) => entry.changelog)).toEqual(["second", "first"]);
      expect(listed.every((entry) => entry.publishedAt === null)).toBe(true);

      // Version 1 still holds the graph it was saved with: the second save
      // appended a row rather than rewriting the first one.
      expect(nodeTypesOf(await readVersion(session, definition.id, 1))).toEqual(["end"]);
      expect(nodeTypesOf(await readVersion(session, definition.id, 2))).toEqual([
        "triggerManual",
        "end",
      ]);
    },
    TEST_TIMEOUT,
  );

  test(
    "latestPublishedWorkflowDefinitionVersion returns the published version, not the newest",
    async () => {
      const session = writerSession();
      const created = await createDefinition(session, "published then drafted");
      await saveVersion(session, created, TRIGGERED_GRAPH, "v1");
      await publishVersion(session, created.id, 1);

      // Publishing moved `updated_at`, so the token held above is stale; a
      // client would re-read here for the same reason.
      const afterPublish = await rereadDefinition(session, created.id);
      const afterDraft = await saveVersion(session, afterPublish, UNTRIGGERED_GRAPH, "v2");
      expect(afterDraft.latestVersion).toBe(2);
      expect(afterDraft.publishedVersion).toBe(1);

      const runnable = await readLatestPublishedVersion(session, created.id);
      expect(runnable).not.toBeNull();
      // Version 2 is newer and unpublished. Returning it would start runs on a
      // draft — the one failure this query exists to prevent.
      expect(runnable?.version).toBe(1);
      expect(runnable?.publishedAt).not.toBeNull();
      expect(nodeTypesOf(runnable)).toEqual(["triggerManual", "end"]);
    },
    TEST_TIMEOUT,
  );

  test(
    "archiving hides a definition from every read while keeping the row",
    async () => {
      const session = writerSession();
      const created = await createDefinition(session, "to be archived");
      expect((await listDefinitions(session)).map((entry) => entry.id)).toEqual([created.id]);

      const data = await expectData(session, ARCHIVE_DEFINITION, {
        definitionId: created.id,
      });
      const archived = data.archiveWorkflowDefinition as Definition;
      // The mutation still returns the record, flagged inactive. That the row
      // survives at all is the entire difference between archive and delete,
      // and it is why instances that pinned this definition keep resolving.
      expect(archived.isActive).toBe(false);
      expect(archived.id).toBe(created.id);

      expect(await listDefinitions(session)).toEqual([]);
      expect(await readDefinition(session, created.id)).toBeNull();
    },
    TEST_TIMEOUT,
  );

  test(
    "permanent deletion refuses a definition that has a run, and succeeds once it has none",
    async () => {
      const session = writerSession();
      const created = await createDefinition(session, "has a run");
      const definition = await saveVersion(session, created, TRIGGERED_GRAPH);

      const instanceId = await insertInstance(session, definition.id);

      // The code, not the sentence. `runDefinitionOperation` maps the module's
      // closed error union onto extensions.code precisely so a client branches
      // on that; matching the message would couple this test to wording the
      // implementation is free to change.
      expect(
        await expectErrorCode(session, DELETE_DEFINITION, { definitionId: definition.id }),
      ).toBe("CONFLICT");
      // The refusal is total: nothing was deleted on the way to raising it.
      expect(await readDefinition(session, definition.id)).not.toBeNull();

      await deleteInstance(session, instanceId);

      const deleted = await expectData(session, DELETE_DEFINITION, {
        definitionId: definition.id,
      });
      expect(deleted.deleteWorkflowDefinitionPermanently).toBe(true);
      expect(await readDefinition(session, definition.id)).toBeNull();
      // Versions cascade with the definition; the history query answers for a
      // definition that no longer exists with nothing rather than an error.
      expect(await listVersions(session, definition.id)).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  test(
    "a definition belongs to its tenant and is invisible to another",
    async () => {
      const tenantA = writerSession();
      const tenantB = writerSession();

      const created = await createDefinition(tenantA, "tenant A only");

      // The control. Without it an empty result for tenant B could equally mean
      // the create failed, and the test would pass while proving nothing.
      expect((await listDefinitions(tenantA)).map((entry) => entry.id)).toEqual([created.id]);
      expect(await readDefinition(tenantA, created.id)).not.toBeNull();

      // The RLS policy and the explicit tenant predicate, together. A leak here
      // returns rows rather than errors, so nothing else in the system would
      // report it.
      expect(await listDefinitions(tenantB)).toEqual([]);
      expect(await readDefinition(tenantB, created.id)).toBeNull();
    },
    TEST_TIMEOUT,
  );
});
