// SPDX-License-Identifier: BUSL-1.1
/**
 * The ports a canvas draws, against the handles the server says a node emits.
 *
 * `bridge-handle-agreement.test.ts` pins the bridge against the validator. This
 * pins the third account of the same set: the one an author actually sees. A
 * port is what a user is allowed to wire, so a canvas that derives handles its
 * own way decides what graphs can be drawn — and the two ways it can be wrong
 * are not symmetric:
 *
 * - **A port the node never emits** is the expensive one. The author wires it,
 *   the graph validates (the edge names a handle the config declares, because
 *   the canvas took it from the same config), it publishes, and every run that
 *   reaches that branch dies with NO_EDGE_FOR_HANDLE on the arm that was
 *   supposed to catch it. Back-filling a decision's ports from its edges
 *   produces exactly this: draw an edge, and the port it names becomes real.
 * - **A missing port** is merely obstructive: a branch nobody can wire, which
 *   the server then reports as ORPHAN_NODE_HANDLE at publish.
 *
 * So the assertion is equality with `declaredOutputHandles`, in both
 * directions, over the same awkward configs the bridge test uses — plus the
 * cases only a canvas has: a node type nothing declares handles for, where
 * edge-derived is the only available answer, and a terminal node, where the
 * answer is none.
 *
 * `declaredOutputHandles` is module-private, and ORPHAN_NODE_HANDLE is its only
 * public view. It is also the only view an author gets, which is what makes it
 * the right thing to compare against.
 *
 * Needs `bun run generate` to have run: the alias metadata this file turns on is
 * compiler output read from the node-catalog seed. The gate order already does
 * that.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/web/__tests__/canvas-handle-agreement.test.ts 2>&1
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeCatalogSeed from "../../../../../apps/api/src/generated/workflow/node-catalog.seed.json" with { type: "json" };
import { defaultOutputHandles } from "../../../../../packages/workflow-layout/src/defaults.js";
import { validateWorkflowDefinition } from "../../runtime/definition-validation.js";
import { resetNodeCatalogForTests } from "../../runtime/node-catalog-store.js";
import { resolveCanvasNodeHandles, toCanvasNodes } from "../graph/index.js";
import { normalizeDefinitionGraph } from "../../runtime/definition-types.js";

const NODE_ID = "node-under-test";

/**
 * The catalog the API would have read out of Postgres, minus Postgres. The
 * validator resolves node types and alias metadata through the store, so it has
 * to be standing for any of this to mean anything.
 */
beforeAll(() => {
  resetNodeCatalogForTests(
    nodeCatalogSeed.entries.map((entry) => ({ ...entry, catalog: nodeCatalogSeed.catalog })),
  );
});

// Back to unhydrated: `bun test` shares module state across files, and a store
// left standing would make another file's reads succeed for the wrong reason.
afterAll(() => {
  resetNodeCatalogForTests();
});

/**
 * The catalog's config fields for a node type, as a browser would receive them.
 *
 * The adapter cannot call `canonicalizeWorkflowNodeConfigAliases` — that reads
 * the process-global catalog store, which is hydrated from Postgres in the API
 * process and THROWS anywhere else. So the alias metadata is passed in, and
 * this is the shape a designer already has: `workflowNodeTypes.configFields`
 * off the plugin's own GraphQL surface is these same records.
 */
function configFieldsOf(nodeType: string): readonly unknown[] | undefined {
  return nodeCatalogSeed.entries.find((entry) => entry.nodeType === nodeType)?.configFields;
}

function resolveConfigFields(nodeType: string): readonly unknown[] | undefined {
  return configFieldsOf(nodeType);
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * The handles the server says this node can emit, read back out of the only
 * public view of `declaredOutputHandles`.
 *
 * With no edges on the graph every declared handle is unwired, so each produces
 * exactly one ORPHAN_NODE_HANDLE naming it. Reading the handle out of the
 * message is the fragile part and it fails safe: a reworded message yields
 * fewer handles, and the equality below breaks loudly rather than passing on an
 * empty set.
 */
function declaredHandles(nodeType: string, config: Record<string, unknown>): string[] {
  const result = validateWorkflowDefinition({
    nodes: [{ id: NODE_ID, type: nodeType, config }],
    edges: [],
  });
  const handles: string[] = [];
  for (const issue of result.issues) {
    if (issue.code !== "ORPHAN_NODE_HANDLE" || issue.nodeId !== NODE_ID) continue;
    const named = /output handle "([^"]*)"/.exec(issue.message);
    if (named) handles.push(named[1]!);
  }
  return sorted(handles);
}

function canvasHandles(
  nodeType: string,
  config: Record<string, unknown>,
  outgoingEdges: { sourceHandle?: string | null }[] = [],
): string[] {
  return sorted(
    resolveCanvasNodeHandles({
      nodeType,
      config,
      configFields: resolveConfigFields(nodeType),
      outgoingEdges,
    }).map((handle) => handle.id),
  );
}

// ---------------------------------------------------------------------------
// decision: the canvas and the validator, on the same config
// ---------------------------------------------------------------------------

/**
 * The same shapes `bridge-handle-agreement.test.ts` drives its two derivations
 * with, because they were chosen for where the three-deep fallback chain, the
 * trimming and the default's own fallback can come apart — and a third
 * derivation has the same seams.
 */
const DECISION_CONFIGS: { name: string; config: Record<string, unknown> }[] = [
  {
    name: "explicit branch handles",
    config: {
      branches: [{ id: "b1", handle: "approved" }, { id: "b2", handle: "rejected" }],
      defaultEdgeId: "unknown",
    },
  },
  {
    name: "handle falls back to targetEdgeId, then to id",
    config: {
      branches: [
        { id: "b1", handle: "explicit", targetEdgeId: "outranked" },
        { id: "b2", targetEdgeId: "from-target-edge" },
        { id: "from-branch-id" },
      ],
    },
  },
  {
    name: "a blank candidate falls through to the next one, and survivors are trimmed",
    config: {
      branches: [{ id: "b1", handle: "   ", targetEdgeId: "  padded  " }],
      defaultEdgeId: "  also-padded ",
    },
  },
  {
    name: "a branch naming no handle at all is skipped",
    config: { branches: [{ label: "nameless" }, { id: "b2", handle: "reachable" }] },
  },
  {
    name: "the default handle when none is configured",
    config: { branches: [{ id: "b1", handle: "only" }] },
  },
  {
    name: "a defaultEdgeId that collides with a branch handle",
    config: { branches: [{ id: "b1", handle: "shared" }], defaultEdgeId: "shared" },
  },
  {
    name: "no branches configured at all",
    config: { defaultEdgeId: "fallthrough" },
  },
  {
    name: "branches stored as something other than an array",
    config: { branches: "not-an-array" },
  },
  {
    name: "branches under the catalog's `conditions` alias",
    config: {
      // `decision.yaml` declares `conditions` as a runtime alias for `branches`.
      // The validator canonicalises before reading; a canvas that does not sees
      // a decision with no branches and draws only the default port, so every
      // authored branch becomes unwireable.
      conditions: [{ id: "approve", handle: "approve" }],
      defaultEdgeId: "reject",
    },
  },
];

describe("decision: the canvas draws exactly the handles the server declares", () => {
  for (const scenario of DECISION_CONFIGS) {
    test(scenario.name, () => {
      const declared = declaredHandles("decision", scenario.config);
      // Non-empty, so this cannot pass because the extraction above found
      // nothing to compare.
      expect(declared.length).toBeGreaterThan(0);
      expect(canvasHandles("decision", scenario.config)).toEqual(declared);
    });
  }
});

describe("decision: ports come from the config and never from the edges", () => {
  const CONFIG = { branches: [{ id: "b1", handle: "approve" }], defaultEdgeId: "reject" };

  test("an edge naming an undeclared handle does not create a port for it", () => {
    // The expensive direction. A back-filled port is one the author can wire
    // and the bridge will never select, so the run dead-ends on that arm alone
    // — after the graph has validated and published clean.
    expect(
      canvasHandles("decision", CONFIG, [{ sourceHandle: "typo" }, { sourceHandle: "approve" }]),
    ).toEqual(["approve", "reject"]);
  });

  test("a decision with no edges at all still draws every branch", () => {
    // The other direction, and the reason a decision cannot use the
    // edge-derived fallback: an unwired branch has no edge to be derived from,
    // and it is exactly the branch the author has come here to wire.
    expect(canvasHandles("decision", CONFIG, [])).toEqual(["approve", "reject"]);
  });

  test("branch order is the document's, because it is the evaluation order", () => {
    // Not sorted, unlike the edge-derived fallback. Branches are first-match-wins,
    // so the order the author wrote them in is meaning rather than presentation,
    // and re-sorting the ports would show a priority the runtime does not use.
    const handles = resolveCanvasNodeHandles({
      nodeType: "decision",
      config: {
        branches: [{ id: "zeta", handle: "zeta" }, { id: "alpha", handle: "alpha" }],
        defaultEdgeId: "omega",
      },
      outgoingEdges: [],
    });
    expect(handles.map((handle) => handle.id)).toEqual(["zeta", "alpha", "omega"]);
  });

  test("a branch label is the port label, matching what the run reports", () => {
    // `selectDecisionOutcome` returns `selectedBranchLabel` on the same
    // fallback chain. A port labelled one thing and an execution log labelled
    // another describes the same route twice, differently.
    const handles = resolveCanvasNodeHandles({
      nodeType: "decision",
      config: {
        branches: [
          { id: "b1", handle: "approve", label: "Approved by manager" },
          { id: "named-by-id", handle: "h2" },
        ],
      },
      outgoingEdges: [],
    });
    expect(handles).toEqual([
      { id: "approve", label: "Approved by manager" },
      { id: "h2", label: "named-by-id" },
      { id: "default", label: "Default" },
    ]);
  });
});

describe("decision: without the catalog's alias metadata, aliased branches are invisible", () => {
  test("the degradation is real, and it is the caller's choice", () => {
    const aliased = { conditions: [{ id: "approve", handle: "approve" }], defaultEdgeId: "reject" };

    // Documented rather than papered over: the alias map is compiler output the
    // API serves, and a caller that does not supply it gets a canvas that
    // disagrees with the server about this one node type. Pinned so the
    // consequence is visible in the test suite rather than discovered in a
    // designer, and so a future change that removes the option has to delete
    // this case deliberately.
    expect(
      resolveCanvasNodeHandles({ nodeType: "decision", config: aliased, outgoingEdges: [] }).map(
        (handle) => handle.id,
      ),
    ).toEqual(["reject"]);

    expect(canvasHandles("decision", aliased)).toEqual(declaredHandles("decision", aliased));
  });
});

// ---------------------------------------------------------------------------
// Everything else: the catalog serves no handles, so the edges do
// ---------------------------------------------------------------------------

describe("node types nothing declares handles for fall back to their edges", () => {
  test("the validator declares nothing for them, which is why the fallback exists", () => {
    // The premise. `declaredOutputHandles` returns null for every type but
    // `decision`, and the node catalog carries no handle metadata at all — no
    // seed entry has an outputHandles field — so the document's edges are the
    // only evidence available about which ports a node has.
    expect(declaredHandles("action", { branches: [{ id: "b1", handle: "x" }] })).toEqual([]);
    expect(
      nodeCatalogSeed.entries.some((entry) => "outputHandles" in entry),
    ).toBe(false);
  });

  test("the fallback is the layout package's, not a second copy of it", () => {
    // Shared rather than reimplemented: the port order this produces is the
    // port order ELK lays out against, and two derivations of it would place
    // edges on ports the geometry was not computed for.
    const outgoingEdges = [
      { sourceHandle: "error" },
      { sourceHandle: null },
      { sourceHandle: "error" },
    ];
    expect(
      resolveCanvasNodeHandles({ nodeType: "action", config: {}, outgoingEdges }),
    ).toEqual(defaultOutputHandles({ node: { type: "action" }, outgoingEdges }));
  });

  test("a node with no outgoing edges still gets somewhere to wire from", () => {
    expect(canvasHandles("action", {}, [])).toEqual(["default"]);
  });

  test("a terminal node gets no ports", () => {
    // The process runtime stops at a node whose type starts with `end`, so
    // there is no handle to select and nothing to wire. Drawing a port there
    // invites an edge out of a node the walk never leaves.
    expect(canvasHandles("end", {}, [])).toEqual([]);
    expect(canvasHandles("end.cancelled", {}, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The same derivation, reached through the graph adapter
// ---------------------------------------------------------------------------

describe("toCanvasNodes resolves handles the same way", () => {
  test("a decision's ports come from its own config, its neighbours' edges ignored", () => {
    const base = normalizeDefinitionGraph({
      nodes: [
        { id: "t", type: "triggerManual" },
        {
          id: "d",
          type: "decision",
          config: { conditions: [{ id: "b1", handle: "approve" }], defaultEdgeId: "reject" },
        },
        { id: "x", type: "end" },
      ],
      edges: [
        { source: "t", target: "d" },
        { source: "d", target: "x", sourceHandle: "invented" },
      ],
    });

    const byId = new Map(
      toCanvasNodes(base, { resolveConfigFields }).map((node) => [node.id, node] as const),
    );

    expect(byId.get("d")!.data.outputHandles.map((handle) => handle.id)).toEqual([
      "approve",
      "reject",
    ]);
    // The trigger's single unlabelled edge, read as `default`, which is what
    // `selectNextEdge` matches it on.
    expect(byId.get("t")!.data.outputHandles.map((handle) => handle.id)).toEqual(["default"]);
    expect(byId.get("x")!.data.outputHandles).toEqual([]);
  });
});
