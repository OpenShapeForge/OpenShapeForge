// SPDX-License-Identifier: BUSL-1.1
/**
 * The editing operations, against the rules the server actually holds.
 *
 * Three groups matter more than the rest:
 *
 * - **Edge insertion re-points rather than duplicates.** Splitting an edge and
 *   leaving the original in place produces two edges on one source handle,
 *   which the runtime fails on as AMBIGUOUS_EDGES_FOR_HANDLE. Pinned by id, not
 *   by count, because keeping the id is what stops a patch losing the edge.
 * - **A second edge on a handle is DRAWN, not refused.** The validator puts
 *   AMBIGUOUS_EDGE_HANDLE at `blocksAt: "publish"` deliberately, so that
 *   drawing a replacement before deleting the old edge stays legal. A designer
 *   stricter than the API it saves through is a designer that disagrees with it.
 * - **Config edits re-derive a decision node's ports**, through the same
 *   derivation the read path uses, and never from the edges.
 *
 * The round trip through `toStoredGraph` is asserted here as well as in the
 * adapter's own suite, because these functions are the only writers of the
 * canvas values that path compares against.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/web/editor/__tests__/graph-edit.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import {
  isEntryNodeType,
  isTerminalNodeType,
} from "../../../runtime/definition-types.js";
import { toCanvasEdges, toCanvasNodes, toStoredGraph } from "../../graph/index.js";
import {
  addCanvasNode,
  allocateNodeId,
  connectCanvasNodes,
  createCanvasNode,
  defaultConfigFromFields,
  deleteCanvasEdges,
  deleteCanvasNodes,
  insertCanvasNodeIntoEdge,
  moveCanvasNode,
  setCanvasNodeConfig,
  setCanvasNodeLabel,
  type EditableCanvasGraph,
} from "../graph-edit.js";

const PREDICATES = { isEntry: isEntryNodeType, isTerminal: isTerminalNodeType };

/** A canvas graph as `toCanvasNodes`/`toCanvasEdges` would have produced it. */
function canvasGraph(stored: {
  nodes: unknown[];
  edges: unknown[];
}): EditableCanvasGraph {
  const graph = stored as Parameters<typeof toCanvasNodes>[0];
  return { nodes: toCanvasNodes(graph), edges: toCanvasEdges(graph) };
}

const DECISION_FIELDS = [
  { key: "branches", runtime: { aliases: ["conditions"] }, defaultValue: [] },
  { key: "defaultEdgeId", defaultValue: "default" },
];

describe("createCanvasNode", () => {
  test("takes its config from the catalog's own defaults", () => {
    const node = createCanvasNode({
      nodeType: "timer",
      position: { x: 10, y: 20 },
      graph: { nodes: [], edges: [] },
      configFields: [
        { key: "mode", defaultValue: "duration" },
        { key: "durationAmount", defaultValue: 1 },
        // No default: left ABSENT rather than blanked. Validation reads
        // "absent" differently from an empty string somebody typed.
        { key: "untilAt" },
      ],
    });

    expect(node.data.config).toEqual({ mode: "duration", durationAmount: 1 });
    expect("untilAt" in node.data.config).toBe(false);
  });

  test("copies a mutable default so two nodes cannot edit each other", () => {
    const configFields = [{ key: "branches", defaultValue: [] as unknown[] }];
    const graph: EditableCanvasGraph = { nodes: [], edges: [] };
    const first = createCanvasNode({ nodeType: "decision", position: { x: 0, y: 0 }, graph, configFields });
    const second = createCanvasNode({
      nodeType: "decision",
      position: { x: 0, y: 0 },
      graph: addCanvasNode(graph, first),
      configFields,
    });

    (first.data.config.branches as unknown[]).push({ id: "approve" });
    expect(second.data.config.branches).toEqual([]);
  });

  test("labels itself with the id, which is what server findings name", () => {
    const node = createCanvasNode({
      nodeType: "flow.userInput",
      position: { x: 0, y: 0 },
      graph: { nodes: [], edges: [] },
    });
    expect(node.id).toBe("flow_userinput_1");
    expect(node.data.label).toBe("flow_userinput_1");
  });

  test("a decision's ports come from its config, not from a default pair", () => {
    const node = createCanvasNode({
      nodeType: "decision",
      position: { x: 0, y: 0 },
      graph: { nodes: [], edges: [] },
      configFields: DECISION_FIELDS,
    });
    // Only the fallback, because a new decision declares no branches yet.
    expect(node.data.outputHandles).toEqual([{ id: "default", label: "Default" }]);
  });

  test("a terminal node offers no ports at all", () => {
    const node = createCanvasNode({
      nodeType: "end",
      position: { x: 0, y: 0 },
      graph: { nodes: [], edges: [] },
    });
    expect(node.data.outputHandles).toEqual([]);
  });
});

describe("allocateNodeId", () => {
  test("takes the lowest free counter, so a session does not accumulate gaps", () => {
    expect(allocateNodeId("decision", [{ id: "decision_1" }, { id: "decision_3" }])).toBe(
      "decision_2",
    );
  });

  test("reduces a dotted type to something an id may hold", () => {
    expect(allocateNodeId("workflow.startDefinition", [])).toBe("workflow_startdefinition_1");
  });
});

describe("insertCanvasNodeIntoEdge", () => {
  const base = canvasGraph({
    nodes: [
      { id: "a", type: "triggerManual" },
      { id: "b", type: "end" },
    ],
    edges: [{ id: "e1", source: "a", target: "b", sourceHandle: "next", targetHandle: "in" }],
  });

  test("re-points the split edge, keeping its id, and adds exactly one more", () => {
    const node = createCanvasNode({
      nodeType: "timer",
      position: { x: 5, y: 5 },
      graph: base,
    });
    const next = insertCanvasNodeIntoEdge(base, { node, edgeId: "e1" });

    expect(next.edges).toHaveLength(2);
    const split = next.edges.find((edge) => edge.id === "e1");
    // The id survives. Renumbering it would strand any patch addressing it and
    // rewrite an id the stored document already holds.
    expect(split).toBeDefined();
    expect(split?.source).toBe("a");
    // The source handle is untouched: the edge still leaves `a` by the same
    // port, it just ends somewhere else now.
    expect(split?.sourceHandle).toBe("next");
    expect(split?.target).toBe(node.id);
    // `in` was the port on `b`, not on the node just inserted.
    expect(split?.targetHandle).toBeNull();

    const carried = next.edges.find((edge) => edge.id !== "e1");
    expect(carried?.source).toBe(node.id);
    expect(carried?.target).toBe("b");
    expect(carried?.targetHandle).toBe("in");
  });

  test("leaves exactly one edge on the original source handle", () => {
    // The whole point. Two would be AMBIGUOUS_EDGE_HANDLE at validation and
    // AMBIGUOUS_EDGES_FOR_HANDLE at run time.
    const node = createCanvasNode({ nodeType: "timer", position: { x: 0, y: 0 }, graph: base });
    const next = insertCanvasNodeIntoEdge(base, { node, edgeId: "e1" });
    const fromA = next.edges.filter(
      (edge) => edge.source === "a" && edge.sourceHandle === "next",
    );
    expect(fromA).toHaveLength(1);
  });

  test("names no outgoing handle at all, whatever the node offers", () => {
    // The gesture chose a place, not a port. Picking one would wire an arm the
    // user did not choose and would silence the ORPHAN_NODE_HANDLE that says so.
    const decision = createCanvasNode({
      nodeType: "decision",
      position: { x: 0, y: 0 },
      graph: base,
      configFields: DECISION_FIELDS,
    });
    const withBranches = {
      ...decision,
      data: {
        ...decision.data,
        outputHandles: [
          { id: "approve", label: "Approve" },
          { id: "default", label: "Default" },
        ],
      },
    };
    const multi = insertCanvasNodeIntoEdge(base, { node: withBranches, edgeId: "e1" });
    expect(multi.edges.find((edge) => edge.source === withBranches.id)?.sourceHandle).toBeNull();

    // And a single-output node, where absent and "default" are one document.
    const timer = createCanvasNode({ nodeType: "timer", position: { x: 0, y: 0 }, graph: base });
    const single = insertCanvasNodeIntoEdge(base, { node: timer, edgeId: "e1" });
    expect(single.edges.find((edge) => edge.source === timer.id)?.sourceHandle).toBeNull();
  });

  test("an unknown edge id changes nothing", () => {
    // A stale drop target must not fabricate an edge between nodes the user
    // never connected.
    const node = createCanvasNode({ nodeType: "timer", position: { x: 0, y: 0 }, graph: base });
    expect(insertCanvasNodeIntoEdge(base, { node, edgeId: "gone" })).toBe(base);
  });
});

describe("connectCanvasNodes", () => {
  const graph = canvasGraph({
    nodes: [
      { id: "t", type: "triggerManual" },
      { id: "d", type: "decision" },
      { id: "e", type: "end" },
    ],
    edges: [],
  });

  test("draws an ordinary connection", () => {
    const result = connectCanvasNodes(graph, { source: "t", target: "d" }, PREDICATES);
    expect(result.refused).toBeNull();
    expect(result.warned).toBeNull();
    expect(result.graph.edges).toHaveLength(1);
    // A trigger's only port is "default", so absent and "default" are the same
    // document and absent is the spelling this repo's stored graphs use.
    expect(result.graph.edges[0]?.sourceHandle).toBeNull();
  });

  test("a drag off the sole default port stores absent, not \"default\"", () => {
    // React Flow reports the handle's id, which for a single-output card IS
    // "default" — the card renders `<Handle id={handle.id}>`. Writing it back
    // would materialize a value the user never expressed.
    const result = connectCanvasNodes(
      graph,
      { source: "t", target: "d", sourceHandle: "default" },
      PREDICATES,
    );
    expect(result.graph.edges[0]?.sourceHandle).toBeNull();
  });

  test("a port on a multi-output node is always named", () => {
    // Two reasons, and the second is the one that bites: `selectNextEdge`
    // matches `sourceHandle ?? "default"`, so absent means the port literally
    // called "default" and nothing else; and a canvas redrawing an edge with
    // no handle attaches it to the node's FIRST port, which would move the
    // user's edge on the next reload.
    const branching = canvasGraph({
      nodes: [
        {
          id: "d",
          type: "decision",
          config: { branches: [{ id: "approve" }, { id: "reject" }] },
        },
        { id: "e", type: "end" },
      ],
      edges: [],
    });
    const named = connectCanvasNodes(
      branching,
      { source: "d", target: "e", sourceHandle: "reject" },
      PREDICATES,
    );
    expect(named.graph.edges[0]?.sourceHandle).toBe("reject");

    // Including when the port happens to be called "default": on a node with
    // three ports, absent would not redraw against this one.
    const fallback = connectCanvasNodes(
      branching,
      { source: "d", target: "e", sourceHandle: "default" },
      PREDICATES,
    );
    expect(fallback.graph.edges[0]?.sourceHandle).toBe("default");
  });

  test("a stored \"default\" and a new absent handle are recognised as one handle", () => {
    // Otherwise the ambiguity that refuses a publish goes unreported, because
    // the two edges look like they leave by different ports.
    const withExplicit = canvasGraph({
      nodes: [
        { id: "t", type: "triggerManual" },
        { id: "a", type: "end" },
        { id: "b", type: "end" },
      ],
      edges: [{ id: "e1", source: "t", target: "a", sourceHandle: "default" }],
    });
    const result = connectCanvasNodes(withExplicit, { source: "t", target: "b" }, PREDICATES);
    expect(result.warned).toBe("HANDLE_OCCUPIED");
  });

  test("a second edge on one handle is drawn AND flagged, never refused", () => {
    // The validator puts AMBIGUOUS_EDGE_HANDLE at publish on purpose: this
    // exact state is what "draw the replacement, then delete the old one"
    // looks like halfway through. Refusing it makes one order of operations
    // illegal while the reverse is fine.
    const first = connectCanvasNodes(graph, { source: "t", target: "d" }, PREDICATES);
    const second = connectCanvasNodes(first.graph, { source: "t", target: "e" }, PREDICATES);

    expect(second.refused).toBeNull();
    expect(second.warned).toBe("HANDLE_OCCUPIED");
    expect(second.graph.edges).toHaveLength(2);
  });

  test("a different source handle is not the same handle", () => {
    const first = connectCanvasNodes(
      graph,
      { source: "d", target: "e", sourceHandle: "approve" },
      PREDICATES,
    );
    const second = connectCanvasNodes(
      first.graph,
      { source: "d", target: "e", sourceHandle: "reject" },
      PREDICATES,
    );
    expect(second.warned).toBeNull();
    expect(second.graph.edges).toHaveLength(2);
  });

  test("the identical edge twice adds nothing", () => {
    const first = connectCanvasNodes(graph, { source: "t", target: "d" }, PREDICATES);
    const second = connectCanvasNodes(first.graph, { source: "t", target: "d" }, PREDICATES);
    expect(second.refused).toBe("DUPLICATE_EDGE");
    expect(second.graph).toBe(first.graph);
  });

  test("refuses a self connection", () => {
    // The canvas's own rule: the server has no code for it because a self-edge
    // is a walk that never leaves, not a document that cannot be read.
    const result = connectCanvasNodes(graph, { source: "d", target: "d" }, PREDICATES);
    expect(result.refused).toBe("SELF_CONNECTION");
  });

  test("refuses an edge into a trigger or out of a terminal node", () => {
    expect(connectCanvasNodes(graph, { source: "d", target: "t" }, PREDICATES).refused).toBe(
      "TARGET_IS_ENTRY",
    );
    expect(connectCanvasNodes(graph, { source: "e", target: "d" }, PREDICATES).refused).toBe(
      "SOURCE_IS_TERMINAL",
    );
  });

  test("refuses an endpoint the graph does not hold", () => {
    expect(connectCanvasNodes(graph, { source: "t", target: "ghost" }, PREDICATES).refused).toBe(
      "UNKNOWN_ENDPOINT",
    );
  });

  test("an empty-string handle is treated as absent", () => {
    const result = connectCanvasNodes(
      graph,
      { source: "t", target: "d", sourceHandle: "" },
      PREDICATES,
    );
    expect(result.graph.edges[0]?.sourceHandle).toBeNull();
  });
});

describe("setCanvasNodeConfig", () => {
  test("re-derives a decision's ports from the config it was given", () => {
    const graph = canvasGraph({
      nodes: [{ id: "d", type: "decision", config: { branches: [] } }],
      edges: [],
    });

    const next = setCanvasNodeConfig(graph, {
      nodeId: "d",
      config: {
        branches: [
          { id: "approve", label: "Approve" },
          { id: "reject", label: "Reject" },
        ],
      },
      configFields: DECISION_FIELDS,
    });

    expect(next.nodes[0]?.data.outputHandles).toEqual([
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" },
      { id: "default", label: "Default" },
    ]);
  });

  test("reads branches through the alias the catalog declares", () => {
    // A decision authored under `conditions` has to canonicalise the same way
    // in the designer as in the validator, or its branches are invisible to
    // the canvas that must wire them.
    const graph = canvasGraph({ nodes: [{ id: "d", type: "decision" }], edges: [] });
    const next = setCanvasNodeConfig(graph, {
      nodeId: "d",
      config: { conditions: [{ id: "approve", label: "Approve" }] },
      configFields: DECISION_FIELDS,
    });
    expect(next.nodes[0]?.data.outputHandles.map((handle) => handle.id)).toEqual([
      "approve",
      "default",
    ]);
  });

  test("never invents a port from an edge that names one", () => {
    // A back-filled port validates and publishes, and then strands every run
    // taking that branch.
    const graph = canvasGraph({
      nodes: [
        { id: "d", type: "decision" },
        { id: "e", type: "end" },
      ],
      edges: [{ source: "d", target: "e", sourceHandle: "invented" }],
    });
    const next = setCanvasNodeConfig(graph, { nodeId: "d", config: {}, configFields: DECISION_FIELDS });
    expect(next.nodes[0]?.data.outputHandles.map((handle) => handle.id)).toEqual(["default"]);
  });

  test("replaces the config object, so the save path can see the edit", () => {
    const graph = canvasGraph({
      nodes: [{ id: "n", type: "action", config: { url: "a" } }],
      edges: [],
    });
    const before = graph.nodes[0]?.data.config;
    const next = setCanvasNodeConfig(graph, { nodeId: "n", config: { url: "b" } });
    expect(next.nodes[0]?.data.config).not.toBe(before);
    expect(graph.nodes[0]?.data.config).toEqual({ url: "a" });
  });
});

describe("deleteCanvasNodes", () => {
  test("sweeps the edges the deletion would leave dangling", () => {
    // Here, unlike in `toStoredGraph`, the caller IS the intent: an edge whose
    // endpoint is gone is UNKNOWN_EDGE_TARGET, which refuses the write.
    const graph = canvasGraph({
      nodes: [
        { id: "a", type: "triggerManual" },
        { id: "b", type: "timer" },
        { id: "c", type: "end" },
      ],
      edges: [
        { id: "ab", source: "a", target: "b" },
        { id: "bc", source: "b", target: "c" },
      ],
    });

    const next = deleteCanvasNodes(graph, ["b"]);
    expect(next.nodes.map((node) => node.id)).toEqual(["a", "c"]);
    expect(next.edges).toHaveLength(0);
  });

  test("deleting nothing returns the same graph", () => {
    const graph = canvasGraph({ nodes: [{ id: "a", type: "end" }], edges: [] });
    expect(deleteCanvasNodes(graph, [])).toBe(graph);
    expect(deleteCanvasEdges(graph, [])).toBe(graph);
  });
});

describe("an operation that changes nothing returns the graph it was given", () => {
  // Reference inequality is what `graph-history.ts` reads as "something
  // happened", so a call that removes, moves or writes nothing must not look
  // like an edit merely because it rebuilt an array. Each of these is reachable
  // from the editor: a canvas reports the edges of a deleted node separately
  // from the node, and a drag that ends where it started still reports a
  // position.
  const graph = canvasGraph({
    nodes: [
      { id: "a", type: "triggerManual", position: { x: 10, y: 20 } },
      { id: "b", type: "end" },
    ],
    edges: [{ id: "ab", source: "a", target: "b" }],
  });

  test("removing ids the graph does not hold", () => {
    expect(deleteCanvasNodes(graph, ["gone"])).toBe(graph);
    expect(deleteCanvasEdges(graph, ["gone"])).toBe(graph);
  });

  test("the edges of a node whose deletion already cascaded", () => {
    const deleted = deleteCanvasNodes(graph, ["b"]);
    expect(deleted.edges).toHaveLength(0);
    // The canvas reports the edge removal too. It has already happened.
    expect(deleteCanvasEdges(deleted, ["ab"])).toBe(deleted);
  });

  test("a move to the position a node already occupies", () => {
    expect(moveCanvasNode(graph, { nodeId: "a", position: { x: 10, y: 20 } })).toBe(graph);
    expect(moveCanvasNode(graph, { nodeId: "gone", position: { x: 1, y: 1 } })).toBe(graph);
    expect(moveCanvasNode(graph, { nodeId: "a", position: { x: 10, y: 21 } })).not.toBe(graph);
  });

  test("a label or a config written to a node that is not there", () => {
    expect(setCanvasNodeLabel(graph, { nodeId: "gone", label: "x" })).toBe(graph);
    expect(setCanvasNodeConfig(graph, { nodeId: "gone", config: {} })).toBe(graph);
  });

  test("the label a node already carries", () => {
    const labelled = setCanvasNodeLabel(graph, { nodeId: "a", label: "Start" });
    expect(setCanvasNodeLabel(labelled, { nodeId: "a", label: "Start" })).toBe(labelled);
  });

  test("the config object a node was handed", () => {
    // Handing the same object back is not an edit. A rebuilt but equal one
    // still is — see the module header; the save path compares by reference and
    // cannot tell a rebuild from a change.
    const config = graph.nodes[0]?.data.config as Record<string, unknown>;
    expect(setCanvasNodeConfig(graph, { nodeId: "a", config })).toBe(graph);
    expect(setCanvasNodeConfig(graph, { nodeId: "a", config: { ...config } })).not.toBe(graph);
  });
});

describe("round trip through toStoredGraph", () => {
  const stored = {
    name: "Approval",
    // A key nothing in this repo understands. It has to survive every edit.
    vendorExtension: { retries: 3 },
    nodes: [
      { id: "t", type: "triggerManual", position: { x: 0, y: 0 } },
      { id: "e", type: "end", position: { x: 0, y: 200 } },
    ],
    edges: [{ id: "te", source: "t", target: "e", targetHandle: "carried" }],
  };

  test("adding a node writes only that node", () => {
    const graph = canvasGraph(stored);
    const node = createCanvasNode({
      nodeType: "timer",
      position: { x: 40, y: 100 },
      graph,
      configFields: [{ key: "mode", defaultValue: "duration" }],
    });

    const next = toStoredGraph({
      base: stored as Parameters<typeof toStoredGraph>[0]["base"],
      ...addCanvasNode(graph, node),
      writePositions: true,
    });

    // Read through an index rather than off the type, which is the point: the
    // key is one `WorkflowDefinitionGraph` does not declare and the column
    // carries anyway.
    expect((next as Record<string, unknown>).vendorExtension).toEqual({ retries: 3 });
    expect(next.nodes).toHaveLength(3);
    // The guarantee is the same BYTES, keys and order included — which is
    // stronger than deep equality and is what a jsonb column round-trips.
    expect(JSON.stringify(next.nodes[0])).toBe(JSON.stringify(stored.nodes[0]));
    expect(next.nodes[2]).toEqual({
      id: "timer_1",
      type: "timer",
      config: { mode: "duration" },
      position: { x: 40, y: 100 },
    });
    // Untouched, including the targetHandle nothing reads.
    expect(JSON.stringify(next.edges[0])).toBe(JSON.stringify(stored.edges[0]));
  });

  test("a move with writePositions off does not create a layout", () => {
    // A graph nobody arranged must not acquire an arrangement as a side effect
    // of an edit made for some other reason.
    const unpositioned = { nodes: [{ id: "a", type: "end" }], edges: [] };
    const graph = canvasGraph(unpositioned);
    const moved = moveCanvasNode(graph, { nodeId: "a", position: { x: 90, y: 90 } });

    const off = toStoredGraph({
      base: unpositioned as Parameters<typeof toStoredGraph>[0]["base"],
      ...moved,
    });
    expect(off.nodes[0]).toEqual({ id: "a", type: "end" });

    const on = toStoredGraph({
      base: unpositioned as Parameters<typeof toStoredGraph>[0]["base"],
      ...moved,
      writePositions: true,
    });
    expect(on.nodes[0]).toEqual({ id: "a", type: "end", position: { x: 90, y: 90 } });
  });

  test("a label the designer only displayed is not written back", () => {
    // `toStoredGraph` compares against the same synthesized value the read path
    // produced, so renaming a node to what it was already showing is not an edit.
    const graph = canvasGraph(stored);
    const same = setCanvasNodeLabel(graph, { nodeId: "t", label: "t" });
    const next = toStoredGraph({
      base: stored as Parameters<typeof toStoredGraph>[0]["base"],
      ...same,
    });
    expect("label" in (next.nodes[0] as Record<string, unknown>)).toBe(false);
  });

  test("an inserted node re-points the stored edge in place", () => {
    const graph = canvasGraph(stored);
    const node = createCanvasNode({ nodeType: "timer", position: { x: 0, y: 100 }, graph });
    const next = toStoredGraph({
      base: stored as Parameters<typeof toStoredGraph>[0]["base"],
      ...insertCanvasNodeIntoEdge(graph, { node, edgeId: "te" }),
    });

    expect(next.edges).toHaveLength(2);
    // Same edge object identity in the document: id "te" still, retargeted.
    expect(next.edges[0]?.id).toBe("te");
    expect(next.edges[0]?.target).toBe("timer_1");
    // Cleared rather than blanked, because "" reads as a handle named "".
    expect("targetHandle" in (next.edges[0] as Record<string, unknown>)).toBe(false);
    expect(next.edges[1]).toEqual({ source: "timer_1", target: "e", targetHandle: "carried" });
    // A derived id is never written into the document.
    expect("id" in (next.edges[1] as Record<string, unknown>)).toBe(false);
  });
});

describe("defaultConfigFromFields", () => {
  test("tolerates a configFields the column did not constrain", () => {
    expect(defaultConfigFromFields(null)).toEqual({});
    expect(defaultConfigFromFields("nonsense")).toEqual({});
    expect(defaultConfigFromFields([null, 3, { key: "" }, { key: "a", defaultValue: 1 }])).toEqual({
      a: 1,
    });
  });

  test("a default of null or false is a value, not an absence", () => {
    expect(defaultConfigFromFields([{ key: "a", defaultValue: null }, { key: "b", defaultValue: false }])).toEqual(
      { a: null, b: false },
    );
  });
});
