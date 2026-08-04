// SPDX-License-Identifier: BUSL-1.1
/**
 * The workflow engine, driven end to end: a published definition, a queued start
 * command, one dispatch, and the rows the run leaves behind.
 *
 * Every other workflow file in this suite stops at the authoring surface.
 * `workflow-definitions.e2e.test.ts` proves a graph can be stored, versioned and
 * published; `workflow-validation.e2e.test.ts` proves which graphs are refused
 * and, more usefully, which broken ones are not. Neither shows that a stored
 * graph does anything at all, and the gap is wider than it looks: the validator
 * checks no cycles, no reachability, no required nodes and no per-node config,
 * so a definition that validates clean is explicitly not a workflow that runs.
 * The only evidence that the engine executes a document is the document being
 * executed.
 *
 * ## How a run is started here
 *
 * Not by calling the runtime. An intent to run is a ROW, and the shipped
 * `enqueueWorkflowInstanceStart` writes it: a `workflow.instances` row in
 * `starting` and a `workflow.control_commands` row in `pending`, after which
 * nothing has executed. Each test reads that command back out of the queue and
 * hands it to the in-process dispatcher — the same seam
 * `processWorkflowControlCommandBatch` calls once it has claimed a row.
 *
 * Going through the shipped enqueue is what makes the command below the one a
 * deployment produces: the pinned `version_id`, the trigger type and the start
 * context all come from that function rather than from this file. A start
 * restated locally would keep agreeing with itself after the shipped one moved
 * underneath it, and what the enqueue writes is everything a run then reads.
 *
 * The batch poll is deliberately not used. Its claim is cross-tenant by design,
 * so that one worker can drain every tenant's backlog; in a file that shares one
 * database a poll would also claim whatever an earlier test left behind, and
 * which commands it got would depend on `created_at` ordering across the whole
 * suite. It also converts a dispatch throw into a `last_error` string on the
 * command row, which would leave every failure assertion below reading a text
 * column instead of the run. Dispatching one read-back command keeps each test
 * to a single deterministic pass. Nothing about the claim is skipped by this:
 * `consumeRuntimeCommand` still runs inside the start, and the last test
 * redelivers the very same row.
 *
 * ## What it proves
 *
 * - A linear graph runs to completion, with one terminal `workflow.node_states`
 *   row per visited node. Termination is read off those rows rather than
 *   asserted by the walk, so the rows are the run and not a report of it.
 * - `{{input.x}}` resolves out of the start context into the end node's payload,
 *   and a whole-string placeholder preserves the value's TYPE. A placeholder
 *   mixed with literal text is stringified per substitution; one that IS the
 *   whole string yields the value itself, so a number stays a number. Without
 *   that every field fed by a variable would arrive as a string, and a
 *   workflow's declared output types would be a fiction.
 * - A placeholder that cannot resolve FAILS the run. There is no leave-as-is
 *   fallback on purpose: a `{{...}}` that survives resolution is a literal
 *   template string on its way into a side effect.
 * - A decision node takes exactly one branch. Which one is read from
 *   `node_states`, because a final status of `completed` is identical for both
 *   branches and would prove nothing.
 * - A catalogued node type with no registered bridge fails with NO_BRIDGE naming
 *   the type. Messaging, AI and billing nodes are unregistered because this
 *   deployment provides none of those capabilities, and failing where the gap is
 *   is the whole contract — a stub would run and quietly do nothing.
 * - Redelivering one control command does not run the workflow twice. That is
 *   what makes the queue safe to retry, and it comes from the conditional
 *   consume plus the instance-row lock rather than from any dispatcher.
 *
 * ## Refusing, and saying so
 *
 * Two edges out of one node sharing a `sourceHandle` must refuse rather than
 * pick one: the engine has no parallelism, `workflow.node_states` cannot
 * represent two live branches, and silently choosing would be the worst
 * available answer. Refusing is only half of it — the refusal has to be
 * recorded, and that is harder than it sounds. The failure is detected while
 * LEAVING a node whose own state is already `completed`, and a settled node must
 * not be re-settled, so there is no node row to write it to. A routing failure
 * is not a node failure: the node did its job, the graph is broken. The instance
 * is therefore failed directly rather than inferred from node states, and the
 * node is annotated with where it happened without its outcome being rewritten.
 * The same path covers TRIGGER_FANOUT, NO_EDGE_FOR_HANDLE and
 * EDGE_TARGET_MISSING; the ambiguity test below is what pins all of them.
 *
 * Authoring refuses such a graph too now, at publish. That does not make this
 * layer redundant: an already-published version is never re-validated, so the
 * graphs published before that rule existed still reach the engine, and the
 * ambiguity test writes its published row directly to keep proving they are
 * refused.
 *
 * ## Why it carries its own harness
 *
 * `e2e/harness.ts` drives the shared development database and cleans up through
 * generated CRUD, which these tables do not have — `workflow.instances`,
 * `workflow.node_states` and `workflow.control_commands` are all declared
 * `domainInternal` / `generatedCrud: false`. A run also has to be counted
 * exactly: the assertions below read whole node-state sets, which a shared
 * database makes meaningless. So this follows the scratch-database pattern of
 * the other workflow files — create a throwaway database through the admin URL,
 * migrate it with the module seeds, drop it at the end.
 *
 * The seeds are not optional. `init` hydrates the node catalog from those rows,
 * publish validates against it, and the resolved-config schemas are compiled
 * from it; an unseeded catalog would let a graph publish while nothing was
 * checked and would skip config validation entirely at run time.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/graphql/__tests__/workflow-engine.e2e.test.ts 2>&1
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { graphql, type GraphQLSchema } from "graphql";
import {
  createDatabaseRuntime,
  type DatabaseRuntime,
  type OpenShapeForgeDatabase,
} from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { withDbSession } from "../../db/session.js";
import type { Json } from "../../generated/db/types.js";
import { initRuntimeModules, loadRuntimeModules } from "../../modules/registry.js";
import { buildGraphqlSchema } from "../schema.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const TEST_TIMEOUT = 90_000;

/**
 * The realm role `WORKFLOW_WRITER_ROLES` admits. Without it every authoring
 * mutation below is FORBIDDEN and no graph would ever reach a run.
 */
const WRITER_ROLE = "directie";

/**
 * A catalogued node type this deployment cannot execute.
 *
 * `node-bridges.ts` registers flow control and generated entity CRUD and
 * nothing else, so every messaging, AI and billing type in the catalog reaches
 * execution with no bridge. This one is picked over the billing node because
 * the billing node declares a `runtime.required` config field, and the run would
 * then have two reasons to fail.
 */
const UNBRIDGED_NODE_TYPE = "notificatieSend";

// ---------------------------------------------------------------------------
// The workflow runtime, imported by URL
// ---------------------------------------------------------------------------

/**
 * `apps/api/tsconfig.json` roots its program at `src`, so a static import of
 * anything under `examples/` would pull a file into a program it cannot belong
 * to. The plugin loader has the same constraint and answers it the same way:
 * `loadRuntimeModules` resolves its specifiers at run time. The shapes below are
 * therefore declared here, and describe only what this file calls.
 */
const WORKFLOW_RUNTIME_DIR = new URL(
  "../../../../../examples/plugins/workflow/runtime/",
  import.meta.url,
).href;

/** What the worker hands a dispatcher: a claimed row, plus its opaque payload. */
type WorkflowControlCommand = {
  id: string;
  tenantId: string;
  commandType: string;
  workflowInstanceId: string | null;
  idempotencyKey: string | null;
  payload: Record<string, unknown>;
  attempts: number;
};

type ControlCommandWorkerModule = {
  createInProcessWorkflowControlCommandDispatcher: (db: OpenShapeForgeDatabase) => {
    dispatch: (command: WorkflowControlCommand) => Promise<void>;
  };
};

type InstanceCommandsModule = {
  enqueueWorkflowInstanceStart: (
    db: OpenShapeForgeDatabase,
    session: WorkflowSession,
    input: { definitionId: string; context?: unknown },
  ) => Promise<{ id: string; status: string }>;
};

async function importWorkflowRuntime<TModule>(name: string): Promise<TModule> {
  return (await import(`${WORKFLOW_RUNTIME_DIR}${name}.ts`)) as TModule;
}

// ---------------------------------------------------------------------------
// Scratch database, module registry, schema
// ---------------------------------------------------------------------------

type Suite = {
  admin: SQL;
  database: string;
  runtime: DatabaseRuntime;
  schema: GraphQLSchema;
  dispatch: (command: WorkflowControlCommand) => Promise<void>;
  commands: InstanceCommandsModule;
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
  const database = `wfengine_e2e_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

  // `init` is what registers the node bridges and hydrates the catalog. Without
  // it every node below would fail with NO_BRIDGE and the decision test would
  // pass for the wrong reason.
  const initialized = await initRuntimeModules(modules, { db: runtime.db });
  expect(initialized.failures).toEqual([]);
  expect(initialized.loaded.map((module) => module.name)).toContain("workflow");

  const worker =
    await importWorkflowRuntime<ControlCommandWorkerModule>("control-command-worker");

  return {
    admin,
    database,
    runtime,
    schema: buildGraphqlSchema(initialized.loaded, { db: runtime.db }),
    dispatch: worker.createInProcessWorkflowControlCommandDispatcher(runtime.db).dispatch,
    commands: await importWorkflowRuntime<InstanceCommandsModule>("instance-commands"),
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
 * validates the version and variant nibbles before it will set the tenant GUC,
 * so a hand-typed placeholder is refused there. A tenant per test is isolation
 * the file needs rather than decoration: every test shares one database, and a
 * run left behind by an earlier one would otherwise be readable by a later one.
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
// Authoring, over the proven GraphQL surface
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

/**
 * Create, save and publish one graph, returning the definition id a run starts
 * from. Only a published version is startable, so the three steps are one
 * operation as far as this file is concerned.
 */
async function publishGraph(
  session: WorkflowSession,
  name: string,
  graph: unknown,
): Promise<string> {
  const created = (
    await expectData(session, CREATE_DEFINITION, { input: { name } })
  ).createWorkflowDefinition as { id: string; updatedAt: string };

  const saved = (
    await expectData(session, SAVE_VERSION, {
      input: {
        definitionId: created.id,
        expectedUpdatedAt: created.updatedAt,
        definition: graph,
      },
    })
  ).saveWorkflowDefinitionVersion as { latestVersion: number };
  expect(saved.latestVersion).toBe(1);

  const published = (
    await expectData(session, PUBLISH_VERSION, {
      input: { definitionId: created.id, version: 1 },
    })
  ).publishWorkflowDefinitionVersion as { publishedAt: string | null };
  // A run may only start from a PUBLISHED version. A saved draft is a draft,
  // and starting one would execute work nobody released.
  expect(published.publishedAt).not.toBeNull();

  return created.id;
}

/**
 * Save a graph and mark its version published by writing the row.
 *
 * Needed for AMBIGUOUS_GRAPH alone. `definition-validation.ts` now raises
 * AMBIGUOUS_EDGE_HANDLE as an error, so `assertPublishable` refuses that graph
 * and the mutation cannot produce the definition this file's refusal test needs.
 * That is the validation rule doing its job, and it does not retire the test:
 * publishing is idempotent and deliberately skips validation for a version that
 * is already published, so every graph published before the rule existed is
 * still out there, still startable, and the engine still has to refuse it at run
 * time rather than pick a branch. Writing the row is how this file reproduces
 * one of those.
 *
 * Saving is untouched by validation and stays on the real mutation, so only the
 * publish gate is stepped around.
 */
async function publishStoredGraphUnvalidated(
  session: WorkflowSession,
  name: string,
  graph: unknown,
): Promise<string> {
  const created = (
    await expectData(session, CREATE_DEFINITION, { input: { name } })
  ).createWorkflowDefinition as { id: string; updatedAt: string };

  const saved = (
    await expectData(session, SAVE_VERSION, {
      input: {
        definitionId: created.id,
        expectedUpdatedAt: created.updatedAt,
        definition: graph,
      },
    })
  ).saveWorkflowDefinitionVersion as { latestVersion: number };
  expect(saved.latestVersion).toBe(1);

  await withDbSession(suite.runtime.db, session, async (trx, scoped) => {
    await trx
      .updateTable("workflow.definition_versions")
      .set({ published_at: new Date(), published_by: scoped.userId })
      .where("tenant_id", "=", scoped.tenantId)
      .where("definition_id", "=", created.id)
      .where("version", "=", 1)
      .execute();
  });

  return created.id;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

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

type NodeStateRow = {
  nodeId: string;
  status: string;
  sharedOutput: Record<string, unknown>;
  error: Record<string, unknown>;
  completedAt: string | null;
};

/** Every node state of one run, ordered by node id so comparisons are stable. */
async function readNodeStates(
  session: WorkflowSession,
  instanceId: string,
): Promise<NodeStateRow[]> {
  return withDbSession(suite.runtime.db, session, async (trx, scoped) => {
    const rows = await trx
      .selectFrom("workflow.node_states")
      .select(["node_id", "status", "shared_output", "error", "completed_at"])
      .where("tenant_id", "=", scoped.tenantId)
      .where("instance_id", "=", instanceId)
      .orderBy("node_id", "asc")
      .execute();

    return rows.map((row) => ({
      nodeId: row.node_id,
      status: row.status,
      sharedOutput: asRecord(row.shared_output),
      error: asRecord(row.error),
      completedAt: row.completed_at,
    }));
  });
}

function nodeState(states: NodeStateRow[], nodeId: string): NodeStateRow {
  const found = states.find((state) => state.nodeId === nodeId);
  if (!found) {
    throw new Error(
      `no workflow.node_states row for "${nodeId}" (have: ${states.map((s) => s.nodeId).join(", ") || "none"})`,
    );
  }
  return found;
}

/** The end node's resolved payload, as the runtime records it. */
function endPayload(states: NodeStateRow[], nodeId: string): Record<string, unknown> {
  return asRecord(nodeState(states, nodeId).sharedOutput.payload);
}

type InstanceRow = { status: string; completedAt: string | null };

async function readInstance(
  session: WorkflowSession,
  instanceId: string,
): Promise<InstanceRow> {
  return withDbSession(suite.runtime.db, session, async (trx, scoped) => {
    const row = await trx
      .selectFrom("workflow.instances")
      .select(["status", "completed_at"])
      .where("tenant_id", "=", scoped.tenantId)
      .where("id", "=", instanceId)
      .executeTakeFirstOrThrow();
    return { status: row.status, completedAt: row.completed_at };
  });
}

/**
 * The queued start command, plus its own status.
 *
 * Read back rather than returned by the enqueue call: the point of this file is
 * that a start is a row somebody else picks up, and reading it is what a worker
 * does. The status travels alongside because `consumeRuntimeCommand` moves it,
 * and that move is the claim.
 */
async function readStartCommand(
  session: WorkflowSession,
  instanceId: string,
): Promise<{ command: WorkflowControlCommand; status: string }> {
  return withDbSession(suite.runtime.db, session, async (trx, scoped) => {
    const row = await trx
      .selectFrom("workflow.control_commands")
      .select([
        "id",
        "tenant_id",
        "command_type",
        "workflow_instance_id",
        "idempotency_key",
        "payload",
        "attempts",
        "status",
      ])
      .where("tenant_id", "=", scoped.tenantId)
      .where("workflow_instance_id", "=", instanceId)
      .where("command_type", "=", "workflow.instance.start")
      .executeTakeFirstOrThrow();

    return {
      command: {
        id: row.id,
        tenantId: row.tenant_id,
        commandType: row.command_type,
        workflowInstanceId: row.workflow_instance_id,
        idempotencyKey: row.idempotency_key,
        payload: asRecord(row.payload),
        attempts: row.attempts,
      },
      status: row.status,
    };
  });
}

// ---------------------------------------------------------------------------
// Starting and dispatching
// ---------------------------------------------------------------------------

type QueuedRun = { instanceId: string; command: WorkflowControlCommand };

/**
 * Enqueue a start and stop there. Nothing has executed when this returns — the
 * instance is `starting` and the command is `pending`. The command is read back
 * out of the queue rather than taken from the enqueue's return value, so the
 * dispatcher gets a payload that has been through `jsonb` exactly as a worker's
 * would, and the `version_id` it carries is the one the enqueue pinned.
 */
async function enqueueRun(
  session: WorkflowSession,
  definitionId: string,
  context: Record<string, Json> = {},
): Promise<QueuedRun> {
  const instance = await suite.commands.enqueueWorkflowInstanceStart(
    suite.runtime.db,
    session,
    { definitionId, context },
  );
  const queued = await readStartCommand(session, instance.id);
  expect(queued.status).toBe("pending");
  return { instanceId: instance.id, command: queued.command };
}

/** Enqueue and dispatch in one step, for the tests that only want the outcome. */
async function runWorkflow(
  session: WorkflowSession,
  definitionId: string,
  context: Record<string, Json> = {},
): Promise<QueuedRun> {
  const queued = await enqueueRun(session, definitionId, context);
  await suite.dispatch(queued.command);
  return queued;
}

// ---------------------------------------------------------------------------
// Graphs
// ---------------------------------------------------------------------------

type GraphNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  config?: Record<string, unknown>;
};

type GraphEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
};

function graph(nodes: GraphNode[], edges: GraphEdge[]) {
  return { name: "engine", version: "1", nodes, edges };
}

function triggerNode(): GraphNode {
  return { id: "start", type: "triggerManual", position: { x: 0, y: 0 }, config: {} };
}

/**
 * An end node whose `fields` are the run's declared output. The engine builds
 * the payload from these rather than from whatever the last bridge returned, so
 * they are where a placeholder's resolved value ends up.
 */
function endNode(
  id: string,
  fields: { key: string; valueType: string; value: unknown }[],
  x: number,
): GraphNode {
  return { id, type: "end", position: { x, y: 0 }, config: { fields } };
}

/**
 * A decision that routes to `approved` when the start context says so, and to
 * `rejected` otherwise. `left` is a path operand: the engine resolves it and
 * writes the looked-up value onto the operand before the bridge compares, which
 * is why the bridge itself needs no access to the run's variables.
 */
function decisionNode(): GraphNode {
  return {
    id: "route",
    type: "decision",
    position: { x: 240, y: 0 },
    config: {
      branches: [
        {
          id: "approved",
          label: "Approved",
          when: {
            kind: "rule",
            operator: "equals",
            left: { kind: "path", path: "input.verdict" },
            right: { kind: "literal", value: "approve" },
          },
        },
      ],
      defaultEdgeId: "rejected",
    },
  };
}

const LINEAR_GRAPH = graph(
  [triggerNode(), endNode("finish", [], 240)],
  [{ id: "start-finish", source: "start", target: "finish" }],
);

const PLACEHOLDER_GRAPH = graph(
  [
    triggerNode(),
    endNode(
      "finish",
      [
        { key: "greeting", valueType: "string", value: "Hello {{input.someKey}}" },
        { key: "count", valueType: "number", value: "{{input.count}}" },
      ],
      240,
    ),
  ],
  [{ id: "start-finish", source: "start", target: "finish" }],
);

const UNRESOLVABLE_GRAPH = graph(
  [
    triggerNode(),
    endNode("finish", [{ key: "echo", valueType: "string", value: "{{input.missing}}" }], 240),
  ],
  [{ id: "start-finish", source: "start", target: "finish" }],
);

const DECISION_GRAPH = graph(
  [
    triggerNode(),
    decisionNode(),
    endNode("endApproved", [{ key: "route", valueType: "string", value: "approved" }], 480),
    endNode("endRejected", [{ key: "route", valueType: "string", value: "rejected" }], 480),
  ],
  [
    { id: "start-route", source: "start", target: "route" },
    { id: "route-approved", source: "route", sourceHandle: "approved", target: "endApproved" },
    { id: "route-rejected", source: "route", sourceHandle: "rejected", target: "endRejected" },
  ],
);

const UNBRIDGED_GRAPH = graph(
  [
    triggerNode(),
    { id: "notify", type: UNBRIDGED_NODE_TYPE, position: { x: 240, y: 0 }, config: {} },
    endNode("finish", [], 480),
  ],
  [
    { id: "start-notify", source: "start", target: "notify" },
    { id: "notify-finish", source: "notify", target: "finish" },
  ],
);

/** Two edges off one handle. The decision emits `approved`; both edges match it. */
const AMBIGUOUS_GRAPH = graph(
  [
    triggerNode(),
    decisionNode(),
    endNode("endA", [{ key: "route", valueType: "string", value: "a" }], 480),
    endNode("endB", [{ key: "route", valueType: "string", value: "b" }], 480),
  ],
  [
    { id: "start-route", source: "start", target: "route" },
    { id: "route-a", source: "route", sourceHandle: "approved", target: "endA" },
    { id: "route-b", source: "route", sourceHandle: "approved", target: "endB" },
  ],
);

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

beforeAll(async () => {
  suite = await startSuite();
}, TEST_TIMEOUT);

afterAll(async () => {
  await stopSuite();
}, TEST_TIMEOUT);

describe("workflow engine", () => {
  test(
    "a linear workflow runs to completion and records every node it visited",
    async () => {
      const session = writerSession();
      const definitionId = await publishGraph(session, "linear run", LINEAR_GRAPH);

      const queued = await enqueueRun(session, definitionId, {});
      // Enqueuing is not running. The instance exists and the command is
      // pending; if this said `running` the queue would be decorative.
      expect((await readInstance(session, queued.instanceId)).status).toBe("starting");
      expect(await readNodeStates(session, queued.instanceId)).toEqual([]);

      await suite.dispatch(queued.command);

      const instance = await readInstance(session, queued.instanceId);
      expect(instance.status).toBe("completed");
      expect(instance.completedAt).not.toBeNull();

      const states = await readNodeStates(session, queued.instanceId);
      expect(states.map((state) => state.nodeId)).toEqual(["finish", "start"]);
      // Both terminal: the trigger is recorded on entry so a run shows where it
      // started even if the first step never returns, and the end node settles
      // the walk. The instance's own status is derived from exactly these rows.
      expect(states.map((state) => state.status)).toEqual(["completed", "completed"]);
      expect(states.every((state) => state.completedAt !== null)).toBe(true);
      expect(nodeState(states, "finish").sharedOutput.end).toBe(true);

      // The claim moved the command out of the queue, so a redelivery has
      // nothing left to win.
      expect((await readStartCommand(session, queued.instanceId)).status).toBe(
        "runtime_consumed",
      );
    },
    TEST_TIMEOUT,
  );

  test(
    "placeholders resolve from the start context, and a whole-string one keeps its type",
    async () => {
      const session = writerSession();
      const definitionId = await publishGraph(session, "placeholders", PLACEHOLDER_GRAPH);

      const queued = await runWorkflow(session, definitionId, {
        someKey: "world",
        count: 7,
      });

      expect((await readInstance(session, queued.instanceId)).status).toBe("completed");

      const payload = endPayload(await readNodeStates(session, queued.instanceId), "finish");
      expect(payload.greeting).toBe("Hello world");
      // The type is the assertion. A placeholder mixed with literal text is
      // stringified per substitution, but a string that is nothing BUT a
      // placeholder yields the value itself, so the field a workflow declared as
      // a number is one downstream.
      expect(payload.count).toBe(7);
      expect(typeof payload.count).toBe("number");
    },
    TEST_TIMEOUT,
  );

  test(
    "a placeholder that cannot resolve fails the run instead of passing itself through",
    async () => {
      const session = writerSession();
      const definitionId = await publishGraph(session, "unresolvable", UNRESOLVABLE_GRAPH);

      const queued = await runWorkflow(session, definitionId, {});

      expect((await readInstance(session, queued.instanceId)).status).toBe("failed");

      const states = await readNodeStates(session, queued.instanceId);
      const failed = nodeState(states, "finish");
      expect(failed.status).toBe("failed");
      expect(failed.error.code).toBe("UNRESOLVED_VARIABLE");
      // The message names the placeholder, because "a variable did not resolve"
      // is not actionable on a graph with dozens of them.
      expect(String(failed.error.message)).toContain("input.missing");
      // The node carries the error and no payload at all. The alternative the
      // engine refuses is a result with a literal `{{input.missing}}` in it.
      expect(endPayload(states, "finish")).toEqual({});
      expect(nodeState(states, "start").status).toBe("completed");
    },
    TEST_TIMEOUT,
  );

  test(
    "a decision node routes down the matching branch and leaves the other unrun",
    async () => {
      const session = writerSession();
      const definitionId = await publishGraph(session, "decision", DECISION_GRAPH);

      const approved = await runWorkflow(session, definitionId, { verdict: "approve" });
      const approvedStates = await readNodeStates(session, approved.instanceId);
      expect((await readInstance(session, approved.instanceId)).status).toBe("completed");
      // Which branch ran is the assertion. Both graphs complete, so the final
      // status is identical either way and proves nothing on its own; only the
      // absence of a node state for the other end node shows the route taken.
      expect(approvedStates.map((state) => state.nodeId)).toEqual([
        "endApproved",
        "route",
        "start",
      ]);
      expect(endPayload(approvedStates, "endApproved").route).toBe("approved");
      expect(nodeState(approvedStates, "route").sharedOutput.outputHandle).toBe("approved");

      const rejected = await runWorkflow(session, definitionId, { verdict: "deny" });
      const rejectedStates = await readNodeStates(session, rejected.instanceId);
      expect((await readInstance(session, rejected.instanceId)).status).toBe("completed");
      // No branch matched, so the configured default handle wins — a decision
      // never ends a run by falling off the end of its own config.
      expect(rejectedStates.map((state) => state.nodeId)).toEqual([
        "endRejected",
        "route",
        "start",
      ]);
      expect(endPayload(rejectedStates, "endRejected").route).toBe("rejected");
      expect(nodeState(rejectedStates, "route").sharedOutput.outputHandle).toBe("rejected");
    },
    TEST_TIMEOUT,
  );

  test(
    "a node type with no registered bridge fails the run with NO_BRIDGE, naming the type",
    async () => {
      const session = writerSession();
      const definitionId = await publishGraph(session, "unbridged", UNBRIDGED_GRAPH);

      const queued = await runWorkflow(session, definitionId, {});

      expect((await readInstance(session, queued.instanceId)).status).toBe("failed");

      const states = await readNodeStates(session, queued.instanceId);
      const failed = nodeState(states, "notify");
      expect(failed.status).toBe("failed");
      expect(failed.error.code).toBe("NO_BRIDGE");
      // The type is in the message because that is the only thing an operator
      // can act on: the deployment is missing a capability, not a config value.
      expect(String(failed.error.message)).toContain(UNBRIDGED_NODE_TYPE);
      // The run stopped at the gap rather than stepping over it. A stub bridge
      // would have let `finish` run and the workflow report success.
      expect(states.map((state) => state.nodeId)).toEqual(["notify", "start"]);
    },
    TEST_TIMEOUT,
  );

  test(
    "two edges sharing one output handle refuse the run rather than picking a branch",
    async () => {
      const session = writerSession();
      // Not `publishGraph`: authoring refuses this graph now, and the engine's
      // refusal still has to hold for the ones published before it did.
      const definitionId = await publishStoredGraphUnvalidated(
        session,
        "ambiguous",
        AMBIGUOUS_GRAPH,
      );

      const queued = await runWorkflow(session, definitionId, { verdict: "approve" });

      const states = await readNodeStates(session, queued.instanceId);
      // Neither branch was taken. The engine has no parallelism and a node state
      // set cannot represent two live branches, so choosing one would be worse
      // than stopping.
      expect(states.map((state) => state.nodeId)).toEqual(["route", "start"]);

      // The refusal has to be recorded, or a run that went nowhere is
      // indistinguishable from one that finished. `failInstance` writes the
      // failure against the node the walk was LEAVING, and that node's state is
      // already `completed`; `markNodeStateTerminalInTransaction` treats a
      // terminal row as final and drops the write, so the cascade then sees
      // every node settled with nothing failed.
      expect((await readInstance(session, queued.instanceId)).status).toBe("failed");
      expect(nodeState(states, "route").error.code).toBe("AMBIGUOUS_EDGES_FOR_HANDLE");
    },
    TEST_TIMEOUT,
  );

  test(
    "redelivering the same start command does not run the workflow a second time",
    async () => {
      const session = writerSession();
      const definitionId = await publishGraph(session, "idempotent", PLACEHOLDER_GRAPH);

      const queued = await runWorkflow(session, definitionId, {
        someKey: "world",
        count: 7,
      });

      const firstStates = await readNodeStates(session, queued.instanceId);
      const firstInstance = await readInstance(session, queued.instanceId);
      expect(firstInstance.status).toBe("completed");

      // The same row, handed over again — a worker that died after dispatching
      // and before marking the command completed leaves exactly this.
      await suite.dispatch(queued.command);

      // Timestamps included: a second walk would rewrite `completed_at` on every
      // node even where the status and payload happened to come out the same.
      expect(await readNodeStates(session, queued.instanceId)).toEqual(firstStates);
      expect(await readInstance(session, queued.instanceId)).toEqual(firstInstance);
    },
    TEST_TIMEOUT,
  );
});
