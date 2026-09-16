// SPDX-License-Identifier: BUSL-1.1
/**
 * The control-command queue, drained by the worker instead of by hand.
 *
 * `workflow-engine.e2e.test.ts` proves the engine executes a document, and it
 * gets there by writing a start command and then handing that row straight to
 * the dispatcher. That is a deliberate simplification, and what it skips is
 * precisely the queue: the claim, the attempt counter, the visibility timeout,
 * and the poll loop that ties the three together. Nothing in this repo had ever
 * executed those paths. This file starts no run by calling the runtime — every
 * run below begins as a `pending` row and reaches a bridge only because a worker
 * poll claimed it.
 *
 * ## Why the queue is the thing worth proving
 *
 * "An intent to run is a row, not a call" only buys anything if the row outlives
 * everything that can happen to the process holding it. Four mechanisms carry
 * that, and each fails in a different direction:
 *
 *   - `for update skip locked` is what allows a second worker to exist. It has
 *     to give two properties that are not the same one twice: a contended row is
 *     claimed by exactly ONE poll, or the run happens twice; and a row another
 *     transaction is holding is SKIPPED rather than waited on, or one slow
 *     command stalls every worker behind it and the queue degrades to serial.
 *   - the visibility timeout is the only recovery from a worker that died
 *     mid-command. `locked_at` is the sole evidence available that nobody is
 *     still working on a row, so the reclaim has to cut both ways: take a stale
 *     claim back, and leave a fresh one alone. A reclaim that is too eager does
 *     not lose work — it duplicates it, which is worse, because two workers then
 *     run the same command against the same instance.
 *   - `maxAttempts` is what stops a command nothing can dispatch from cycling
 *     forever. A queue that retries without bound reports an outage as load and
 *     never surfaces the error that caused it.
 *   - idempotency has to hold on both sides. A duplicate ENQUEUE must collapse
 *     into one command and one run, which is what makes the queue safe to feed
 *     from a webhook or a schedule; and a duplicate DELIVERY of one command must
 *     not walk the graph a second time, which is what makes the reclaim above
 *     safe to have at all.
 *
 * ## How the worker is driven
 *
 * Single batches, except where the loop itself is the subject. A batch is one
 * claim followed by one dispatch per claimed row, which is exactly one poll's
 * worth of work with none of the timing; the assertions below count claims,
 * attempts and node states, and a running interval would make every one of them
 * a race against a timer. `startWorkflowControlCommandWorker` gets one test of
 * its own, because "the loop reschedules itself and drains a queue nobody
 * touched" is a property no single batch call can show. That test waits on a
 * database condition rather than on a sleep, stops the worker explicitly, and
 * then proves the stop took effect — a leaked interval would silently claim the
 * rows of every test after it.
 *
 * The claim is cross-tenant on purpose, so that one worker drains every tenant's
 * backlog. In a file that shares one database that also means a row left
 * claimable by one test is work the next test's poll would pick up, so each test
 * ends with the queue empty: `afterEach` deletes whatever is still claimable.
 * That is cleanup, never an assertion.
 *
 * ## Both ends of the bound must be legible
 *
 * A command exhausts its attempts in one of two ways. A dispatcher that THROWS
 * ends it `failed` with `last_error` attached. A dispatcher that takes the
 * worker down with it writes nothing at all, so the row only ever moves by being
 * reclaimed — and the reclaim clause requires `attempts < maxAttempts`, so at
 * the bound it stops being claimed.
 *
 * Stopping is correct; stopping as `processing` was not. That is
 * indistinguishable from work in flight, so an alert on stuck commands could not
 * tell a dead worker from a busy one, and `last_error` was empty exactly where
 * an operator needs it. Both paths now end `failed` with the reason attached and
 * the claim marker cleared, and the dead worker's id is carried into the error
 * rather than left on a terminal row. The reclaim test pins that.
 *
 * ## Two things this file deliberately does not do
 *
 * It does not work around the worker's session helper, which sets
 * `app.bypass_rls` directly rather than through the audited `withSystemSession`
 * wrapper (issue #214). The worker is exercised exactly as written; nothing here
 * asserts that the exception is acceptable, and the tests would keep their
 * meaning if it were resolved.
 *
 * It does not wire the worker to anything. No role starts these workers in a
 * deployment, and driving the loop from a test is the point rather than a
 * shortcut: the mechanism is proven before anything is given the ability to
 * start it.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/graphql/__tests__/workflow-worker.e2e.test.ts 2>&1
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { graphql, type GraphQLSchema } from "graphql";
import { sql, type Transaction } from "kysely";
import {
  createDatabaseRuntime,
  type DatabaseRuntime,
  type OpenShapeForgeDatabase,
} from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { withDbSession } from "../../db/session.js";
import type { DB } from "../../generated/db/types.js";
import { initRuntimeModules, loadRuntimeModules } from "../../modules/registry.js";
import { buildGraphqlSchema } from "../schema.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const TEST_TIMEOUT = 90_000;

/** The realm role `WORKFLOW_WRITER_ROLES` admits; without it nothing publishes. */
const WRITER_ROLE = "directie";

/**
 * Long enough that a claim taken during a test is never stale by accident, so
 * every reclaim below happens because a fixture backdated `locked_at` and not
 * because the suite was slow.
 */
const VISIBILITY_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// The workflow runtime, imported by URL
// ---------------------------------------------------------------------------

/**
 * `apps/api/tsconfig.json` roots its program at `src`, so a static import of
 * anything under `examples/` would pull a file into a program it cannot belong
 * to. `loadRuntimeModules` has the same constraint and resolves its specifiers
 * at run time; these do too, and the shapes below describe only what is called.
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

type WorkflowControlCommandDispatcher = {
  dispatch: (command: WorkflowControlCommand) => Promise<void>;
};

type WorkerOptions = {
  workerId?: string;
  batchSize?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
  processingTimeoutMs?: number;
};

type ControlCommandWorkerModule = {
  createInProcessWorkflowControlCommandDispatcher: (
    db: OpenShapeForgeDatabase,
  ) => WorkflowControlCommandDispatcher;
  createWorkflowControlCommandDispatcher: (
    db: OpenShapeForgeDatabase,
    env?: NodeJS.ProcessEnv,
  ) => WorkflowControlCommandDispatcher;
  processWorkflowControlCommandBatch: (
    db: OpenShapeForgeDatabase,
    dispatcher: WorkflowControlCommandDispatcher,
    options?: WorkerOptions,
  ) => Promise<{ processed: number }>;
  startWorkflowControlCommandWorker: (
    db: OpenShapeForgeDatabase,
    dispatcher: WorkflowControlCommandDispatcher,
    options?: WorkerOptions,
  ) => { stop: () => Promise<void> };
};

type InstanceCommandsModule = {
  enqueueWorkflowInstanceStart: (
    db: OpenShapeForgeDatabase,
    session: WorkflowSession,
    input: { definitionId: string; context?: unknown; triggerType?: string | null },
  ) => Promise<{ id: string; status: string }>;
  enqueueWorkflowInstanceStartInTransaction: (
    trx: Transaction<DB>,
    tenantId: string,
    input: { definitionId: string; startedBy: string; context?: unknown },
  ) => Promise<{ instanceId: string; commandId: string }>;
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
  worker: ControlCommandWorkerModule;
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
  const database = `wfworker_e2e_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(database)) {
    throw new Error(`unsafe scratch database name: ${database}`);
  }

  const admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${database}"`);

  // More than one connection is load-bearing here rather than a comfort
  // setting: the contention tests hold a transaction open while a poll runs,
  // and a single-connection pool would deadlock instead of proving anything.
  const runtime = createDatabaseRuntime({
    databaseUrl: scratchUrl(database),
    maxConnections: 8,
  });

  const modules = await loadRuntimeModules();
  expect(modules.failures).toEqual([]);

  const moduleSeeds = modules.loaded.flatMap((module) => module.seeds ?? []);
  await runtime.db.connection().execute((conn) => runMigrationChain(conn, { moduleSeeds }));

  // `init` registers the node bridges and hydrates the catalog. Without it the
  // graphs below fail with NO_BRIDGE and every drain assertion would be reading
  // a failed run rather than a completed one.
  const initialized = await initRuntimeModules(modules, { db: runtime.db });
  expect(initialized.failures).toEqual([]);
  expect(initialized.loaded.map((module) => module.name)).toContain("workflow");

  return {
    admin,
    database,
    runtime,
    schema: buildGraphqlSchema(initialized.loaded, { db: runtime.db }),
    worker: await importWorkflowRuntime<ControlCommandWorkerModule>("control-command-worker"),
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
 * A writer identity in a tenant of its own. The ids are generated because
 * `createDbSessionContext` validates the version and variant nibbles before it
 * will set the tenant GUC, and a tenant per test keeps the row counts below
 * readable in a database every test shares.
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

/** A trigger wired straight to an end node: the smallest graph that completes. */
const LINEAR_GRAPH = {
  name: "worker",
  version: "1",
  nodes: [
    { id: "start", type: "triggerManual", position: { x: 0, y: 0 }, config: {} },
    { id: "finish", type: "end", position: { x: 240, y: 0 }, config: { fields: [] } },
  ],
  edges: [{ id: "start-finish", source: "start", target: "finish" }],
};

/** Create, save and publish one graph. Only a published version is startable. */
async function publishGraph(session: WorkflowSession, name: string): Promise<string> {
  const created = (await expectData(session, CREATE_DEFINITION, { input: { name } }))
    .createWorkflowDefinition as { id: string; updatedAt: string };

  const saved = (
    await expectData(session, SAVE_VERSION, {
      input: {
        definitionId: created.id,
        expectedUpdatedAt: created.updatedAt,
        definition: LINEAR_GRAPH,
      },
    })
  ).saveWorkflowDefinitionVersion as { latestVersion: number };
  expect(saved.latestVersion).toBe(1);

  const published = (
    await expectData(session, PUBLISH_VERSION, {
      input: { definitionId: created.id, version: 1 },
    })
  ).publishWorkflowDefinitionVersion as { publishedAt: string | null };
  expect(published.publishedAt).not.toBeNull();

  return created.id;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * A queued run, as the queue records it.
 *
 * The timestamp columns are read as booleans rather than values: what the
 * assertions need is whether a lock is held, whether a backoff is still in the
 * future, and whether a terminal row has stopped scheduling itself — never the
 * instant itself, which would only invite comparing clocks.
 */
type CommandRow = {
  id: string;
  status: string;
  attempts: number;
  lockedBy: string | null;
  locked: boolean;
  backingOff: boolean;
  lastError: string | null;
  idempotencyKey: string | null;
};

async function readCommand(commandId: string): Promise<CommandRow> {
  const result = await sql<{
    id: string;
    status: string;
    attempts: number;
    locked_by: string | null;
    locked: boolean;
    backing_off: boolean;
    last_error: string | null;
    idempotency_key: string | null;
  }>`
    select
      id::text,
      status,
      attempts,
      locked_by,
      (locked_at is not null) as locked,
      (next_attempt_at is not null and next_attempt_at > now()) as backing_off,
      last_error,
      idempotency_key
    from workflow.control_commands
    where id = cast(${commandId} as uuid)
  `.execute(suite.runtime.db);

  const row = result.rows[0];
  if (!row) throw new Error(`no workflow.control_commands row for ${commandId}`);
  return {
    id: row.id,
    status: row.status,
    attempts: row.attempts,
    lockedBy: row.locked_by,
    locked: row.locked,
    backingOff: row.backing_off,
    lastError: row.last_error,
    idempotencyKey: row.idempotency_key,
  };
}

/** How many rows one tenant owns in a table the queue writes. */
async function countRows(
  table: "workflow.control_commands" | "workflow.instances",
  tenantId: string,
): Promise<number> {
  const relation = table === "workflow.control_commands"
    ? sql`workflow.control_commands`
    : sql`workflow.instances`;
  const result = await sql<{ count: number }>`
    select count(*)::int as count from ${relation}
    where tenant_id = cast(${tenantId} as uuid)
  `.execute(suite.runtime.db);
  return result.rows[0]?.count ?? 0;
}

type NodeStateRow = {
  nodeId: string;
  status: string;
  completedAt: string | null;
};

async function readNodeStates(
  session: WorkflowSession,
  instanceId: string,
): Promise<NodeStateRow[]> {
  return withDbSession(suite.runtime.db, session, async (trx, scoped) => {
    const rows = await trx
      .selectFrom("workflow.node_states")
      .select(["node_id", "status", "completed_at"])
      .where("tenant_id", "=", scoped.tenantId)
      .where("instance_id", "=", instanceId)
      .orderBy("node_id", "asc")
      .execute();
    return rows.map((row) => ({
      nodeId: row.node_id,
      status: row.status,
      completedAt: row.completed_at,
    }));
  });
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

async function startCommandId(
  session: WorkflowSession,
  instanceId: string,
): Promise<string> {
  return withDbSession(suite.runtime.db, session, async (trx, scoped) => {
    const row = await trx
      .selectFrom("workflow.control_commands")
      .select(["id"])
      .where("tenant_id", "=", scoped.tenantId)
      .where("workflow_instance_id", "=", instanceId)
      .where("command_type", "=", "workflow.instance.start")
      .executeTakeFirstOrThrow();
    return row.id;
  });
}

// ---------------------------------------------------------------------------
// Fixtures the worker cannot produce on its own
// ---------------------------------------------------------------------------

/**
 * Backdate a claim so the reclaim path sees a worker that never came back.
 *
 * There is no other way in: a crashed worker is, from the database's side,
 * exactly a `processing` row whose `locked_at` has aged past the visibility
 * timeout, and waiting out a real timeout is not something a test can do.
 */
async function forceProcessing(
  commandId: string,
  input: { lockedBy: string; lockedAgoMs: number; attempts: number },
) {
  await sql`
    update workflow.control_commands
    set
      status = 'processing',
      attempts = ${input.attempts},
      locked_by = ${input.lockedBy},
      locked_at = now() - (${input.lockedAgoMs} || ' milliseconds')::interval,
      next_attempt_at = null
    where id = cast(${commandId} as uuid)
  `.execute(suite.runtime.db);
}

/**
 * Bring a backed-off retry forward. `markCommandFailed` schedules the next
 * attempt thirty seconds out, which is the right interval for an outage and the
 * wrong one for a test; moving `next_attempt_at` to now is the same thing as
 * time passing, and it is the only column the pending branch of the claim reads.
 */
async function expireBackoff(commandId: string) {
  await sql`
    update workflow.control_commands
    set next_attempt_at = now()
    where id = cast(${commandId} as uuid)
  `.execute(suite.runtime.db);
}

// ---------------------------------------------------------------------------
// Driving the worker
// ---------------------------------------------------------------------------

/**
 * A dispatcher that records what the claim handed it and does nothing else.
 *
 * The tests about the CLAIM want the claim and not a run: a real dispatch would
 * move the instance, the node states and the command row all at once, and an
 * assertion about which rows were claimed would be reading three mechanisms at
 * a time.
 */
function recordingDispatcher(): WorkflowControlCommandDispatcher & {
  seen: WorkflowControlCommand[];
} {
  const seen: WorkflowControlCommand[] = [];
  return {
    seen,
    dispatch: async (command) => {
      seen.push(command);
    },
  };
}

/** A dispatcher standing in for one that is simply down. */
function failingDispatcher(message: string): WorkflowControlCommandDispatcher {
  return {
    dispatch: async () => {
      throw new Error(message);
    },
  };
}

function runBatch(
  dispatcher: WorkflowControlCommandDispatcher,
  options: WorkerOptions = {},
): Promise<{ processed: number }> {
  return suite.worker.processWorkflowControlCommandBatch(suite.runtime.db, dispatcher, {
    workerId: `worker-${randomUUID()}`,
    batchSize: 10,
    maxAttempts: 5,
    processingTimeoutMs: VISIBILITY_TIMEOUT_MS,
    ...options,
  });
}

/** The dispatcher a deployment with no durable-execution service would get. */
function defaultDispatcher(): WorkflowControlCommandDispatcher {
  return suite.worker.createWorkflowControlCommandDispatcher(suite.runtime.db, {});
}

/**
 * Poll a read until it satisfies a predicate. Used only where the subject is the
 * worker's own loop: waiting on the row the loop is supposed to move is the
 * assertion, and a fixed sleep would either be flaky or slower than the property
 * it is proving.
 */
async function waitFor<TValue>(
  read: () => Promise<TValue>,
  predicate: (value: TValue) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<TValue> {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!predicate(latest)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}; last read: ${JSON.stringify(latest)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    latest = await read();
  }
  return latest;
}

/**
 * Fail loudly instead of hanging. A claim that WAITED on a locked row rather
 * than skipping it would block until the holder let go, and the holder below is
 * only released after the claim returns — so without this the defect would
 * present as the whole file timing out with nothing to read.
 */
async function withDeadline<TValue>(
  work: Promise<TValue>,
  timeoutMs: number,
  label: string,
): Promise<TValue> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Enqueuing, over the shipped start path
// ---------------------------------------------------------------------------

type QueuedStart = { instanceId: string; commandId: string };

/**
 * Ask for a run through the mutation path a caller would use, and stop there.
 * Nothing has executed when this returns: the instance is `starting` and the
 * command is `pending`, which is the only state a worker is ever handed.
 */
async function enqueueStart(
  session: WorkflowSession,
  definitionId: string,
): Promise<QueuedStart> {
  const instance = await suite.commands.enqueueWorkflowInstanceStart(
    suite.runtime.db,
    session,
    { definitionId, context: {} },
  );
  expect(instance.status).toBe("starting");
  const commandId = await startCommandId(session, instance.id);
  expect((await readCommand(commandId)).status).toBe("pending");
  return { instanceId: instance.id, commandId };
}

/**
 * Enqueue a start under an idempotency key, the way a caller that may be
 * delivered twice has to.
 *
 * The key is stamped on afterwards because no shipped start path supplies one:
 * `enqueueWorkflowInstanceStartInTransaction` never sets `idempotency_key`, and
 * neither the public mutation nor the webhook route passes one down — see the
 * header of the duplicate-enqueue test. What is under test here is the queue's
 * side of the bargain, which is shipped: the unique index on
 * (tenant_id, idempotency_key), and a worker that runs the surviving row once.
 *
 * The existence check precedes the insert rather than following a conflict
 * because the instance row is written first and carries the command's foreign
 * key; a caller that discovers the duplicate only when the command insert loses
 * would already have stranded an instance in `starting` with nothing to run it.
 */
async function enqueueKeyedStart(
  session: WorkflowSession,
  definitionId: string,
  idempotencyKey: string,
): Promise<QueuedStart & { inserted: boolean }> {
  return withDbSession(suite.runtime.db, session, async (trx, scoped) => {
    const existing = await trx
      .selectFrom("workflow.control_commands")
      .select(["id", "workflow_instance_id"])
      .where("tenant_id", "=", scoped.tenantId)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (existing) {
      return {
        commandId: existing.id,
        instanceId: existing.workflow_instance_id as string,
        inserted: false,
      };
    }

    const started = await suite.commands.enqueueWorkflowInstanceStartInTransaction(
      trx,
      scoped.tenantId,
      { definitionId, startedBy: scoped.userId, context: {} },
    );
    await sql`
      update workflow.control_commands
      set idempotency_key = ${idempotencyKey}
      where id = cast(${started.commandId} as uuid)
        and tenant_id = cast(${scoped.tenantId} as uuid)
    `.execute(trx);

    return { commandId: started.commandId, instanceId: started.instanceId, inserted: true };
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

/**
 * Leave the queue empty. The claim spans tenants by design, so a row one test
 * leaves claimable is work the next test's poll would take — the counts and
 * `processed` values below would then depend on execution order. Cleanup only;
 * nothing here is asserted.
 */
afterEach(async () => {
  await sql`
    delete from workflow.control_commands
    where status in ('pending', 'processing')
  `.execute(suite.runtime.db);
});

describe("workflow control command worker", () => {
  test(
    "one worker poll drains an enqueued start and the run completes",
    async () => {
      const session = writerSession();
      const definitionId = await publishGraph(session, "worker drain");

      const queued = await enqueueStart(session, definitionId);
      // Enqueuing is not running. If either of these already showed a run, the
      // queue would be decorative and the poll below would prove nothing.
      expect((await readInstance(session, queued.instanceId)).status).toBe("starting");
      expect(await readNodeStates(session, queued.instanceId)).toEqual([]);

      // The dispatcher a default deployment gets — no Restate contract in the
      // environment, so this resolves to the in-process one. Nothing in this
      // test names a command; the claim finds the row.
      const result = await runBatch(defaultDispatcher());
      expect(result.processed).toBe(1);

      const instance = await readInstance(session, queued.instanceId);
      expect(instance.status).toBe("completed");
      expect(instance.completedAt).not.toBeNull();

      const states = await readNodeStates(session, queued.instanceId);
      expect(states.map((state) => state.nodeId)).toEqual(["finish", "start"]);
      expect(states.map((state) => state.status)).toEqual(["completed", "completed"]);
      expect(states.every((state) => state.completedAt !== null)).toBe(true);

      const command = await readCommand(queued.commandId);
      expect(command.status).toBe("completed");
      // One claim, and the lock released. A row left locked after a successful
      // drain would be reclaimed by the next poll once the timeout passed.
      expect(command.attempts).toBe(1);
      expect(command.locked).toBe(false);
      expect(command.lockedBy).toBeNull();
      expect(command.lastError).toBeNull();
    },
    TEST_TIMEOUT,
  );

  test(
    "the polling loop drains a queue nobody dispatched, and stopping it stops the draining",
    async () => {
      const session = writerSession();
      const definitionId = await publishGraph(session, "worker loop");
      const queued = await enqueueStart(session, definitionId);

      const worker = suite.worker.startWorkflowControlCommandWorker(
        suite.runtime.db,
        defaultDispatcher(),
        {
          workerId: `loop-${randomUUID()}`,
          batchSize: 5,
          pollIntervalMs: 25,
          maxAttempts: 3,
          processingTimeoutMs: VISIBILITY_TIMEOUT_MS,
        },
      );

      try {
        await waitFor(
          () => readInstance(session, queued.instanceId),
          (instance) => instance.status === "completed",
          "the loop to drain the enqueued start",
        );
      } finally {
        await worker.stop();
      }

      expect((await readNodeStates(session, queued.instanceId)).map((s) => s.nodeId)).toEqual([
        "finish",
        "start",
      ]);
      expect((await readCommand(queued.commandId)).status).toBe("completed");

      // A stop that only stopped scheduling the NEXT tick would leave a timer
      // running, and a leaked worker claims the rows of every test after this
      // one. The window is short on purpose: the loop polls every 25ms, so a
      // live worker would have had several chances at this row.
      const afterStop = await enqueueStart(session, definitionId);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect((await readInstance(session, afterStop.instanceId)).status).toBe("starting");
      expect((await readCommand(afterStop.commandId)).status).toBe("pending");

      // Drained explicitly, so the row does not outlive the test as work.
      expect((await runBatch(defaultDispatcher())).processed).toBe(1);
      expect((await readInstance(session, afterStop.instanceId)).status).toBe("completed");
    },
    TEST_TIMEOUT,
  );

  test(
    "two polls racing for one pending command claim it exactly once",
    async () => {
      const session = writerSession();
      const definitionId = await publishGraph(session, "worker race");
      const queued = await enqueueStart(session, definitionId);

      const first = recordingDispatcher();
      const second = recordingDispatcher();
      const [firstResult, secondResult] = await Promise.all([
        runBatch(first, { workerId: "worker-a" }),
        runBatch(second, { workerId: "worker-b" }),
      ]);

      // The claim is what decides, so the two polls between them must have
      // dispatched the command once — never twice, and never zero times because
      // both deferred to the other.
      expect(firstResult.processed + secondResult.processed).toBe(1);
      expect([...first.seen, ...second.seen].map((command) => command.id)).toEqual([
        queued.commandId,
      ]);

      // The counter is the durable evidence: the claim increments it, so a value
      // of one says one poll won the row no matter which one it was.
      const command = await readCommand(queued.commandId);
      expect(command.attempts).toBe(1);
      expect(command.status).toBe("completed");
    },
    TEST_TIMEOUT,
  );

  test(
    "a command another transaction holds is skipped, not waited on, and survives to be claimed",
    async () => {
      const session = writerSession();
      const definitionId = await publishGraph(session, "worker skip locked");
      const queued = await enqueueStart(session, definitionId);

      let signalHeld: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });

      const holder = suite.runtime.db.transaction().execute(async (trx) => {
        await sql`
          select id from workflow.control_commands
          where id = cast(${queued.commandId} as uuid)
          for update
        `.execute(trx);
        signalHeld();
        await released;
      });

      await held;
      const dispatcher = recordingDispatcher();
      try {
        // Under a plain `for update` this call blocks until the holder commits,
        // and the holder is waiting on this call — so the deadline is what turns
        // the missing SKIP LOCKED into a readable failure.
        const blocked = await withDeadline(
          runBatch(dispatcher),
          10_000,
          "a poll over a row held by another transaction",
        );
        expect(blocked.processed).toBe(0);
        expect(dispatcher.seen).toEqual([]);
        // Skipped, not consumed: the row is untouched and still owed a run.
        expect(await readCommand(queued.commandId)).toMatchObject({
          status: "pending",
          attempts: 0,
        });
      } finally {
        // Whatever happened above, the holder has to let go: it is sitting on a
        // pooled connection and a row lock, and leaking either would turn one
        // failed assertion here into a hang in every test after it.
        release();
        await holder;
      }

      expect((await runBatch(defaultDispatcher())).processed).toBe(1);
      expect((await readInstance(session, queued.instanceId)).status).toBe("completed");
    },
    TEST_TIMEOUT,
  );

  test(
    "a dead worker's claim is reclaimed while a live worker's claim is left alone",
    async () => {
      const session = writerSession();
      const definitionId = await publishGraph(session, "worker reclaim");
      const maxAttempts = 5;
      const abandoned = await enqueueStart(session, definitionId);
      const inFlight = await enqueueStart(session, definitionId);
      const exhausted = await enqueueStart(session, definitionId);

      // Three `processing` rows that differ only in `locked_at` and `attempts`,
      // which between them are all the evidence the claim has.
      await forceProcessing(abandoned.commandId, {
        lockedBy: "dead-worker",
        lockedAgoMs: VISIBILITY_TIMEOUT_MS * 10,
        attempts: 1,
      });
      await forceProcessing(inFlight.commandId, {
        lockedBy: "live-worker",
        lockedAgoMs: 0,
        attempts: 1,
      });
      await forceProcessing(exhausted.commandId, {
        lockedBy: "dead-worker",
        lockedAgoMs: VISIBILITY_TIMEOUT_MS * 10,
        attempts: maxAttempts,
      });

      const dispatcher = recordingDispatcher();
      const result = await runBatch(dispatcher, { workerId: "reclaimer", maxAttempts });

      // Exactly the stale one. Taking the live worker's row too would not lose
      // work, it would duplicate it — the same command run twice against the
      // same instance, which is the more expensive way for a reclaim to be
      // wrong.
      expect(result.processed).toBe(1);
      expect(dispatcher.seen.map((command) => command.id)).toEqual([abandoned.commandId]);

      const reclaimed = await readCommand(abandoned.commandId);
      // The reclaim is an attempt like any other. That is what bounds a command
      // which kills whichever worker picks it up.
      expect(reclaimed.attempts).toBe(2);
      expect(reclaimed.status).toBe("completed");

      const untouched = await readCommand(inFlight.commandId);
      expect(untouched.status).toBe("processing");
      expect(untouched.attempts).toBe(1);
      expect(untouched.lockedBy).toBe("live-worker");

      // Where that bound leaves a command it could never dispatch. The reclaim
      // clause requires `attempts < maxAttempts`, so this row stops being
      // claimed — the intended end of the loop. It must not stop as a
      // `processing` row: that is indistinguishable from work in flight, and an
      // alert on stuck commands could not tell the two apart. Both exhaustion
      // paths now end the same way, `failed` with the reason attached, and the
      // claim marker is cleared as on every other terminal outcome — the dead
      // worker's id is preserved in the error, where an operator will look.
      const stuck = await readCommand(exhausted.commandId);
      expect(stuck.status).toBe("failed");
      expect(stuck.attempts).toBe(maxAttempts);
      expect(stuck.lockedBy).toBeNull();
      expect(stuck.lastError).toContain("dead-worker");
      expect(stuck.lastError).toContain("without a worker reporting back");
    },
    TEST_TIMEOUT,
  );

  test(
    "a dispatcher that always throws stops at maxAttempts instead of cycling",
    async () => {
      const session = writerSession();
      const definitionId = await publishGraph(session, "worker retry");
      const queued = await enqueueStart(session, definitionId);

      const dispatcher = failingDispatcher("workflow dispatcher is unavailable");
      const maxAttempts = 3;

      for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
        expect((await runBatch(dispatcher, { maxAttempts })).processed).toBe(1);
        const row = await readCommand(queued.commandId);
        expect(row.attempts).toBe(attempt);
        // Back to pending, not failed: the outage may be over by the next poll.
        expect(row.status).toBe("pending");
        expect(row.locked).toBe(false);
        expect(row.lastError).toContain("workflow dispatcher is unavailable");
        // And not immediately claimable — an unbounded-rate retry is how one
        // broken command becomes the whole worker's workload.
        expect(row.backingOff).toBe(true);
        await expireBackoff(queued.commandId);
      }

      expect((await runBatch(dispatcher, { maxAttempts })).processed).toBe(1);
      const terminal = await readCommand(queued.commandId);
      expect(terminal.attempts).toBe(maxAttempts);
      expect(terminal.status).toBe("failed");
      expect(terminal.lastError).toContain("workflow dispatcher is unavailable");
      // Terminal means terminal: no next attempt is scheduled, so the row stops
      // being work and starts being a report.
      expect(terminal.backingOff).toBe(false);

      // A further poll finds nothing. This is the assertion the whole test is
      // for: the failure is bounded, and the queue does not cycle.
      expect((await runBatch(dispatcher, { maxAttempts })).processed).toBe(0);
      expect(await readCommand(queued.commandId)).toMatchObject({
        attempts: maxAttempts,
        status: "failed",
      });

      // The run never happened, and nothing pretended it had. A command the
      // queue could not dispatch must leave the instance exactly as enqueued.
      expect((await readInstance(session, queued.instanceId)).status).toBe("starting");
      expect(await readNodeStates(session, queued.instanceId)).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  test(
    "a duplicate enqueue under one idempotency key becomes one command and one run",
    async () => {
      const session = writerSession();
      const definitionId = await publishGraph(session, "worker idempotent enqueue");
      const key = `start:${randomUUID()}`;

      const first = await enqueueKeyedStart(session, definitionId, key);
      const second = await enqueueKeyedStart(session, definitionId, key);

      expect(first.inserted).toBe(true);
      // The second delivery resolves to the first run rather than opening one of
      // its own — a webhook retried by its sender must not double the work.
      expect(second.inserted).toBe(false);
      expect(second.instanceId).toBe(first.instanceId);
      expect(second.commandId).toBe(first.commandId);
      expect(await countRows("workflow.control_commands", session.tenantId)).toBe(1);
      expect(await countRows("workflow.instances", session.tenantId)).toBe(1);

      // The durable half of that guarantee is the unique index, not the read
      // above: two concurrent enqueues would both find nothing, and only one of
      // their inserts can survive.
      const conflicting = await sql<{ id: string }>`
        insert into workflow.control_commands (
          id, tenant_id, command_type, workflow_instance_id, idempotency_key, payload, status
        ) values (
          gen_random_uuid(),
          cast(${session.tenantId} as uuid),
          'workflow.instance.start',
          cast(${first.instanceId} as uuid),
          ${key},
          '{}'::jsonb,
          'pending'
        )
        on conflict (tenant_id, idempotency_key) do nothing
        returning id::text
      `.execute(suite.runtime.db);
      expect(conflicting.rows).toEqual([]);

      expect((await runBatch(defaultDispatcher())).processed).toBe(1);
      expect((await readInstance(session, first.instanceId)).status).toBe("completed");
      expect((await readNodeStates(session, first.instanceId)).map((s) => s.nodeId)).toEqual([
        "finish",
        "start",
      ]);
      expect((await readCommand(first.commandId)).idempotencyKey).toBe(key);

      // Nothing left over that a later poll could turn into a second run.
      expect((await runBatch(defaultDispatcher())).processed).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "a drained command is not run again, by a later poll or by a reclaim",
    async () => {
      const session = writerSession();
      const definitionId = await publishGraph(session, "worker no double run");
      const queued = await enqueueStart(session, definitionId);

      expect((await runBatch(defaultDispatcher())).processed).toBe(1);
      const states = await readNodeStates(session, queued.instanceId);
      const instance = await readInstance(session, queued.instanceId);
      expect(instance.status).toBe("completed");

      // A drained command is no longer claimable, so an idle poll is a no-op.
      expect((await runBatch(defaultDispatcher())).processed).toBe(0);
      expect(await readNodeStates(session, queued.instanceId)).toEqual(states);
      expect(await readInstance(session, queued.instanceId)).toEqual(instance);

      // The harder case, and the one the visibility timeout makes real: a
      // dispatch that outlives `processingTimeoutMs` has its row reclaimed while
      // the run it started is already finished. The redelivery is claimed and
      // dispatched for real — what stops it is the instance's terminal status,
      // taken under a row lock before anything is decided.
      await forceProcessing(queued.commandId, {
        lockedBy: "worker-that-lost-its-row",
        lockedAgoMs: VISIBILITY_TIMEOUT_MS * 10,
        attempts: 1,
      });
      const redelivered = await runBatch(defaultDispatcher());
      expect(redelivered.processed).toBe(1);

      // Timestamps included: a second walk would rewrite `completed_at` on every
      // node even where the statuses came out identical.
      expect(await readNodeStates(session, queued.instanceId)).toEqual(states);
      expect(await readInstance(session, queued.instanceId)).toEqual(instance);
    },
    TEST_TIMEOUT,
  );
});
