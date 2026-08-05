// SPDX-License-Identifier: BUSL-1.1
/**
 * A stored graph, drawn on a canvas, saved again — and unchanged.
 *
 * The designer's save path is `stored -> canvas -> stored`. Everything the
 * canvas cannot represent is lost at the second arrow, silently, in a write the
 * user asked for. That is the whole reason this file exists and why it is
 * written as a property over awkward documents rather than as one happy path: a
 * happy path passes with an adapter that rebuilds nodes and edges from scratch,
 * and rebuilding from scratch is precisely the bug.
 *
 * Four things the storage layer promises that a canvas is apt to break:
 *
 * 1. **Unknown keys survive, at every level.** `normalizeDefinitionGraph`
 *    SPREADS the stored record and only forces `nodes` and `edges` to be
 *    arrays, so a document key nothing in this repo reads still round-trips
 *    through a save. `edge.targetHandle` is the live example — it is stored, it
 *    is part of edge identity in `definition-patch.ts`, and no reader consults
 *    it — but the guarantee is general, so the fixtures below carry keys that
 *    are nobody's.
 *
 * 2. **An absent `sourceHandle` is not `"default"`.** Every reader treats them
 *    alike (`selectNextEdge`, `declaredOutputHandles`, `defaultOutputHandles`),
 *    so nothing downstream would complain — which is exactly why a canvas that
 *    materializes one for the other is never caught. It matters because the
 *    canvas does not draw the handle the document names: `resolveElkSourceHandleId`
 *    coerces an edge onto a port that exists so the graph stays drawable, and
 *    writing the DRAWN handle back is how an unwired branch becomes a second
 *    edge on an occupied port. `AMBIGUOUS_EDGE_HANDLE` at validation,
 *    `AMBIGUOUS_EDGES_FOR_HANDLE` at run time.
 *
 * 3. **`label`, `position` and `config` are optional.** A canvas has to
 *    synthesize all three to draw anything at all, and writing a synthesized
 *    value back turns "this graph has no layout" into "this graph has a layout
 *    the canvas guessed", permanently and for every node at once.
 *
 * 4. **Edge ids are optional, and the patch API addresses edges by them.** The
 *    canvas needs unique ids regardless, so they are derived from content — a
 *    counter would renumber on every reload and strand any outstanding patch.
 *
 * Read with `canvas-handle-agreement.test.ts`, which pins the other half: which
 * ports a node draws at all.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/web/__tests__/canvas-graph-round-trip.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { collectCoercedEdgeHandles } from "../../../../../packages/workflow-layout/src/index.js";
import {
  normalizeDefinitionGraph,
  type WorkflowDefinitionGraph,
} from "../../runtime/definition-types.js";
import { selectNextEdge } from "../../runtime/process-runtime.js";
import {
  deriveEdgeId,
  toCanvasEdges,
  toCanvasNodes,
  toStoredGraph,
} from "../graph/index.js";
import {
  addProcessVariable,
  readProcessVariableSet,
  removeProcessVariable,
  setProcessVariableStartValue,
  type ProcessVariableSet,
} from "../editor/index.js";

/**
 * A stored graph, as a document rather than as a typed value.
 *
 * The fixtures carry keys `WorkflowDefinitionGraph` does not declare, which is
 * the point — the column is jsonb and the type is documentation. Casting once
 * here keeps every fixture readable instead of scattering assertions about a
 * shape the storage layer never enforced.
 */
function graph(document: Record<string, unknown>): WorkflowDefinitionGraph {
  return normalizeDefinitionGraph(document);
}

/**
 * Stored -> canvas -> stored, with nothing touched in between.
 *
 * `writePositions` is left off, which is the read-only caller's setting and the
 * one under which an untouched document must come back untouched.
 */
function roundTrip(base: WorkflowDefinitionGraph): WorkflowDefinitionGraph {
  return toStoredGraph({
    base,
    nodes: toCanvasNodes(base),
    edges: toCanvasEdges(base),
  });
}

/**
 * The same trip made by a caller that CAN edit process variables.
 *
 * A designer passes `variables`, so those two top-level keys stop reaching the
 * spread and start being decided. Everything above still has to hold: the whole
 * point of handing the stored lists back by reference is that a screen which
 * merely showed them writes exactly what a screen without one does.
 */
function roundTripWithVariables(base: WorkflowDefinitionGraph): WorkflowDefinitionGraph {
  return toStoredGraph({
    base,
    nodes: toCanvasNodes(base),
    edges: toCanvasEdges(base),
    variables: readProcessVariableSet(base),
  });
}

// ---------------------------------------------------------------------------
// The property: an untouched canvas trip changes nothing
// ---------------------------------------------------------------------------

const FIXTURES: { name: string; document: Record<string, unknown> }[] = [
  {
    name: "an empty graph",
    document: { nodes: [], edges: [] },
  },
  {
    name: "top-level keys this repo never reads",
    document: {
      id: "def-1",
      name: "Onboarding",
      description: null,
      version: "3",
      processVariables: [{ key: "total", valueType: "number" }],
      processVariableInitializers: [{ targetKey: "total", value: 0 }],
      // Nothing reads this. It has to come back anyway: a document written by a
      // newer designer must survive being opened by an older one.
      canvasViewport: { x: -120, y: 40, zoom: 0.75 },
      nodes: [{ id: "t", type: "triggerManual" }],
      edges: [],
    },
  },
  {
    name: "nodes with no label, no position and no config",
    document: {
      // The state every graph is in before anyone has laid it out. All three
      // fields are optional, and a canvas must draw it without acquiring them.
      nodes: [
        { id: "t", type: "triggerManual" },
        { id: "e", type: "end" },
      ],
      edges: [{ source: "t", target: "e" }],
    },
  },
  {
    name: "node-level keys this repo never reads",
    document: {
      nodes: [
        {
          id: "t",
          type: "triggerManual",
          label: "Start",
          position: { x: 10, y: 20 },
          config: { note: "hello" },
          // Per-node designer state. Same argument as the top-level keys.
          collapsed: true,
          size: { width: 240, height: 96 },
        },
      ],
      edges: [],
    },
  },
  {
    name: "edge-level keys this repo never reads, targetHandle included",
    document: {
      nodes: [
        { id: "a", type: "triggerManual" },
        { id: "b", type: "end" },
      ],
      edges: [
        {
          id: "e1",
          source: "a",
          target: "b",
          // Stored, part of edge identity in `definition-patch.ts`, and read by
          // nothing else in this repo. The classic candidate for silent loss.
          targetHandle: "in",
          label: "then",
          condition: "always",
          mappingParameters: [{ key: "x", value: 1 }],
          animated: true,
        },
      ],
    },
  },
  {
    name: "absent and explicit sourceHandles side by side",
    document: {
      // Same meaning to every reader, different documents. Whichever one a
      // canvas standardises on, the other is the one it destroys.
      nodes: [
        { id: "a", type: "triggerManual" },
        { id: "b", type: "decision" },
        { id: "c", type: "end" },
        { id: "d", type: "end" },
      ],
      edges: [
        { source: "a", target: "b" },
        { source: "b", target: "c", sourceHandle: "default" },
        { source: "b", target: "d", sourceHandle: "other" },
      ],
    },
  },
  {
    name: "a decision node with branches, wired and unwired",
    document: {
      nodes: [
        { id: "t", type: "triggerManual" },
        {
          id: "d",
          type: "decision",
          config: {
            branches: [
              { id: "b1", handle: "approved", label: "Approved" },
              { id: "b2", targetEdgeId: "rejected" },
              { id: "b3" },
            ],
            defaultEdgeId: "unknown",
          },
        },
        { id: "e", type: "end" },
      ],
      edges: [
        { source: "t", target: "d" },
        // Three of the four declared handles have no edge. That is an ORPHAN_NODE_HANDLE
        // at publish and an ordinary half-drawn graph at every other moment, so
        // it has to survive a canvas trip rather than being tidied up by one.
        { source: "d", target: "e", sourceHandle: "approved" },
      ],
    },
  },
  {
    name: "two edges the runtime cannot tell apart",
    document: {
      // AMBIGUOUS_EDGE_HANDLE: blocked at publish, allowed at write, and
      // produced by an ordinary canvas gesture (draw the new edge, then delete
      // the old one). The adapter has to carry both, or the author cannot see
      // the pair well enough to delete one.
      nodes: [
        { id: "a", type: "triggerManual" },
        { id: "b", type: "end" },
        { id: "c", type: "end" },
      ],
      edges: [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
      ],
    },
  },
  {
    name: "two edges identical in every field",
    document: {
      // Content-derived ids collide here by construction. Dropping one loses a
      // row the author has to be able to select and delete.
      nodes: [
        { id: "a", type: "triggerManual" },
        { id: "b", type: "end" },
      ],
      edges: [
        { source: "a", target: "b", sourceHandle: "x" },
        { source: "a", target: "b", sourceHandle: "x" },
      ],
    },
  },
  {
    name: "values of the wrong type, which the column permits",
    document: {
      // The jsonb column accepts all of this and `normalizeDefinitionGraph`
      // passes it through. None of it is drawable, and all of it is somebody's
      // data — the only honest thing a translation layer can do is not touch it.
      nodes: [
        { id: "a", type: "triggerManual", label: 42, position: { x: "10", y: 20 }, config: "nope" },
        { id: "b", type: "end", position: { x: 1, y: 2, z: 3 } },
        { id: "  padded  ", type: "end" },
      ],
      edges: [
        { source: "a", target: "b", sourceHandle: 7, targetHandle: null, label: { en: "x" } },
      ],
    },
  },
  {
    name: "entries that are not objects at all",
    document: {
      // `normalizeDefinitionGraph` guarantees the ARRAYS, never their contents.
      // Nothing can draw these; nothing may drop them either.
      nodes: [null, "wat", { id: "a", type: "end" }, 7],
      edges: ["nope", { source: "a", target: "a" }, null],
    },
  },
  {
    name: "duplicated node ids, and an id that differs only by padding",
    document: {
      // Both are DUPLICATE_NODE_ID once ids are trimmed, and only the first can
      // be drawn. The second must still be in the document afterwards.
      nodes: [
        { id: "a", type: "triggerManual", label: "first" },
        { id: "a", type: "end", label: "second" },
        { id: " a ", type: "end", label: "padded" },
      ],
      edges: [],
    },
  },
];

describe("a canvas trip that changes nothing writes nothing", () => {
  for (const fixture of FIXTURES) {
    test(fixture.name, () => {
      const base = graph(fixture.document);
      const result = roundTrip(base);

      expect(result).toEqual(base);
      // Deep equality is not enough. Key ORDER is what a reviewer sees in the
      // diff of a saved version, and a re-ordered document is a version whose
      // changelog is a lie. `JSON.stringify` is the cheapest available proxy
      // for "the same bytes land in the column".
      expect(JSON.stringify(result)).toBe(JSON.stringify(base));
    });

    test(`${fixture.name}, through a caller that edits process variables`, () => {
      const base = graph(fixture.document);
      const result = roundTripWithVariables(base);

      expect(result).toEqual(base);
      expect(JSON.stringify(result)).toBe(JSON.stringify(base));
    });
  }
});

describe("the adapter draws every node and edge it does not carry through blind", () => {
  test("the representable entries are exactly the ones a canvas can key", () => {
    // Guards the property above from passing vacuously: an adapter that
    // represented nothing and carried everything through would satisfy every
    // assertion in this file so far.
    const base = graph(FIXTURES.find((f) => f.name === "entries that are not objects at all")!.document);
    expect(toCanvasNodes(base).map((node) => node.id)).toEqual(["a"]);
    expect(toCanvasEdges(base).map((edge) => edge.source)).toEqual(["a"]);
  });

  test("a graph of ordinary nodes is drawn in full", () => {
    const base = graph(FIXTURES.find((f) => f.name === "a decision node with branches, wired and unwired")!.document);
    expect(toCanvasNodes(base).map((node) => node.id)).toEqual(["t", "d", "e"]);
    expect(toCanvasEdges(base)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// sourceHandle: the document's, never the port that got drawn
// ---------------------------------------------------------------------------

describe("the handle written back is the document's, not the one drawn", () => {
  /**
   * A decision whose declared handles are `approve` and `reject`, and an edge
   * that names neither. Layout still has to place that edge somewhere, so
   * `resolveElkSourceHandleId` attaches it to a port that exists.
   */
  const DRIFTED = graph({
    nodes: [
      {
        id: "d",
        type: "decision",
        config: { branches: [{ id: "b1", handle: "approve" }], defaultEdgeId: "reject" },
      },
      { id: "x", type: "end" },
      { id: "y", type: "end" },
    ],
    edges: [
      { source: "d", target: "x", sourceHandle: "typo" },
      { source: "d", target: "y", sourceHandle: "approve" },
    ],
  });

  test("layout really does move the drifted edge onto an occupied port", () => {
    // The premise of the next assertion, taken from the layout package rather
    // than assumed: without this, the round trip below proves nothing.
    const nodes = toCanvasNodes(DRIFTED);
    const edges = toCanvasEdges(DRIFTED);
    const coerced = collectCoercedEdgeHandles(
      nodes.map((node) => ({
        id: node.id,
        type: node.type,
        label: node.data.label,
        position: node.position,
        outputHandles: node.data.outputHandles,
      })),
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
      })),
    );

    expect(coerced).toHaveLength(1);
    expect(coerced[0]!.requestedHandle).toBe("typo");
    // Onto `approve`, which the OTHER edge already occupies. Writing this back
    // is what would turn one broken edge into two edges on one handle.
    expect(coerced[0]!.resolvedHandle).toBe("approve");
  });

  test("the drifted handle survives the trip verbatim", () => {
    const result = roundTrip(DRIFTED);
    expect(JSON.stringify(result)).toBe(JSON.stringify(DRIFTED));

    // Stated as the run-time outcome rather than as the field, because the
    // field only matters for what it does to a walk. Had the drawn handle been
    // written back, `approve` would carry two edges and this would raise
    // AMBIGUOUS_EDGES_FOR_HANDLE — on the branch the decision node actually
    // selects, so every run taking it would die.
    expect(selectNextEdge(result.edges, "d", "approve")).toEqual({
      source: "d",
      target: "y",
      sourceHandle: "approve",
    });
  });

  test("an absent handle stays absent and an explicit one stays explicit", () => {
    const base = graph({
      nodes: [{ id: "a", type: "triggerManual" }, { id: "b", type: "end" }],
      edges: [{ source: "a", target: "b" }],
    });

    const canvasEdges = toCanvasEdges(base);
    // Null, not "default". The canvas is told the document named nothing, so a
    // designer can render the difference rather than inventing one.
    expect(canvasEdges[0]!.sourceHandle).toBeNull();

    const result = roundTrip(base);
    expect(Object.keys(result.edges[0]!)).toEqual(["source", "target"]);
  });

  test("setting a handle on the canvas does write it", () => {
    // The other half: absence is preserved, not frozen.
    const base = graph({
      nodes: [{ id: "a", type: "triggerManual" }, { id: "b", type: "end" }],
      edges: [{ source: "a", target: "b" }],
    });
    const edges = toCanvasEdges(base).map((edge) => ({ ...edge, sourceHandle: "error" }));
    const result = toStoredGraph({ base, nodes: toCanvasNodes(base), edges });
    expect(result.edges[0]).toEqual({ source: "a", target: "b", sourceHandle: "error" });
  });

  test("clearing a handle removes the key rather than blanking it", () => {
    const base = graph({
      nodes: [{ id: "a", type: "triggerManual" }, { id: "b", type: "end" }],
      edges: [{ source: "a", target: "b", sourceHandle: "error", label: "on failure" }],
    });
    const edges = toCanvasEdges(base).map((edge) => ({ ...edge, sourceHandle: null }));
    const result = toStoredGraph({ base, nodes: toCanvasNodes(base), edges });
    // `sourceHandle: ""` would read as "default" everywhere and is a different
    // document from one that names no handle. Only removal expresses the edit.
    expect(result.edges[0]).toEqual({ source: "a", target: "b", label: "on failure" });
  });
});

// ---------------------------------------------------------------------------
// Synthesized values are for drawing, not for saving
// ---------------------------------------------------------------------------

describe("a value the document never had is not acquired by drawing it", () => {
  const UNLAID_OUT = graph({
    nodes: [
      { id: "t", type: "triggerManual" },
      { id: "e", type: "end" },
    ],
    edges: [{ source: "t", target: "e" }],
  });

  test("the canvas gets a label, a position and a config regardless", () => {
    const [first] = toCanvasNodes(UNLAID_OUT);
    expect(first!.data.label).toBe("t");
    expect(first!.position).toEqual({ x: 0, y: 0 });
    expect(first!.data.config).toEqual({});
    // Flagged, so a designer can offer to auto-arrange rather than guessing
    // from a position it cannot tell apart from a real one.
    expect(first!.data.synthesized).toEqual({ label: true, position: true, config: true });
  });

  test("dragging a node writes nothing unless the caller asks for positions", () => {
    const nodes = toCanvasNodes(UNLAID_OUT).map((node) => ({
      ...node,
      position: { x: 400, y: 120 },
    }));
    const result = toStoredGraph({ base: UNLAID_OUT, nodes, edges: toCanvasEdges(UNLAID_OUT) });
    // Half the point of the flag: a tool that edits config must not be able to
    // decide, as a side effect, that this graph now has a layout.
    expect(JSON.stringify(result)).toBe(JSON.stringify(UNLAID_OUT));
  });

  test("writePositions is what makes the canvas authoritative about layout", () => {
    const nodes = toCanvasNodes(UNLAID_OUT).map((node) => ({
      ...node,
      position: { x: 400, y: 120 },
    }));
    const result = toStoredGraph({
      base: UNLAID_OUT,
      nodes,
      edges: toCanvasEdges(UNLAID_OUT),
      writePositions: true,
    });
    expect(result.nodes.map((node) => node.position)).toEqual([
      { x: 400, y: 120 },
      { x: 400, y: 120 },
    ]);
  });

  test("a node that already had a position keeps tracking the canvas without the flag", () => {
    // Materialising a layout and updating one are different acts. A graph that
    // already has positions is one the canvas is already authoritative over, so
    // refusing the drag there would just break dragging.
    const base = graph({
      nodes: [{ id: "t", type: "triggerManual", position: { x: 1, y: 2 } }],
      edges: [],
    });
    const nodes = toCanvasNodes(base).map((node) => ({ ...node, position: { x: 9, y: 9 } }));
    const result = toStoredGraph({ base, nodes, edges: [] });
    expect(result.nodes[0]).toEqual({
      id: "t",
      type: "triggerManual",
      position: { x: 9, y: 9 },
    });
  });

  test("a synthesized label is not written, and an edited one is", () => {
    const untouched = toStoredGraph({
      base: UNLAID_OUT,
      nodes: toCanvasNodes(UNLAID_OUT),
      edges: toCanvasEdges(UNLAID_OUT),
    });
    expect(untouched.nodes[0]).toEqual({ id: "t", type: "triggerManual" });

    const renamed = toCanvasNodes(UNLAID_OUT).map((node) =>
      node.id === "t" ? { ...node, data: { ...node.data, label: "Kick off" } } : node,
    );
    const result = toStoredGraph({
      base: UNLAID_OUT,
      nodes: renamed,
      edges: toCanvasEdges(UNLAID_OUT),
    });
    expect(result.nodes[0]).toEqual({ id: "t", type: "triggerManual", label: "Kick off" });
  });

  test("an empty config typed into an unconfigured node is not a change", () => {
    const nodes = toCanvasNodes(UNLAID_OUT).map((node) => ({
      ...node,
      // A designer re-creating `data` on every render must not thereby save.
      data: { ...node.data, config: {} },
    }));
    const result = toStoredGraph({ base: UNLAID_OUT, nodes, edges: toCanvasEdges(UNLAID_OUT) });
    expect(JSON.stringify(result)).toBe(JSON.stringify(UNLAID_OUT));
  });

  test("a config with something in it is written", () => {
    const nodes = toCanvasNodes(UNLAID_OUT).map((node) =>
      node.id === "e" ? { ...node, data: { ...node.data, config: { outputs: [] } } } : node,
    );
    const result = toStoredGraph({ base: UNLAID_OUT, nodes, edges: toCanvasEdges(UNLAID_OUT) });
    expect(result.nodes[1]).toEqual({ id: "e", type: "end", config: { outputs: [] } });
  });
});

// ---------------------------------------------------------------------------
// Adding and removing
// ---------------------------------------------------------------------------

describe("the canvas owns which nodes and edges exist", () => {
  const BASE = graph({
    version: "1",
    nodes: [
      { id: "t", type: "triggerManual", position: { x: 0, y: 0 } },
      { id: "e", type: "end", position: { x: 0, y: 100 } },
    ],
    edges: [{ id: "e1", source: "t", target: "e" }],
  });

  test("deleting a node deletes it, and leaves the rest of the document alone", () => {
    const nodes = toCanvasNodes(BASE).filter((node) => node.id !== "e");
    const result = toStoredGraph({ base: BASE, nodes, edges: toCanvasEdges(BASE) });
    expect(result.nodes.map((node) => node.id)).toEqual(["t"]);
    // Not this adapter's job: `deleteNode` in `definition-patch.ts` sweeps the
    // edges, and a designer removes them from its own state. Inventing a
    // cascade here would delete edges a caller meant to keep while it moved
    // their endpoint.
    expect(result.edges).toHaveLength(1);
    expect(result.version).toBe("1");
  });

  test("a new node is written with only what it actually has", () => {
    const nodes = [
      ...toCanvasNodes(BASE),
      {
        id: "n",
        type: "decision",
        position: { x: 40, y: 50 },
        data: {
          label: "n",
          config: {},
          outputHandles: [],
          synthesized: { label: true, position: true, config: true },
        },
      },
    ];
    const result = toStoredGraph({ base: BASE, nodes, edges: toCanvasEdges(BASE) });
    // No position, because the caller did not ask for positions; no label,
    // because "n" is what the canvas would show for a node that has none.
    expect(result.nodes[2]).toEqual({ id: "n", type: "decision" });
  });

  test("a new edge is written without an id", () => {
    const edges = [
      ...toCanvasEdges(BASE),
      {
        id: "anything",
        source: "t",
        target: "e",
        sourceHandle: "second",
        targetHandle: null,
        label: null,
        data: { synthesizedId: true },
      },
    ];
    const result = toStoredGraph({ base: BASE, nodes: toCanvasNodes(BASE), edges });
    // The canvas id is the canvas's. Writing it would put a value in the
    // document that the document never had, and `deriveEdgeId` recomputes it on
    // the next read anyway.
    expect(result.edges[1]).toEqual({ source: "t", target: "e", sourceHandle: "second" });
  });

  test("an edge that already has an id keeps it", () => {
    expect(toCanvasEdges(BASE)[0]!.id).toBe("e1");
    expect(roundTrip(BASE).edges[0]).toEqual({ id: "e1", source: "t", target: "e" });
  });
});

// ---------------------------------------------------------------------------
// Edge ids
// ---------------------------------------------------------------------------

describe("edge ids are content, not a counter", () => {
  test("a stored id is used as-is and never renumbered", () => {
    expect(deriveEdgeId({ id: "e1", source: "a", target: "b" })).toBe("e1");
    // Padding is trimmed, matching how every other reader normalises an id.
    expect(deriveEdgeId({ id: "  e1  ", source: "a", target: "b" })).toBe("e1");
    // Blank is not an id.
    expect(deriveEdgeId({ id: "   ", source: "a", target: "b" })).not.toBe("");
  });

  test("the same edge derives the same id wherever it sits in the document", () => {
    // The property a counter does not have. An id that moves when an unrelated
    // edge is inserted above it invalidates every patch a client is holding.
    const early = graph({
      nodes: [],
      edges: [
        { source: "a", target: "b" },
        { source: "c", target: "d" },
      ],
    });
    const late = graph({
      nodes: [],
      edges: [
        { source: "x", target: "y" },
        { source: "c", target: "d" },
        { source: "a", target: "b" },
      ],
    });

    const idOf = (g: WorkflowDefinitionGraph, source: string) =>
      toCanvasEdges(g).find((edge) => edge.source === source)!.id;

    expect(idOf(late, "a")).toBe(idOf(early, "a"));
    expect(idOf(late, "c")).toBe(idOf(early, "c"));
  });

  test("edges that differ in any identifying field get different ids", () => {
    // `targetHandle` is on the list because `edgeIdentity` in
    // `definition-patch.ts` treats it as identifying, and because a canvas can
    // legitimately carry two edges between the same pair into different target
    // ports. Leaving it out collapses them onto one id.
    const ids = [
      { source: "a", target: "b" },
      { source: "a", target: "b", sourceHandle: "yes" },
      { source: "a", target: "b", sourceHandle: "no" },
      { source: "a", target: "c" },
      { source: "b", target: "b" },
      { source: "a", target: "b", targetHandle: "in" },
    ].map(deriveEdgeId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a separator inside a node id does not collide with the separator itself", () => {
    // Node ids are arbitrary strings. An unescaped join makes `a` + handle `b`
    // indistinguishable from a node literally called `a:b`.
    expect(deriveEdgeId({ source: "a", sourceHandle: "b", target: "c" })).not.toBe(
      deriveEdgeId({ source: "a:b", target: "c" }),
    );
  });

  test("an absent handle derives a different id from an explicit default", () => {
    expect(deriveEdgeId({ source: "a", target: "b" })).not.toBe(
      deriveEdgeId({ source: "a", target: "b", sourceHandle: "default" }),
    );
  });

  test("a blank handle keys the same as an absent one, and both edges still draw", () => {
    // Where a canvas key deliberately parts company with `edgeIdentity` in
    // `definition-patch.ts`, which separates the two because it decides which
    // stored edge a WRITE lands on. A canvas key describes what is drawn, and
    // these draw identically — so the collapse is answered by the same suffix
    // that answers two genuinely identical edges, not by a finer key.
    expect(deriveEdgeId({ source: "a", target: "b" })).toBe(
      deriveEdgeId({ source: "a", target: "b", sourceHandle: "" }),
    );

    const base = graph({
      nodes: [],
      edges: [
        { source: "a", target: "b" },
        { source: "a", target: "b", sourceHandle: "" },
      ],
    });
    expect(new Set(toCanvasEdges(base).map((edge) => edge.id)).size).toBe(2);
  });

  test("edges that really are identical still get unique canvas ids", () => {
    const base = graph({
      nodes: [],
      edges: [
        { source: "a", target: "b" },
        { source: "a", target: "b" },
        { source: "a", target: "b" },
      ],
    });
    const ids = toCanvasEdges(base).map((edge) => edge.id);
    expect(new Set(ids).size).toBe(3);
    // Deterministic, so a reload does not reshuffle them.
    expect(toCanvasEdges(base).map((edge) => edge.id)).toEqual(ids);
  });

  test("a stored id that collides with another edge's is still disambiguated", () => {
    // Nothing validates edge id uniqueness — there is no DUPLICATE_EDGE_ID rule
    // — so a document can carry two edges under one id and a canvas still has
    // to key them apart.
    const base = graph({
      nodes: [],
      edges: [
        { id: "same", source: "a", target: "b" },
        { id: "same", source: "c", target: "d" },
      ],
    });
    const ids = toCanvasEdges(base).map((edge) => edge.id);
    expect(ids[0]).toBe("same");
    expect(ids[1]).not.toBe("same");
    expect(roundTrip(base)).toEqual(base);
  });
});

// ---------------------------------------------------------------------------
// processVariables: the first two top-level keys a designer writes
// ---------------------------------------------------------------------------

describe("the designer writes the two variable keys and nothing else", () => {
  const base = graph({
    id: "def-1",
    name: "Onboarding",
    processVariables: [
      { key: "total", valueType: "number", semanticType: "amount", authoring: { profile: "x" } },
    ],
    processVariableInitializers: [{ targetKey: "total", value: "{{input.amount}}" }],
    canvasViewport: { x: -120, y: 40, zoom: 0.75 },
    nodes: [{ id: "t", type: "triggerManual" }],
    edges: [],
  });

  function save(variables: ProcessVariableSet): WorkflowDefinitionGraph {
    return toStoredGraph({
      base,
      nodes: toCanvasNodes(base),
      edges: toCanvasEdges(base),
      variables,
    });
  }

  test("a caller that omits `variables` cannot touch either key", () => {
    // The asymmetry `writePositions` has, for the same reason: a tool that
    // edits wiring has nothing to say about a definition's variables, so it
    // must not be able to erase them by not mentioning them.
    const result = toStoredGraph({ base, nodes: [], edges: [] });
    expect(result.processVariables).toBe(base.processVariables);
    expect(result.processVariableInitializers).toBe(base.processVariableInitializers);
  });

  test("an added variable is written, and the rest of the document is not", () => {
    const added = addProcessVariable(readProcessVariableSet(base), {
      key: "channel",
      valueType: "string",
      label: "Channel",
    });
    expect(added.refused).toBeNull();

    const result = save(added.set);
    // The stored entry comes back whole. `semanticType` and `authoring` are
    // read by `runtime/field-definitions.ts` and by an authoring pass, and by
    // nothing in this editor — an add that rebuilt the list would drop them.
    expect(result.processVariables).toEqual([
      { key: "total", valueType: "number", semanticType: "amount", authoring: { profile: "x" } },
      { key: "channel", valueType: "string", label: { en: "Channel" } },
    ]);
    // Untouched, and still the same array: only the key that changed is
    // assigned, so the initializers reach the document through the spread.
    expect(result.processVariableInitializers).toBe(base.processVariableInitializers);
    expect((result as Record<string, unknown>).canvasViewport).toBe(
      (base as Record<string, unknown>).canvasViewport,
    );
  });

  test("undeclaring a variable takes its initializer with it", () => {
    // The engine's declared set is closed, so an initializer targeting an
    // undeclared key is a line that can never run — and one that would come
    // back to life if the key were ever declared again.
    const removed = removeProcessVariable(readProcessVariableSet(base), "total");
    expect(save(removed).processVariables).toEqual([]);
    expect(save(removed).processVariableInitializers).toEqual([]);
  });

  test("a start value cleared to blank removes the initializer rather than storing an empty one", () => {
    const cleared = setProcessVariableStartValue(readProcessVariableSet(base), {
      key: "total",
      value: "   ",
    });
    expect(save(cleared).processVariableInitializers).toEqual([]);
    // No initializer leaves the declaration's own `value ?? defaultValue`
    // standing; an empty one would overwrite it with "".
    expect(save(cleared).processVariables).toBe(base.processVariables);
  });

  test("the written list is the caller's own, so the save after it writes nothing", () => {
    // A save adopts the document it produced as its new base. Copying the list
    // on the way out would make the very next save see a different array and
    // rewrite the variables, forever, for every subsequent edit.
    const added = addProcessVariable(readProcessVariableSet(base), { key: "channel" });
    const written = save(added.set);
    expect(written.processVariables as unknown).toBe(added.set.fields);
    expect(
      toStoredGraph({
        base: written,
        nodes: toCanvasNodes(written),
        edges: toCanvasEdges(written),
        variables: readProcessVariableSet(written),
      }),
    ).toEqual(written);
  });

  test("a document that never had variables does not acquire an empty declaration", () => {
    const bare = graph({ nodes: [], edges: [] });
    const result = toStoredGraph({
      base: bare,
      nodes: [],
      edges: [],
      variables: readProcessVariableSet(bare),
    });
    expect("processVariables" in result).toBe(false);
    expect("processVariableInitializers" in result).toBe(false);
  });

  test("a malformed stored value survives a trip that does not edit it", () => {
    // The column is jsonb and enforces only that `nodes` and `edges` are
    // arrays, so this is a document somebody has rather than a hypothetical.
    const broken = graph({ nodes: [], edges: [], processVariables: "nonsense" });
    const result = toStoredGraph({
      base: broken,
      nodes: [],
      edges: [],
      variables: readProcessVariableSet(broken),
    });
    expect(result.processVariables as unknown).toBe("nonsense");
  });
});
