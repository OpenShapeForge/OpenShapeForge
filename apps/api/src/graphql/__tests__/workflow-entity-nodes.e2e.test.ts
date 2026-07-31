// SPDX-License-Identifier: BUSL-1.1
/**
 * The generated entity node bridges, driven end to end by the engine.
 *
 * `generated-entity-bridges.ts` is the only part of this runtime that touches
 * business data; everything else a workflow can do is flow control. Those
 * fifteen node types reach `erp.*` by composing SQL from the compiler's
 * manifest rather than by going through the generic CRUD engine, so nothing
 * that guards the generic path guards them: not the entity resolvers' tenant
 * predicate, not their column allowlist, not their authorization. What holds
 * instead is whatever this one module writes, plus the database session it
 * happens to be executing inside — and only a real run can show whether both
 * are in place at once.
 *
 * So every claim below is checked against `erp.relations` with a direct query,
 * never against the node's own report of what it did. Definitions are authored
 * and published over the GraphQL surface, started as control commands, and
 * dispatched in process, because a bridge that works when called directly and
 * fails when the engine calls it is the failure worth catching.
 *
 * ## What it proves
 *
 * - A create node writes a row that is there afterwards, and hands its id
 *   downstream in `shared_output`. A config-supplied `tenantId` cannot redirect
 *   that write.
 * - `{{nodes.<id>.output.id}}` resolves into a later node's `recordId`. The
 *   engine's placeholder resolver and the bridge's output shape live in
 *   different modules and agree only by convention; renaming either one breaks
 *   every multi-node entity graph, and nothing else in the suite would notice.
 * - A filter condition compiles to SQL that selects the row it names, and the
 *   list node's output handle — `none` / `one` / `many` — is the count, which
 *   is why routing a list is also asserting how many rows came back.
 * - Update and delete are observable in the table, not merely reported.
 * - **A run under one tenant cannot read, list or remove another tenant's
 *   row.** This is the assertion that matters most in this file. Because the
 *   bridges build their own SQL, the only things standing between them and a
 *   cross-tenant read are the explicit `tenant_id` predicate this module adds
 *   and the RLS policy on the table. A defect in either returns rows rather
 *   than errors, so nothing else in the system would report it.
 * - A bridge that throws fails its node and, through the ordinary cascade, its
 *   run — rather than being skipped or swallowed.
 *
 * ## Harness
 *
 * A throwaway database per run, migrated with the module seeds, following
 * `workflow-definitions.e2e.test.ts` for the reasons given there: these tables
 * carry no generated CRUD to clean up through, and the list assertions are only
 * meaningful against a database whose whole contents this file accounts for.
 *
 * The dispatcher is reached through a computed import specifier. `apps/api` sets
 * `rootDir: src`, so a static import of anything under `examples/` fails the API
 * typecheck. The specifier resolves to the same absolute file
 * `loadRuntimeModules` imported during init, so the bridge registry a run reads
 * is the one initialisation filled — a second copy of that module graph would
 * present an empty registry and every node would fail with NO_BRIDGE.
 *
 * A run is started by writing its two rows here rather than by calling the
 * shipped `enqueueWorkflowInstanceStart`, and that is a workaround for a defect
 * rather than a shortcut. `enqueueWorkflowInstanceStartInTransaction` sets
 * `workflow_key` on the instance, and `workflow.instances` has no such column —
 * not in the plugin's table declaration and not in the generated types. The
 * statement is raw SQL, so nothing typechecks it, and every start path funnels
 * through that one function, so no run can currently be started at all.
 * `enqueueStartCommand` below writes what it intends to write, minus the column
 * that does not exist, and the dispatcher then receives the same command payload
 * it would have been handed. Delete it once the column exists.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/graphql/__tests__/workflow-entity-nodes.e2e.test.ts 2>&1
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { graphql, type GraphQLSchema } from "graphql";
import {
  createDatabaseRuntime,
  type DatabaseRuntime,
  type OpenShapeForgeDatabase,
} from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { withDbSession } from "../../db/session.js";
import { initRuntimeModules, loadRuntimeModules } from "../../modules/registry.js";
import { buildGraphqlSchema } from "../schema.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const TEST_TIMEOUT = 90_000;

/** The realm role that may author workflows and enqueue runs at all. */
const WRITER_ROLE = "directie";

/**
 * The node types under test, spelled exactly as
 * `generated/workflow/entity-workflow-nodes.generated.json` emits them. Relation
 * is the one entity the shipped authoring layer opts into workflow nodes for.
 */
const CREATE_NODE = "entity.core.relation.create";
const GET_ONE_NODE = "entity.core.relation.getOne";
const LIST_NODE = "entity.core.relation.list";
const UPDATE_NODE = "entity.core.relation.update";
const DELETE_NODE = "entity.core.relation.delete";

// ---------------------------------------------------------------------------
// The workflow runtime, loaded by path
// ---------------------------------------------------------------------------

/** One claimed control command, in the shape the dispatcher reads. */
type ControlCommand = {
  id: string;
  tenantId: string;
  commandType: string;
  workflowInstanceId: string;
  idempotencyKey: string | null;
  payload: Record<string, unknown>;
  attempts: number;
};

type DispatchCommand = (command: ControlCommand) => Promise<void>;

async function loadDispatch(db: OpenShapeForgeDatabase): Promise<DispatchCommand> {
  const runtimeDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../examples/plugins/workflow/runtime",
  );
  // Held in a variable so the specifier is not a literal: a literal would make
  // tsc resolve a file outside `rootDir` and fail the API typecheck.
  const workerSpecifier = `${runtimeDir}/control-command-worker.ts`;
  const worker = (await import(workerSpecifier)) as Record<string, unknown>;
  const createDispatcher = worker.createInProcessWorkflowControlCommandDispatcher as (
    db: OpenShapeForgeDatabase,
  ) => { dispatch: DispatchCommand };
  return createDispatcher(db).dispatch;
}

// ---------------------------------------------------------------------------
// Scratch database, module registry, schema
// ---------------------------------------------------------------------------

type Suite = {
  admin: SQL;
  database: string;
  runtime: DatabaseRuntime;
  schema: GraphQLSchema;
  dispatch: DispatchCommand;
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
  const database = `wfentity_e2e_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

  // `init` is what registers the entity bridges. A module dropped here would
  // leave every node in this file failing with NO_BRIDGE rather than with
  // whatever it set out to check.
  const initialized = await initRuntimeModules(modules, { db: runtime.db });
  expect(initialized.failures).toEqual([]);
  expect(initialized.loaded.map((module) => module.name)).toContain("workflow");

  return {
    admin,
    database,
    runtime,
    schema: buildGraphqlSchema(initialized.loaded, { db: runtime.db }),
    dispatch: await loadDispatch(runtime.db),
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
 * A writer identity in a tenant of its own.
 *
 * The ids are generated rather than written out: `createDbSessionContext`
 * checks the version and variant nibbles before it will set the tenant GUC, so
 * a hand-typed placeholder is refused outright. A fresh tenant per test also
 * keeps one test's relations out of another's list reads, which every count
 * assertion below depends on.
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

async function expectData(
  session: WorkflowSession,
  source: string,
  variableValues: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const result = await graphql({
    schema: suite.schema,
    source,
    contextValue: { db: suite.runtime.db, session },
    variableValues,
  });
  // Messages rather than the GraphQLError objects: a failure here should print
  // what went wrong, not a structural diff of an error class.
  expect(result.errors?.map((error) => error.message) ?? []).toEqual([]);
  expect(result.data).toBeTruthy();
  return result.data as Record<string, any>;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

const CREATE_DEFINITION = /* GraphQL */ `
  mutation CreateDefinition($input: CreateWorkflowDefinitionInput!) {
    createWorkflowDefinition(input: $input) {
      id
      updatedAt
    }
  }
`;

const SAVE_VERSION = /* GraphQL */ `
  mutation SaveVersion($input: SaveWorkflowDefinitionVersionInput!) {
    saveWorkflowDefinitionVersion(input: $input) {
      id
      latestVersion
      updatedAt
    }
  }
`;

const PUBLISH_VERSION = /* GraphQL */ `
  mutation PublishVersion($input: PublishWorkflowDefinitionVersionInput!) {
    publishWorkflowDefinitionVersion(input: $input) {
      version
      publishedAt
    }
  }
`;

// ---------------------------------------------------------------------------
// Graphs
// ---------------------------------------------------------------------------

type GraphNode = { id: string; type: string; config?: Record<string, unknown> };
type GraphEdge = { id: string; source: string; target: string; sourceHandle?: string };

function graphOf(name: string, nodes: GraphNode[], edges: GraphEdge[]) {
  return { name, version: "1", nodes, edges };
}

/**
 * A trigger, one entity node, and an end — the smallest graph that executes a
 * bridge. The handles are the caller's because they are the node's answer, not
 * a property of the shape: every entity action emits `default` except `list`,
 * whose handle reports how many rows matched.
 */
function singleNodeGraph(
  name: string,
  node: GraphNode,
  handles: string[] = ["default"],
) {
  return graphOf(
    name,
    [{ id: "start", type: "triggerManual" }, node, { id: "finish", type: "end" }],
    [
      { id: "start-node", source: "start", target: node.id },
      ...handles.map((handle) => ({
        id: `${node.id}-finish-${handle}`,
        source: node.id,
        sourceHandle: handle,
        target: "finish",
      })),
    ],
  );
}

/**
 * A filter condition in the shape `compileCondition` accepts: a group of rules,
 * each with a path operand on the left and a literal on the right.
 *
 * The `entityData.` prefix is load-bearing in two places at once. The engine's
 * config resolver leaves such operands alone instead of trying to look them up
 * as run variables, and the bridge's `readPath` strips the prefix to get the
 * field name — so the same string tells one module "not yours" and the other
 * "this column".
 */
function equalsFilter(field: string, value: string) {
  return {
    kind: "group",
    mode: "all",
    conditions: [
      {
        kind: "rule",
        left: { kind: "path", path: `entityData.${field}` },
        operator: "equals",
        right: { kind: "literal", value },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Running a workflow
// ---------------------------------------------------------------------------

type NodeState = {
  nodeType: string;
  status: string;
  /** The config the engine handed the bridge, after placeholder resolution. */
  resolvedParameters: Record<string, unknown>;
  sharedOutput: Record<string, unknown>;
  error: Record<string, unknown> | null;
};

type Run = {
  instanceId: string;
  status: string;
  error: Record<string, unknown> | null;
  nodes: Map<string, NodeState>;
};

/**
 * jsonb arrives parsed from the driver, but a column that stored a document as
 * text still hands back a string; both readings are accepted so an assertion
 * fails on the value rather than on its encoding.
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value === null || value === undefined ? null : asRecord(value);
}

/** Publish a graph and return the definition it belongs to. */
async function publishGraph(
  session: WorkflowSession,
  name: string,
  graph: unknown,
): Promise<string> {
  const created = await expectData(session, CREATE_DEFINITION, { input: { name } });
  const definition = created.createWorkflowDefinition as { id: string; updatedAt: string };

  const saved = await expectData(session, SAVE_VERSION, {
    input: {
      definitionId: definition.id,
      expectedUpdatedAt: definition.updatedAt,
      definition: graph,
    },
  });
  expect((saved.saveWorkflowDefinitionVersion as { latestVersion: number }).latestVersion).toBe(1);

  const published = await expectData(session, PUBLISH_VERSION, {
    input: { definitionId: definition.id, version: 1 },
  });
  expect((published.publishWorkflowDefinitionVersion as { version: number }).version).toBe(1);

  return definition.id;
}

/**
 * Write the two rows a start is: an instance in `starting` and a pending
 * `workflow.instance.start` command. Nothing has executed when this returns.
 *
 * This stands in for `enqueueWorkflowInstanceStart`, which cannot run at all —
 * see the note on `workflow_key` in the header. The payload is read back out of
 * the queue rather than returned from memory, so it has been through `jsonb`
 * exactly as a dispatched command's would be.
 */
async function enqueueStartCommand(
  session: WorkflowSession,
  definitionId: string,
): Promise<{ instanceId: string; command: ControlCommand }> {
  return withDbSession(suite.runtime.db, session, async (trx, scoped) => {
    const version = await trx
      .selectFrom("workflow.definitions as d")
      .innerJoin("workflow.definition_versions as v", (join) =>
        join.onRef("v.definition_id", "=", "d.id").onRef("v.tenant_id", "=", "d.tenant_id"),
      )
      .select(["d.name", "v.id as version_id", "v.version"])
      .where("d.tenant_id", "=", scoped.tenantId)
      .where("d.id", "=", definitionId)
      .where("d.is_active", "=", true)
      .where("v.published_at", "is not", null)
      .orderBy("v.version", "desc")
      .limit(1)
      .executeTakeFirstOrThrow();

    const instanceId = randomUUID();
    const commandId = randomUUID();

    await trx
      .insertInto("workflow.instances")
      .values({
        id: instanceId,
        tenant_id: scoped.tenantId,
        definition_id: definitionId,
        version_id: version.version_id,
        status: "starting",
        started_by: scoped.userId,
        definition_version: version.version,
        definition_name: version.name,
        trigger_type: "manual",
      })
      .execute();

    await trx
      .insertInto("workflow.control_commands")
      .values({
        id: commandId,
        tenant_id: scoped.tenantId,
        command_type: "workflow.instance.start",
        workflow_instance_id: instanceId,
        status: "pending",
        payload: {
          instanceId,
          definitionId,
          versionId: version.version_id,
          version: version.version,
          definitionName: version.name,
          context: {},
          initialProcessVariables: {},
          triggerType: "manual",
          triggerMeta: {},
          signalDepth: 0,
          entityType: null,
          entityId: null,
          parentInstanceId: null,
          parentNodeId: null,
          requestedBy: scoped.userId,
        },
      })
      .execute();

    const queued = await trx
      .selectFrom("workflow.control_commands")
      .select(["id", "command_type", "idempotency_key", "payload", "attempts"])
      .where("tenant_id", "=", scoped.tenantId)
      .where("id", "=", commandId)
      .executeTakeFirstOrThrow();

    return {
      instanceId,
      command: {
        id: queued.id,
        tenantId: scoped.tenantId,
        commandType: queued.command_type,
        workflowInstanceId: instanceId,
        idempotencyKey: queued.idempotency_key,
        payload: asRecord(queued.payload),
        attempts: queued.attempts,
      },
    };
  });
}

/**
 * Start a run and dispatch its command once.
 *
 * One dispatch rather than a worker poll: the poll's claim is cross-tenant by
 * design, so it would also pick up whatever an earlier test left behind, and it
 * converts a dispatch throw into a `last_error` string on the command row —
 * which would leave every assertion below reading a text column instead of the
 * run. Nothing about the claim is skipped, because `consumeRuntimeCommand` still
 * runs inside the start itself.
 */
async function runDefinition(session: WorkflowSession, definitionId: string): Promise<Run> {
  const started = await enqueueStartCommand(session, definitionId);
  await suite.dispatch(started.command);
  return loadRun(session, started.instanceId);
}

/** Publish and run in one step, for the tests that reuse neither afterwards. */
async function runGraph(session: WorkflowSession, name: string, graph: unknown): Promise<Run> {
  return runDefinition(session, await publishGraph(session, name, graph));
}

async function loadRun(session: WorkflowSession, instanceId: string): Promise<Run> {
  return withDbSession(suite.runtime.db, session, async (trx, scoped) => {
    const instance = await trx
      .selectFrom("workflow.instances")
      .select(["status", "error"])
      .where("tenant_id", "=", scoped.tenantId)
      .where("id", "=", instanceId)
      .executeTakeFirstOrThrow();

    const states = await trx
      .selectFrom("workflow.node_states")
      .select([
        "node_id",
        "node_type",
        "status",
        "resolved_parameters",
        "shared_output",
        "error",
      ])
      .where("tenant_id", "=", scoped.tenantId)
      .where("instance_id", "=", instanceId)
      .execute();

    return {
      instanceId,
      status: instance.status,
      error: asRecordOrNull(instance.error),
      nodes: new Map(
        states.map((row) => [
          row.node_id,
          {
            nodeType: row.node_type,
            status: row.status,
            resolvedParameters: asRecord(row.resolved_parameters),
            sharedOutput: asRecord(row.shared_output),
            error: asRecordOrNull(row.error),
          },
        ]),
      ),
    };
  });
}

function nodeOf(run: Run, nodeId: string): NodeState {
  const state = run.nodes.get(nodeId);
  if (!state) {
    throw new Error(
      `node "${nodeId}" has no state; the run recorded ${[...run.nodes.keys()].join(", ") || "nothing"}`,
    );
  }
  return state;
}

/** The payload a completed node published for its successors. */
function payloadOf(run: Run, nodeId: string): Record<string, unknown> {
  return asRecord(nodeOf(run, nodeId).sharedOutput.payload);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is not a string (got ${JSON.stringify(value)})`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Relations, read and written outside the engine
// ---------------------------------------------------------------------------

type RelationSeed = {
  displayName: string;
  relationType: string;
  status?: string;
  notes?: string;
};

async function seedRelation(session: WorkflowSession, values: RelationSeed): Promise<string> {
  return withDbSession(suite.runtime.db, session, async (trx, scoped) => {
    const row = await trx
      .insertInto("erp.relations")
      .values({
        tenant_id: scoped.tenantId,
        display_name: values.displayName,
        relation_type: values.relationType,
        status: values.status ?? null,
        notes: values.notes ?? null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  });
}

async function readRelation(session: WorkflowSession, id: string) {
  return withDbSession(suite.runtime.db, session, (trx, scoped) =>
    trx
      .selectFrom("erp.relations")
      .select(["id", "tenant_id", "display_name", "relation_type", "status", "notes"])
      .where("tenant_id", "=", scoped.tenantId)
      .where("id", "=", id)
      .executeTakeFirst(),
  );
}

/** Every relation the tenant owns, so a count assertion is over the whole table. */
async function listRelationIds(session: WorkflowSession): Promise<string[]> {
  return withDbSession(suite.runtime.db, session, async (trx, scoped) => {
    const rows = await trx
      .selectFrom("erp.relations")
      .select("id")
      .where("tenant_id", "=", scoped.tenantId)
      .execute();
    return rows.map((row) => row.id);
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

describe("generated entity workflow nodes", () => {
  test(
    "a create node writes a real row and publishes its id",
    async () => {
      const session = writerSession();
      const foreignTenantId = randomUUID();

      const run = await runGraph(
        session,
        "create relation",
        singleNodeGraph("create relation", {
          id: "create",
          type: CREATE_NODE,
          config: {
            values: {
              displayName: "Acme Industries",
              relationType: "customer",
              status: "active",
              // Ignored: `writableColumnMap` excludes tenant_id, and the bridge
              // stamps the run's tenant afterwards. A config that could set it
              // would let an authored graph write into another tenant.
              tenantId: foreignTenantId,
            },
          },
        }),
      );

      expect(run.status).toBe("completed");
      const created = nodeOf(run, "create");
      expect(created.status).toBe("completed");
      expect(created.sharedOutput.outputHandle).toBe("default");

      const payload = payloadOf(run, "create");
      const relationId = requireString(payload.id, "created relation id");
      expect(payload.displayName).toBe("Acme Industries");
      // The tenant id is deliberately NOT published. shared_output is the
      // channel later nodes interpolate through {{nodes.<id>.output.*}}, so
      // anything here can end up in a message body or an outbound call; the
      // tenant id belongs on the run, not in that channel.
      expect(payload.tenantId).toBeUndefined();

      // The row itself, not the node's account of it.
      const row = await readRelation(session, relationId);
      expect(row?.display_name).toBe("Acme Industries");
      expect(row?.relation_type).toBe("customer");
      expect(row?.status).toBe("active");
      expect(row?.tenant_id).toBe(session.tenantId);
      expect(await listRelationIds(session)).toEqual([relationId]);
    },
    TEST_TIMEOUT,
  );

  test(
    "a second node reads back the row the first one wrote, through a placeholder",
    async () => {
      const session = writerSession();

      const run = await runGraph(
        session,
        "create then read",
        graphOf(
          "create then read",
          [
            { id: "start", type: "triggerManual" },
            {
              id: "create",
              type: CREATE_NODE,
              config: {
                values: {
                  displayName: "Northwind Trading",
                  relationType: "supplier",
                  notes: "seeded by the create node",
                },
              },
            },
            {
              id: "read",
              type: GET_ONE_NODE,
              // The whole point of the test: the engine resolves this out of the
              // create node's shared_output, and the key it reads — `id` — is
              // chosen by the bridge's `outputRow`, in another module.
              config: { recordId: "{{nodes.create.output.id}}" },
            },
            { id: "finish", type: "end" },
          ],
          [
            { id: "e-start", source: "start", target: "create" },
            { id: "e-create", source: "create", sourceHandle: "default", target: "read" },
            { id: "e-read", source: "read", sourceHandle: "default", target: "finish" },
          ],
        ),
      );

      expect(run.status).toBe("completed");
      const written = payloadOf(run, "create");
      const readBack = payloadOf(run, "read");
      const relationId = requireString(written.id, "created relation id");

      expect(readBack.id).toBe(relationId);
      expect(readBack.displayName).toBe("Northwind Trading");
      expect(readBack.relationType).toBe("supplier");
      expect(readBack.notes).toBe("seeded by the create node");

      // The substitution happened before the bridge ran, not inside it: the
      // config persisted for the node carries the id rather than the template.
      // A placeholder that survived this far would reach the SQL as the literal
      // string `{{nodes.create.output.id}}`.
      expect(nodeOf(run, "read").resolvedParameters.recordId).toBe(relationId);

      // Still one row: a getOne that quietly created something, or a create
      // that ran twice, would show up here and nowhere else.
      expect(await listRelationIds(session)).toEqual([relationId]);
    },
    TEST_TIMEOUT,
  );

  test(
    "a list node's filter selects one of two seeded rows",
    async () => {
      const session = writerSession();
      const wanted = await seedRelation(session, {
        displayName: "Filter Match",
        relationType: "customer",
      });
      const ignored = await seedRelation(session, {
        displayName: "Filter Miss",
        relationType: "supplier",
      });
      expect(new Set(await listRelationIds(session))).toEqual(new Set([wanted, ignored]));

      const run = await runGraph(
        session,
        "list customers",
        // All three handles are wired so a wrong count still completes the run.
        // Leaving `many` unwired would fail it with NO_EDGE_FOR_HANDLE, which
        // reports a routing problem instead of the count that caused it.
        singleNodeGraph(
          "list customers",
          {
            id: "list",
            type: LIST_NODE,
            config: { limit: 10, filterCondition: equalsFilter("relationType", "customer") },
          },
          ["none", "one", "many"],
        ),
      );

      expect(run.status).toBe("completed");
      // `one` IS the assertion that exactly one row matched: the handle is
      // derived from the total count, before the limit is applied.
      expect(nodeOf(run, "list").sharedOutput.outputHandle).toBe("one");

      const payload = payloadOf(run, "list");
      expect(payload.id).toBe(wanted);
      expect(payload.relationType).toBe("customer");
    },
    TEST_TIMEOUT,
  );

  test(
    "an update node changes the row and leaves the fields it did not name",
    async () => {
      const session = writerSession();
      const relationId = await seedRelation(session, {
        displayName: "Before Update",
        relationType: "customer",
        status: "active",
      });

      const run = await runGraph(
        session,
        "update relation",
        singleNodeGraph("update relation", {
          id: "update",
          type: UPDATE_NODE,
          config: {
            recordId: relationId,
            values: { status: "closed", notes: "updated by a workflow" },
          },
        }),
      );

      expect(run.status).toBe("completed");
      const payload = payloadOf(run, "update");
      expect(payload.id).toBe(relationId);
      expect(payload.status).toBe("closed");

      const row = await readRelation(session, relationId);
      expect(row?.status).toBe("closed");
      expect(row?.notes).toBe("updated by a workflow");
      // An update is a patch, not a replace: a column the config never named
      // keeps what it had.
      expect(row?.display_name).toBe("Before Update");
      expect(await listRelationIds(session)).toEqual([relationId]);
    },
    TEST_TIMEOUT,
  );

  test(
    "a delete node removes the row from the table",
    async () => {
      const session = writerSession();
      const relationId = await seedRelation(session, {
        displayName: "To Be Deleted",
        relationType: "customer",
      });

      const run = await runGraph(
        session,
        "delete relation",
        singleNodeGraph("delete relation", {
          id: "delete",
          type: DELETE_NODE,
          config: { recordId: relationId },
        }),
      );

      expect(run.status).toBe("completed");
      const payload = payloadOf(run, "delete");
      expect(payload.success).toBe(true);
      expect(payload.deletedId).toBe(relationId);

      expect(await readRelation(session, relationId)).toBeUndefined();
      expect(await listRelationIds(session)).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  test(
    "a list node under one tenant never returns another tenant's row",
    async () => {
      const tenantA = writerSession();
      const tenantB = writerSession();

      // Deliberately indistinguishable by every column the filter looks at, so
      // the tenant is the only thing that can separate them.
      const ownRelation = await seedRelation(tenantA, {
        displayName: "Shared Marker",
        relationType: "customer",
      });
      const foreignRelation = await seedRelation(tenantB, {
        displayName: "Shared Marker",
        relationType: "customer",
      });

      const listMarker = singleNodeGraph(
        "list across tenants",
        {
          id: "list",
          type: LIST_NODE,
          config: { limit: 50, filterCondition: equalsFilter("displayName", "Shared Marker") },
        },
        ["none", "one", "many"],
      );

      const run = await runGraph(tenantA, "list across tenants", listMarker);
      expect(run.status).toBe("completed");
      // A leak shows up here as `many`, not as an error: the bridge would have
      // counted two rows and routed accordingly.
      expect(nodeOf(run, "list").sharedOutput.outputHandle).toBe("one");

      const payload = payloadOf(run, "list");
      expect(payload.id).toBe(ownRelation);
      expect(payload.id).not.toBe(foreignRelation);
      // Isolation is proved by WHICH row came back, not by a tenant id in the
      // payload — that field is suppressed on purpose, and asserting it here
      // would have made the leak check depend on the very thing it leaks.
      expect(payload.tenantId).toBeUndefined();

      // The control, and the reason it is a whole second run rather than a
      // direct read: the identical graph under tenant B must find tenant B's
      // row. Without it, tenant A's single result would be equally explained by
      // a filter that matches nothing, and the test would prove nothing.
      const mirror = await runGraph(tenantB, "list across tenants", listMarker);
      expect(mirror.status).toBe("completed");
      expect(nodeOf(mirror, "list").sharedOutput.outputHandle).toBe("one");
      expect(payloadOf(mirror, "list").id).toBe(foreignRelation);
    },
    TEST_TIMEOUT,
  );

  test(
    "a run cannot read or delete a row belonging to another tenant",
    async () => {
      const tenantA = writerSession();
      const tenantB = writerSession();
      const foreignRelation = await seedRelation(tenantB, {
        displayName: "Not Yours",
        relationType: "customer",
      });

      const read = await runGraph(
        tenantA,
        "read across tenants",
        singleNodeGraph("read across tenants", {
          id: "read",
          type: GET_ONE_NODE,
          config: { recordId: foreignRelation },
        }),
      );
      // Indistinguishable from a row that does not exist, which is the correct
      // answer: a run must not be able to tell one from the other.
      expect(read.status).toBe("failed");
      expect(nodeOf(read, "read").error?.code).toBe("BRIDGE_THREW");

      const removal = await runGraph(
        tenantA,
        "delete across tenants",
        singleNodeGraph("delete across tenants", {
          id: "delete",
          type: DELETE_NODE,
          config: { recordId: foreignRelation },
        }),
      );
      expect(removal.status).toBe("failed");
      expect(nodeOf(removal, "delete").error?.code).toBe("BRIDGE_THREW");

      // The row survived both, and tenant A still owns nothing.
      expect((await readRelation(tenantB, foreignRelation))?.display_name).toBe("Not Yours");
      expect(await listRelationIds(tenantA)).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  test(
    "a bridge that throws fails its node and its run, and stops the walk",
    async () => {
      const session = writerSession();
      const missingId = randomUUID();

      const run = await runGraph(
        session,
        "read a missing relation",
        singleNodeGraph("read a missing relation", {
          id: "read",
          type: GET_ONE_NODE,
          config: { recordId: missingId },
        }),
      );

      expect(run.status).toBe("failed");

      const failed = nodeOf(run, "read");
      expect(failed.status).toBe("failed");
      // The engine wraps the bridge's throw rather than replacing it: the code
      // says where the failure came from and the message keeps what it said.
      expect(failed.error?.code).toBe("BRIDGE_THREW");
      expect(String(failed.error?.message)).toContain(missingId);
      expect(String(failed.error?.message)).toContain("was not found");
      // Written to shared_output as well, so a downstream node could branch on
      // it through the ordinary output placeholders.
      expect(asRecord(failed.sharedOutput.error).code).toBe("BRIDGE_THREW");

      // The trigger ran, the failing node ran, and nothing after it did.
      expect(nodeOf(run, "start").status).toBe("completed");
      expect(run.nodes.has("finish")).toBe(false);
      // The failure is recorded per node; `workflow.instances.error` is left
      // null by the completion cascade, which only writes status and
      // completed_at. Asserted so a change to that is a deliberate one.
      expect(run.error).toBeNull();
    },
    TEST_TIMEOUT,
  );
});
