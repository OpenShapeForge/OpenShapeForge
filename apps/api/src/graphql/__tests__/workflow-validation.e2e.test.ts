// SPDX-License-Identifier: BUSL-1.1
/**
 * What the workflow definition surface refuses, and — more usefully — what it
 * does not.
 *
 * Three things are proved here, over a scratch database with the workflow
 * module loaded and initialised, because all three are decisions rather than
 * consequences and nothing else in the suite would notice them changing.
 *
 * **Severity is the contract, not the issue list.** `valid` is false only when
 * an issue is an error, so which rules are errors and which are warnings
 * decides what a caller can publish. The two warnings are warnings on purpose,
 * and both say something about this deployment rather than about the graph: a
 * node type the catalog does not know may simply mean a designer is ahead of
 * the catalog, and a catalogued type with no bridge here is what every domain
 * node pack looks like until a host repo implements it. Both still have to be
 * reported, which is why the warnings are pinned rather than merely tolerated.
 *
 * Every other rule is an error, and each one names a run-time failure it
 * prevents. The handle rules are the ones worth having a test for: such a graph
 * is well-formed and walks fine until the unwired branch happens to win, so it
 * used to publish clean and die later on a path nobody exercised.
 *
 * **Draft and publish are deliberately asymmetric.** A draft is allowed to be
 * broken — half-wired, mid-thought, saved because the author is going home — so
 * `saveWorkflowDefinitionVersion` never validates. A published version is what
 * new runs start from, so publishing the very same version is refused. A patch
 * sits with publish rather than with save: it is a deliberate edit with a known
 * intent, so producing a broken graph means the intent was wrong.
 *
 * **What is still not checked is pinned too.** Cycles are outside the pass's
 * scope, and reachability is inside it only as a warning, so a clean result
 * still does not mean a workflow that runs. That gap is recorded here so nobody
 * has to rediscover it from a definition that validated and then did nothing.
 *
 * The node catalog is part of the subject, not scaffolding: an unhydrated store
 * resolves every node type to "unknown", which downgrades the type check to a
 * warning and would let this whole file pass while checking nothing. It is
 * hydrated by the module's own `init`, exactly as it is at boot. The bridge
 * registry is subject too — `UNIMPLEMENTED_NODE_TYPE` is read off it — and the
 * same `init` registers it, so what is asserted below is the answer a booted
 * process gives rather than one an empty registry would.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/graphql/__tests__/workflow-validation.e2e.test.ts 2>&1
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { graphql, type GraphQLSchema } from "graphql";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { initRuntimeModules, loadRuntimeModules } from "../../modules/registry.js";
import { buildGraphqlSchema } from "../schema.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const TEST_TIMEOUT = 90_000;

const scratchName = `wf_validation_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
if (!/^[a-z0-9_]+$/.test(scratchName)) {
  throw new Error(`unsafe scratch database name: ${scratchName}`);
}

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  url.pathname = `/${scratchName}`;
  return url.toString();
}

/**
 * One writer for the whole file. `directie` is the realm role that may author
 * workflows at all; tenant and user are real UUIDs because the database session
 * layer validates the version and variant nibbles before it will set the tenant
 * GUC, and a placeholder string is rejected there rather than here.
 */
const writer = {
  tenantId: randomUUID(),
  userId: randomUUID(),
  roles: ["directie"],
  groups: [] as string[],
  scope: "tenant" as const,
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Harness = { runtime: DatabaseRuntime; schema: GraphQLSchema };

let admin: SQL | null = null;
let harnessPromise: Promise<Harness> | null = null;

/**
 * Built on first use rather than in `beforeAll`, so the migration chain runs
 * inside a test's own generous timeout instead of bun's default hook budget.
 * bun runs a file's tests sequentially, so exactly one of them pays for it.
 */
function harness(): Promise<Harness> {
  harnessPromise ??= startHarness();
  return harnessPromise;
}

async function startHarness(): Promise<Harness> {
  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${scratchName}"`);

  const modules = await loadRuntimeModules();
  expect(modules.failures).toEqual([]);
  const moduleSeeds = modules.loaded.flatMap((module) => module.seeds ?? []);

  const runtime = createDatabaseRuntime({ databaseUrl: scratchUrl(), maxConnections: 4 });
  await runtime.db.connection().execute((conn) => runMigrationChain(conn, { moduleSeeds }));

  // A module that fails to initialise is dropped from the registry, and its
  // GraphQL fields with it — the schema would then be missing the surface under
  // test rather than answering wrongly, so assert before building.
  const initialised = await initRuntimeModules(modules, { db: runtime.db });
  expect(initialised.failures).toEqual([]);

  return { runtime, schema: buildGraphqlSchema(initialised.loaded, { db: runtime.db }) };
}

afterAll(async () => {
  await harnessPromise?.then((active) => active.runtime.close()).catch(() => {});
  // FORCE (Postgres 13+) kills any straggling scratch connections.
  await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
  await admin?.close();
});

async function run(source: string, variables: Record<string, unknown> = {}) {
  const { runtime, schema } = await harness();
  return graphql({
    schema,
    source,
    variableValues: variables,
    contextValue: { db: runtime.db, session: writer },
  });
}

async function expectData(
  source: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const result = await run(source, variables);
  expect(result.errors ?? []).toEqual([]);
  expect(result.data).toBeTruthy();
  return result.data as Record<string, any>;
}

/** The code, never the message: the message is for humans and free to change. */
async function expectErrorCode(
  source: string,
  variables: Record<string, unknown> = {},
): Promise<unknown> {
  const result = await run(source, variables);
  return result.errors?.[0]?.extensions?.["code"];
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const VALIDATE_DEFINITION = /* GraphQL */ `
  mutation ValidateDefinition($definition: JSON!) {
    validateWorkflowDefinition(definition: $definition) {
      valid
      issues {
        severity
        code
        path
        nodeId
        edgeId
      }
    }
  }
`;

const CREATE_DEFINITION = /* GraphQL */ `
  mutation CreateDefinition($input: CreateWorkflowDefinitionInput!) {
    createWorkflowDefinition(input: $input) {
      id
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
    }
  }
`;

const PATCH_DEFINITION = /* GraphQL */ `
  mutation PatchDefinition($input: PatchWorkflowDefinitionInput!) {
    patchWorkflowDefinition(input: $input) {
      dryRun
      definition
      validation {
        valid
        issues {
          severity
          code
        }
      }
      savedDefinition {
        latestVersion
        updatedAt
      }
    }
  }
`;

const READ_DEFINITION = /* GraphQL */ `
  query ReadDefinition($id: ID!) {
    workflowDefinition(id: $id) {
      id
      updatedAt
      latestVersion
      publishedVersion
    }
  }
`;

const READ_VERSION = /* GraphQL */ `
  query ReadVersion($definitionId: ID!, $version: Int!) {
    workflowDefinitionVersion(definitionId: $definitionId, version: $version) {
      version
      definition
    }
  }
`;

type ValidationIssue = {
  severity: string;
  code: string;
  path: string;
  nodeId: string | null;
  edgeId: string | null;
};

type ValidationResult = { valid: boolean; issues: ValidationIssue[] };

type DefinitionHandle = {
  id: string;
  updatedAt: string;
  latestVersion: number | null;
  publishedVersion: number | null;
};

async function validate(definition: unknown): Promise<ValidationResult> {
  const data = await expectData(VALIDATE_DEFINITION, { definition });
  return data.validateWorkflowDefinition as ValidationResult;
}

function codesOf(result: ValidationResult, severity: "error" | "warning"): string[] {
  return result.issues
    .filter((issue) => issue.severity === severity)
    .map((issue) => issue.code);
}

async function createDefinition(name: string): Promise<DefinitionHandle> {
  const data = await expectData(CREATE_DEFINITION, { input: { name } });
  return data.createWorkflowDefinition as DefinitionHandle;
}

/** Saves a draft against the handle's own token and returns the moved handle. */
async function saveDraft(
  handle: DefinitionHandle,
  definition: unknown,
): Promise<DefinitionHandle> {
  const data = await expectData(SAVE_VERSION, {
    input: { definitionId: handle.id, expectedUpdatedAt: handle.updatedAt, definition },
  });
  return data.saveWorkflowDefinitionVersion as DefinitionHandle;
}

async function readDefinition(id: string): Promise<DefinitionHandle> {
  const data = await expectData(READ_DEFINITION, { id });
  return data.workflowDefinition as DefinitionHandle;
}

async function readVersionGraph(definitionId: string, version: number): Promise<unknown> {
  const data = await expectData(READ_VERSION, { definitionId, version });
  return data.workflowDefinitionVersion.definition as unknown;
}

function nodeIds(graph: unknown): string[] {
  return ((graph as { nodes?: { id?: string }[] }).nodes ?? []).map((node) => node.id ?? "");
}

function edgeIds(graph: unknown): string[] {
  return ((graph as { edges?: { id?: string }[] }).edges ?? []).map((edge) => edge.id ?? "");
}

function edgeTarget(graph: unknown, edgeId: string): string | undefined {
  const edges = (graph as { edges?: { id?: string; target?: string }[] }).edges ?? [];
  return edges.find((edge) => edge.id === edgeId)?.target;
}

// A trigger, an end, one edge: the smallest graph the validator has nothing to
// say about, and the base every patch test starts from.
const LINEAR_GRAPH = {
  nodes: [
    { id: "start", type: "triggerManual" },
    { id: "finish", type: "end" },
  ],
  edges: [{ id: "start-finish", source: "start", target: "finish" }],
};

const THREE_NODE_GRAPH = {
  nodes: [
    { id: "start", type: "triggerManual" },
    { id: "wait", type: "timer" },
    { id: "finish", type: "end" },
  ],
  edges: [
    { id: "start-wait", source: "start", target: "wait" },
    { id: "wait-finish", source: "wait", target: "finish" },
  ],
};

/** An edge to a node that is not there: one error, and nothing else. */
const BROKEN_GRAPH = {
  nodes: [{ id: "start", type: "triggerManual" }],
  edges: [{ id: "dangling", source: "start", target: "finish" }],
};

/**
 * Well-formed, walkable, and one branch short. The decision emits `approved`
 * and `rejected`; only `approved` is wired, so every run where the condition
 * holds succeeds and the first one where it does not dies with
 * NO_EDGE_FOR_HANDLE. This is the graph the orphan-handle promotion exists for.
 */
const LATENT_ORPHAN_GRAPH = {
  nodes: [
    { id: "start", type: "triggerManual" },
    {
      id: "choice",
      type: "decision",
      config: { branches: [{ handle: "approved" }], defaultEdgeId: "rejected" },
    },
    { id: "finish", type: "end" },
  ],
  edges: [
    { id: "in", source: "start", target: "choice" },
    { id: "approved", source: "choice", target: "finish", sourceHandle: "approved" },
  ],
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateWorkflowDefinition", () => {
  test(
    "a well-formed graph validates clean",
    async () => {
      const result = await validate(LINEAR_GRAPH);
      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  // One row per error rule. `valid` false is the half a caller keys on; the
  // code is the half a caller reports, and only asserting both distinguishes
  // "the graph was refused" from "the graph was refused for this reason".
  const ERROR_RULES: { code: string; definition: unknown }[] = [
    { code: "MISSING_NODES", definition: { edges: [] } },
    { code: "MISSING_EDGES", definition: { nodes: [] } },
    { code: "MISSING_NODE_ID", definition: { nodes: [{ type: "end" }], edges: [] } },
    {
      code: "DUPLICATE_NODE_ID",
      definition: {
        nodes: [
          { id: "twice", type: "end" },
          { id: "twice", type: "end" },
        ],
        edges: [],
      },
    },
    { code: "MISSING_NODE_TYPE", definition: { nodes: [{ id: "untyped" }], edges: [] } },
    {
      code: "MISSING_EDGE_SOURCE",
      definition: {
        nodes: [{ id: "finish", type: "end" }],
        edges: [{ id: "sourceless", target: "finish" }],
      },
    },
    {
      code: "UNKNOWN_EDGE_SOURCE",
      definition: {
        nodes: [{ id: "finish", type: "end" }],
        edges: [{ id: "from-ghost", source: "ghost", target: "finish" }],
      },
    },
    {
      code: "MISSING_EDGE_TARGET",
      definition: {
        nodes: [{ id: "start", type: "triggerManual" }],
        edges: [{ id: "targetless", source: "start" }],
      },
    },
    {
      code: "UNKNOWN_EDGE_TARGET",
      definition: {
        nodes: [{ id: "start", type: "triggerManual" }],
        edges: [{ id: "to-ghost", source: "start", target: "ghost" }],
      },
    },
  ];

  for (const rule of ERROR_RULES) {
    test(
      `${rule.code} is an error and makes the definition invalid`,
      async () => {
        const result = await validate(rule.definition);
        expect(result.valid).toBe(false);
        expect(codesOf(result, "error")).toContain(rule.code);
      },
      TEST_TIMEOUT,
    );
  }

  test(
    "a node type the catalog does not know is a warning, so the draft stays valid",
    async () => {
      const result = await validate({
        nodes: [{ id: "mystery", type: "notInTheCatalog" }],
        edges: [],
      });

      // Deliberate, and the reason this is pinned: a type this deployment does
      // not ship must not block saving a draft, but it must not pass silently
      // either. Promoting it to an error would break every designer that is
      // ahead of the catalog; dropping it would hide a node nothing can run.
      expect(result.valid).toBe(true);
      expect(codesOf(result, "error")).toEqual([]);
      const unknown = result.issues.find((issue) => issue.code === "UNKNOWN_NODE_TYPE");
      expect(unknown?.severity).toBe("warning");
      expect(unknown?.nodeId).toBe("mystery");
    },
    TEST_TIMEOUT,
  );

  test(
    "a catalogued node type with no bridge is a warning, so the graph still publishes",
    async () => {
      // The distinction that keeps the domain node packs usable. `condition` is
      // catalogued and has no bridge in this deployment, which is exactly what
      // a pack node looks like in a host repo that has not implemented it yet.
      // Refusing here would make shipping a pack pointless; the run fails with
      // NO_BRIDGE naming the type, which is the honest answer for a capability
      // nobody supplied.
      const result = await validate({
        nodes: [
          { id: "start", type: "triggerManual" },
          { id: "gate", type: "condition" },
          { id: "finish", type: "end" },
        ],
        edges: [
          { id: "in", source: "start", target: "gate" },
          { id: "out", source: "gate", target: "finish" },
        ],
      });

      expect(result.valid).toBe(true);
      expect(codesOf(result, "warning")).toEqual(["UNIMPLEMENTED_NODE_TYPE"]);
    },
    TEST_TIMEOUT,
  );

  test(
    "a node type the engine cannot run at all is an error, bridge or no bridge",
    async () => {
      // `join` describes fan-out. The engine holds a single cursor and
      // `workflow.node_states` has no branch identity, so no bridge would make
      // this graph runnable — which is why it sits on the other side of the
      // line from `condition` above.
      const result = await validate({
        nodes: [
          { id: "start", type: "triggerManual" },
          { id: "gather", type: "join" },
          { id: "finish", type: "end" },
        ],
        edges: [
          { id: "in", source: "start", target: "gather" },
          { id: "out", source: "gather", target: "finish" },
        ],
      });

      expect(result.valid).toBe(false);
      expect(codesOf(result, "error")).toEqual(["UNSUPPORTED_NODE_TYPE"]);
    },
    TEST_TIMEOUT,
  );

  test(
    "two edges on one source handle are ambiguous, and an absent handle IS the default",
    async () => {
      const result = await validate({
        nodes: [
          { id: "start", type: "triggerManual" },
          { id: "left", type: "end" },
          { id: "right", type: "end" },
        ],
        edges: [
          // No handle at all, which the validator reads as "default" …
          { id: "implicit", source: "start", target: "left" },
          // … so this explicit spelling of the same handle collides with it.
          { id: "explicit", source: "start", target: "right", sourceHandle: "default" },
        ],
      });

      // An error: `selectNextEdge` raises AMBIGUOUS_EDGES_FOR_HANDLE and fails
      // the run rather than choosing an arm, so this graph cannot be walked.
      expect(result.valid).toBe(false);
      expect(codesOf(result, "error")).toEqual(["AMBIGUOUS_EDGE_HANDLE"]);
    },
    TEST_TIMEOUT,
  );

  test(
    "an edge on a handle the decision node never emits is an orphan edge handle",
    async () => {
      const result = await validate({
        nodes: [
          { id: "start", type: "triggerManual" },
          {
            id: "choice",
            type: "decision",
            config: { branches: [{ handle: "approved" }], defaultEdgeId: "otherwise" },
          },
          { id: "finish", type: "end" },
        ],
        edges: [
          { id: "in", source: "start", target: "choice" },
          { id: "approved", source: "choice", target: "finish", sourceHandle: "approved" },
          { id: "otherwise", source: "choice", target: "finish", sourceHandle: "otherwise" },
          { id: "stray", source: "choice", target: "finish", sourceHandle: "maybe" },
        ],
      });

      // A dangling reference, the same class as UNKNOWN_EDGE_TARGET.
      expect(result.valid).toBe(false);
      // Both declared handles are wired, so the sole error is the stray edge:
      // an exact list also proves the node-side rule did not fire by accident.
      expect(codesOf(result, "error")).toEqual(["ORPHAN_EDGE_HANDLE"]);
    },
    TEST_TIMEOUT,
  );

  test(
    "a declared handle with no outgoing edge is an orphan node handle",
    async () => {
      const result = await validate({
        nodes: [
          { id: "start", type: "triggerManual" },
          {
            id: "choice",
            type: "decision",
            config: {
              branches: [{ handle: "wired" }, { targetEdgeId: "byEdgeId" }, { id: "byId" }],
              defaultEdgeId: "otherwise",
            },
          },
          { id: "finish", type: "end" },
        ],
        edges: [
          { id: "in", source: "start", target: "choice" },
          { id: "wired", source: "choice", target: "finish", sourceHandle: "wired" },
        ],
      });

      expect(result.valid).toBe(false);
      // Three unwired handles: the two branches declared through the fallback
      // spellings plus the named default. The count is what pins the
      // `handle ?? targetEdgeId ?? id` chain — losing a link would leave two.
      expect(codesOf(result, "error")).toEqual([
        "ORPHAN_NODE_HANDLE",
        "ORPHAN_NODE_HANDLE",
        "ORPHAN_NODE_HANDLE",
      ]);
    },
    TEST_TIMEOUT,
  );

  test(
    "a decision without defaultEdgeId still emits a default handle that needs wiring",
    async () => {
      const result = await validate({
        nodes: [
          { id: "start", type: "triggerManual" },
          { id: "choice", type: "decision", config: { branches: [{ id: "only" }] } },
          { id: "finish", type: "end" },
        ],
        edges: [
          { id: "in", source: "start", target: "choice" },
          { id: "only", source: "choice", target: "finish", sourceHandle: "only" },
        ],
      });

      expect(result.valid).toBe(false);
      // The no-match fallback exists whether or not the author named it.
      expect(codesOf(result, "error")).toEqual(["ORPHAN_NODE_HANDLE"]);
    },
    TEST_TIMEOUT,
  );

  test(
    "an edge into a trigger node is an error, an edge out of one is how graphs begin",
    async () => {
      // A trigger is an entry point, never a step: the engine raises
      // ENTRY_TYPE_MISMATCH the moment a walk arrives at one along an edge.
      const backEdge = await validate({
        nodes: [
          { id: "start", type: "triggerManual" },
          { id: "finish", type: "end" },
        ],
        edges: [
          { id: "forward", source: "start", target: "finish" },
          { id: "back", source: "finish", target: "start" },
        ],
      });

      expect(backEdge.valid).toBe(false);
      expect(codesOf(backEdge, "error")).toEqual(["TRIGGER_NOT_ENTRY"]);
      expect(
        backEdge.issues.find((issue) => issue.code === "TRIGGER_NOT_ENTRY")?.edgeId,
      ).toBe("back");

      // The contrast, because a rule written against the wrong end of the edge
      // would refuse every workflow ever drawn.
      expect(codesOf(await validate(LINEAR_GRAPH), "error")).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  test(
    "a node no entry node reaches is a warning, and so is a graph with no trigger",
    async () => {
      // An unreached node is dead weight rather than a failure — the walk never
      // arrives — and a half-drawn draft is indistinguishable from a finished
      // graph with a leftover node, so refusing would refuse ordinary work.
      const unreachable = await validate({
        nodes: [
          { id: "start", type: "triggerManual" },
          { id: "finish", type: "end" },
          { id: "island", type: "timer" },
        ],
        edges: [{ id: "start-finish", source: "start", target: "finish" }],
      });
      expect(unreachable.valid).toBe(true);
      expect(codesOf(unreachable, "warning")).toEqual(["UNREACHABLE_NODE"]);
      expect(
        unreachable.issues.find((issue) => issue.code === "UNREACHABLE_NODE")?.nodeId,
      ).toBe("island");

      // A graph with no entry node has no finding of its own: every node comes
      // back unreachable instead, which names what an author has to attach.
      // `pickEntryNode` answers null for such a graph and the run is a no-op,
      // so this stays a warning.
      const triggerless = await validate({
        nodes: [{ id: "finish", type: "end" }],
        edges: [],
      });
      expect(triggerless.valid).toBe(true);
      expect(codesOf(triggerless, "warning")).toEqual(["UNREACHABLE_NODE"]);
    },
    TEST_TIMEOUT,
  );

  test(
    "a decision authored with the `conditions` alias is read the same as `branches`",
    async () => {
      // Against the real catalog, so the alias comes from `flow/decision.yaml`
      // rather than from a fixture. The runtime accepts `conditions` as a
      // spelling of `branches` and canonicalises it before the bridge runs, so
      // a validator reading the raw key saw a decision with no branches: the
      // unwired handle went unreported, and the wired one was reported as an
      // edge to a handle the node never emits — a false error that, now that
      // these are errors, would refuse to publish a correct workflow.
      const wired = await validate({
        nodes: [
          { id: "start", type: "triggerManual" },
          {
            id: "choice",
            type: "decision",
            config: { conditions: [{ handle: "approved" }], defaultEdgeId: "rejected" },
          },
          { id: "finish", type: "end" },
        ],
        edges: [
          { id: "in", source: "start", target: "choice" },
          { id: "approved", source: "choice", target: "finish", sourceHandle: "approved" },
          { id: "rejected", source: "choice", target: "finish", sourceHandle: "rejected" },
        ],
      });
      expect(wired.valid).toBe(true);
      expect(wired.issues).toEqual([]);

      // And the other direction: the aliased branch's handle is now owed an
      // edge, so dropping it is reported exactly as the canonical spelling is.
      const unwired = await validate({
        nodes: [
          { id: "start", type: "triggerManual" },
          {
            id: "choice",
            type: "decision",
            config: { conditions: [{ handle: "approved" }], defaultEdgeId: "rejected" },
          },
          { id: "finish", type: "end" },
        ],
        edges: [
          { id: "in", source: "start", target: "choice" },
          { id: "rejected", source: "choice", target: "finish", sourceHandle: "rejected" },
        ],
      });
      expect(codesOf(unwired, "error")).toEqual(["ORPHAN_NODE_HANDLE"]);
    },
    TEST_TIMEOUT,
  );

  test(
    "cycles are still NOT checked",
    async () => {
      // Guarding what is left of the pass's documented scope, not endorsing it.
      // This graph loops forever and validates clean; the engine's visit cap is
      // the only thing that stops such a run. Recorded here so a clean result
      // is never read as "this workflow ends".
      const cyclic = await validate({
        nodes: [
          { id: "start", type: "triggerManual" },
          { id: "left", type: "timer" },
          { id: "right", type: "timer" },
        ],
        edges: [
          { id: "in", source: "start", target: "left" },
          { id: "there", source: "left", target: "right" },
          { id: "back", source: "right", target: "left" },
        ],
      });

      expect(cyclic.valid).toBe(true);
      expect(codesOf(cyclic, "warning")).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Draft versus publish
// ---------------------------------------------------------------------------

describe("saving versus publishing", () => {
  test(
    "a draft carrying an error-severity issue is saved anyway",
    async () => {
      const issues = await validate(BROKEN_GRAPH);
      expect(codesOf(issues, "error")).toEqual(["UNKNOWN_EDGE_TARGET"]);

      const created = await createDefinition("draft-may-be-broken");
      const saved = await saveDraft(created, BROKEN_GRAPH);

      expect(saved.latestVersion).toBe(1);
      expect(saved.publishedVersion).toBeNull();
    },
    TEST_TIMEOUT,
  );

  test(
    "publishing that same version is refused",
    async () => {
      const created = await createDefinition("publish-refuses-broken");
      const broken = await saveDraft(created, BROKEN_GRAPH);
      expect(broken.latestVersion).toBe(1);

      const code = await expectErrorCode(PUBLISH_VERSION, {
        input: { definitionId: created.id, version: 1 },
      });
      expect(code).toBe("BAD_USER_INPUT");
      expect((await readDefinition(created.id)).publishedVersion).toBeNull();

      // The contrast is the point: publish is not simply refusing everything.
      // Repair the graph, save it as version 2, and the same call goes through.
      const repaired = await saveDraft(broken, LINEAR_GRAPH);
      expect(repaired.latestVersion).toBe(2);
      const data = await expectData(PUBLISH_VERSION, {
        input: { definitionId: created.id, version: 2 },
      });
      expect(data.publishWorkflowDefinitionVersion.version).toBe(2);
      expect((await readDefinition(created.id)).publishedVersion).toBe(2);
    },
    TEST_TIMEOUT,
  );

  test(
    "a graph with a latent unwired branch saves, and is refused at publish",
    async () => {
      // The behaviour change, end to end. This graph is well-formed: nothing
      // dangles, every id resolves, and it ran to completion for every input
      // that took the wired branch. It published clean while the orphan-handle
      // rules were warnings, and the run it eventually killed failed far from
      // the edit that caused it.
      const created = await createDefinition("publish-refuses-latent-orphan");
      const saved = await saveDraft(created, LATENT_ORPHAN_GRAPH);

      // Saving is untouched, and that asymmetry is deliberate rather than an
      // oversight: a draft is where an author leaves work half-wired, so a rule
      // that blocked the save would lose the graph instead of fixing it.
      expect(saved.latestVersion).toBe(1);

      const code = await expectErrorCode(PUBLISH_VERSION, {
        input: { definitionId: created.id, version: 1 },
      });
      expect(code).toBe("BAD_USER_INPUT");
      expect((await readDefinition(created.id)).publishedVersion).toBeNull();

      // Wire the branch and the same version's successor publishes, so what is
      // being refused is the missing edge and not the decision node.
      const repaired = await saveDraft(saved, {
        ...LATENT_ORPHAN_GRAPH,
        edges: [
          ...LATENT_ORPHAN_GRAPH.edges,
          { id: "rejected", source: "choice", target: "finish", sourceHandle: "rejected" },
        ],
      });
      expect(repaired.latestVersion).toBe(2);
      const data = await expectData(PUBLISH_VERSION, {
        input: { definitionId: created.id, version: 2 },
      });
      expect(data.publishWorkflowDefinitionVersion.version).toBe(2);
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Patch
// ---------------------------------------------------------------------------

describe("patchWorkflowDefinition", () => {
  /** A definition holding `graph` as version 1, with a fresh token. */
  async function definitionHolding(name: string, graph: unknown): Promise<DefinitionHandle> {
    const created = await createDefinition(name);
    const saved = await saveDraft(created, graph);
    expect(saved.latestVersion).toBe(1);
    return saved;
  }

  test(
    "dryRun returns the resulting graph and its validation without writing",
    async () => {
      const definition = await definitionHolding("patch-dry-run", LINEAR_GRAPH);
      const data = await expectData(PATCH_DEFINITION, {
        input: {
          definitionId: definition.id,
          expectedUpdatedAt: definition.updatedAt,
          dryRun: true,
          operations: [
            { op: "upsertNode", nodeId: "wait", node: { id: "wait", type: "timer" } },
          ],
        },
      });

      const patch = data.patchWorkflowDefinition;
      expect(patch.dryRun).toBe(true);
      expect(nodeIds(patch.definition)).toEqual(["start", "finish", "wait"]);
      expect(patch.validation.valid).toBe(true);
      expect(patch.savedDefinition).toBeNull();

      // The whole claim of dryRun: the caller was shown an outcome that the
      // stored definition never took on.
      expect((await readDefinition(definition.id)).latestVersion).toBe(1);
    },
    TEST_TIMEOUT,
  );

  test(
    "a patch saves a new version whose stored graph carries the change",
    async () => {
      const definition = await definitionHolding("patch-writes", LINEAR_GRAPH);
      const data = await expectData(PATCH_DEFINITION, {
        input: {
          definitionId: definition.id,
          expectedUpdatedAt: definition.updatedAt,
          operations: [
            { op: "upsertNode", nodeId: "wait", node: { id: "wait", type: "timer" } },
            // Upsert by id, so this re-points the existing edge rather than
            // adding a second one out of "start".
            {
              op: "upsertEdge",
              edgeId: "start-finish",
              edge: { id: "start-finish", source: "start", target: "wait" },
            },
            {
              op: "upsertEdge",
              edgeId: "wait-finish",
              edge: { id: "wait-finish", source: "wait", target: "finish" },
            },
          ],
        },
      });

      const patch = data.patchWorkflowDefinition;
      expect(patch.dryRun).toBe(false);
      expect(patch.savedDefinition.latestVersion).toBe(2);

      const stored = await readVersionGraph(definition.id, 2);
      expect(nodeIds(stored)).toEqual(["start", "finish", "wait"]);
      expect(edgeIds(stored)).toEqual(["start-finish", "wait-finish"]);
      expect(edgeTarget(stored, "start-finish")).toBe("wait");
    },
    TEST_TIMEOUT,
  );

  test(
    "deleting a node takes the edges that referenced it with it",
    async () => {
      const definition = await definitionHolding("patch-cascade", THREE_NODE_GRAPH);
      const data = await expectData(PATCH_DEFINITION, {
        input: {
          definitionId: definition.id,
          expectedUpdatedAt: definition.updatedAt,
          operations: [{ op: "deleteNode", nodeId: "wait" }],
        },
      });

      const patch = data.patchWorkflowDefinition;
      expect(nodeIds(patch.definition)).toEqual(["start", "finish"]);
      // Both edges named the deleted node. Leaving either behind would dangle,
      // and the patch would then refuse its own result — which is why deleting
      // through a patch exists rather than posting a whole document and hoping
      // the caller reproduced this rule.
      expect(edgeIds(patch.definition)).toEqual([]);
      expect(patch.validation.valid).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "a patch built against a stale token is refused",
    async () => {
      const created = await createDefinition("patch-stale-token");
      const staleToken = created.updatedAt;
      const moved = await saveDraft(created, LINEAR_GRAPH);
      expect(moved.updatedAt).not.toBe(staleToken);

      const code = await expectErrorCode(PATCH_DEFINITION, {
        input: {
          definitionId: created.id,
          expectedUpdatedAt: staleToken,
          operations: [
            { op: "upsertNode", nodeId: "wait", node: { id: "wait", type: "timer" } },
          ],
        },
      });

      expect(code).toBe("CONCURRENT_MODIFICATION");
      expect((await readDefinition(created.id)).latestVersion).toBe(1);
    },
    TEST_TIMEOUT,
  );

  test(
    "a patch that would produce an invalid graph is refused and writes nothing",
    async () => {
      const definition = await definitionHolding("patch-invalid-result", LINEAR_GRAPH);
      const code = await expectErrorCode(PATCH_DEFINITION, {
        input: {
          definitionId: definition.id,
          expectedUpdatedAt: definition.updatedAt,
          operations: [
            {
              op: "upsertEdge",
              edgeId: "into-nowhere",
              edge: { id: "into-nowhere", source: "start", target: "nowhere" },
            },
          ],
        },
      });

      // The asymmetry with a hand-authored draft: the same graph would have
      // been stored by saveWorkflowDefinitionVersion. A patch states an intent,
      // so a broken result means the intent was wrong.
      expect(code).toBe("BAD_USER_INPUT");
      expect((await readDefinition(definition.id)).latestVersion).toBe(1);
    },
    TEST_TIMEOUT,
  );
});
