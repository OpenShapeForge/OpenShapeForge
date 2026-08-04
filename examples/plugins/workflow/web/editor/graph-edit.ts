// SPDX-License-Identifier: BUSL-1.1
/**
 * Editing a canvas graph: the operations a designer performs, as pure
 * functions over the shape `web/graph/` produces.
 *
 * `canvas-graph.ts` carries a document to a canvas and back. This is what
 * happens in between. It is kept apart from the components for the same reason
 * the adapter is: `apps/web` has no test runner, so anything that can be wrong
 * lives where `bun test examples` reaches it.
 *
 * Every function returns a new graph and mutates nothing, so a caller can hold
 * the previous one for undo without defensive copying — and, more immediately,
 * so `toStoredGraph` can still tell an edited value from the one it handed
 * over. That comparison is by reference for `config`; editing a config object
 * in place would make an edit invisible to the save path.
 *
 * The complement holds too, and `graph-history.ts` depends on it: **an
 * operation that changes nothing returns the graph it was GIVEN.** Reference
 * inequality is therefore exactly "something happened", which is what decides
 * whether an edit costs an undo entry and whether a draft is dirty. A delete
 * naming an id the graph does not hold, or a move to the position a node is
 * already at, must not look like an edit merely because a new array was built.
 *
 * ## What this refuses, and what it merely reports
 *
 * The line is the server's, not this module's invention: **a canvas refuses
 * what `blocksAt: "write"` refuses, and reports what `blocksAt: "publish"`
 * refuses.** Anything stricter makes the designer disagree with the API it
 * saves through, and an author cannot predict a rule only one of them holds.
 *
 * A second edge on one source handle is the case that makes this concrete. It
 * is an error — AMBIGUOUS_EDGE_HANDLE at validation, AMBIGUOUS_EDGES_FOR_HANDLE
 * at run time — but `definition-validation.ts` puts it at `publish` on purpose,
 * and its own note says why: the state is produced by an ordinary gesture,
 * drawing the replacement edge before deleting the old one, and refusing the
 * write would make that order illegal while the reverse order was fine. So
 * {@link connectCanvasNodes} DRAWS the second edge and returns
 * {@link ConnectResult.warned}; the validation surface carries the
 * authoritative version, and publishing is where it is refused.
 *
 * {@link insertCanvasNodeIntoEdge} is a different case and does re-point the
 * edge it splits rather than adding one beside it — not because two edges are
 * forbidden, but because splitting an edge means that edge now ends somewhere
 * else. Producing a fan-out from a gesture that says "put this node in the
 * middle" would be wrong even if fan-out were legal.
 *
 * ## Ports come from the document
 *
 * Changing a `decision` node's config changes which handles it offers, so
 * {@link setCanvasNodeConfig} re-derives them through the same
 * `resolveCanvasNodeHandles` the read path uses. It never infers a port from
 * an edge — see that module's header for what a back-filled port costs.
 *
 * ## When a new edge names its source handle, and when it does not
 *
 * `selectNextEdge` matches `(edge.sourceHandle ?? "default")` against the
 * handle a node emitted, so an absent `sourceHandle` means exactly one thing:
 * the handle literally called `"default"`. It is not a wildcard. An edge
 * leaving any other port MUST name it or the run dies on NO_EDGE_FOR_HANDLE.
 *
 * That leaves the one degenerate case — a node whose only port is `"default"`
 * — where absent and `"default"` are two spellings of one document. New edges
 * there are written absent, which is the spelling the stored graphs in this
 * repo use and the one `toStoredGraph` treats as "nothing to say". Anywhere
 * else the handle is written, including a `decision` whose sole port happens
 * to be `"default"`: a canvas redrawing an edge with no handle attaches it to
 * the node's FIRST port, so omitting it on a multi-port node would move the
 * user's edge on the next reload.
 */
import { resolveCanvasNodeHandles } from "../graph/canvas-handles";
import type { CanvasEdge, CanvasNode, CanvasPosition } from "../graph/canvas-graph";

export type EditableCanvasGraph = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
};

/** A connection a user drew, in the terms React Flow reports one. */
export type CanvasConnection = {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

/**
 * Why a connection was refused, so nothing was drawn.
 *
 * Codes rather than sentences: the reason is decided here, where it can be
 * tested, and worded by whatever surface reports it.
 *
 * Every member is a graph the server refuses at WRITE, or a gesture with no
 * meaning at all. Nothing the server defers to publish appears here — see the
 * file header, and {@link ConnectionWarning} for where those go instead.
 */
export type ConnectionRefusal =
  /**
   * An endpoint names a node the graph does not hold. UNKNOWN_EDGE_SOURCE /
   * UNKNOWN_EDGE_TARGET, both `blocksAt: "write"`.
   */
  | "UNKNOWN_ENDPOINT"
  /**
   * A node cannot feed itself. This one is the canvas's own rule: the server
   * has no code for it, because a self-edge is a walk that never leaves the
   * node rather than a document that cannot be read. Refused because there is
   * no gesture it is a step towards.
   */
  | "SELF_CONNECTION"
  /**
   * A trigger starts a workflow, so nothing may point at one, and a terminal
   * node ends one, so nothing may leave it. Unreachable by dragging — the card
   * draws no inlet for a trigger and no outlet for a terminal node — and here
   * for a caller that does not go through a card.
   */
  | "TARGET_IS_ENTRY"
  | "SOURCE_IS_TERMINAL"
  /** This exact edge is already drawn. Nothing to add. */
  | "DUPLICATE_EDGE";

/**
 * Drawn, and the graph will not publish while it stands.
 *
 * The one member is the case the file header explains: two edges leaving one
 * source handle. It is drawn because getting there is a legitimate step, and
 * flagged because stopping there is not.
 */
export type ConnectionWarning = "HANDLE_OCCUPIED";

export type ConnectResult = {
  graph: EditableCanvasGraph;
  /** The refusal, when nothing was connected. Null when the edge was added. */
  refused: ConnectionRefusal | null;
  /** Set when the edge WAS added and the graph is now unpublishable. */
  warned: ConnectionWarning | null;
};

export type CreateCanvasNodeInput = {
  nodeType: string;
  position: CanvasPosition;
  /** The graph the node joins; read for id uniqueness only. */
  graph: EditableCanvasGraph;
  /** The catalog's `configFields` for this type, when the caller has them. */
  configFields?: unknown;
  /** What to call it. Falls back to the generated id, as the adapter does. */
  label?: string | null;
};

export type NodePredicates = {
  /** Node types nothing may point at. `isEntryNodeType` from the runtime. */
  isEntry: (nodeType: string) => boolean;
  /** Node types nothing may leave. `isTerminalNodeType` from the runtime. */
  isTerminal: (nodeType: string) => boolean;
};

// ---------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------

/**
 * A new canvas node, with the config its catalog fields default to.
 *
 * The id is derived from the type and a counter rather than from a random
 * source, because it is what every server-side finding names — `Node "d" can
 * emit output handle "approve"` — and a reader has to be able to find it on
 * the canvas. Uniqueness is against the graph as it stands, so an id freed by
 * a deletion is reused; nothing addresses a node that is not in the document.
 */
export function createCanvasNode(input: CreateCanvasNodeInput): CanvasNode {
  const id = allocateNodeId(input.nodeType, input.graph.nodes);
  const config = defaultConfigFromFields(input.configFields);
  return {
    id,
    type: input.nodeType,
    position: { x: input.position.x, y: input.position.y },
    data: {
      label: input.label?.trim() || id,
      config,
      outputHandles: resolveCanvasNodeHandles({
        nodeType: input.nodeType,
        config,
        configFields: input.configFields,
        outgoingEdges: [],
      }),
      // A node the user just created carries none of the three synthesized
      // values: `toStoredGraph` compares against the base document and this
      // node has none, so the flags are informational here and false is the
      // truthful reading — nothing was filled in on its behalf.
      synthesized: { label: false, position: false, config: false },
    },
  };
}

export function addCanvasNode(
  graph: EditableCanvasGraph,
  node: CanvasNode,
): EditableCanvasGraph {
  return { nodes: [...graph.nodes, node], edges: graph.edges };
}

/**
 * Drop a node onto an existing edge, so it runs between that edge's endpoints.
 *
 * The edge being split is RE-POINTED, keeping its id, and one new edge carries
 * on to the original target. Adding a second edge from the original source
 * instead would put two edges on one source handle, which is
 * AMBIGUOUS_EDGE_HANDLE at validation and AMBIGUOUS_EDGES_FOR_HANDLE at run
 * time — and keeping the id matters beyond that, because the id is what a
 * stored document and any patch addressing it already use.
 *
 * The new outgoing edge names no source handle unless the node offers exactly
 * one. With several ports there is no honest default: picking the first would
 * wire an arm the user did not choose, and `sourceHandle` absent already means
 * "the document names none", which is what an unwired split should look like.
 *
 * A no-op when the edge id is not on the graph, so a stale drop target cannot
 * fabricate an edge between nodes the user never connected.
 */
export function insertCanvasNodeIntoEdge(
  graph: EditableCanvasGraph,
  input: { node: CanvasNode; edgeId: string },
): EditableCanvasGraph {
  const split = graph.edges.find((edge) => edge.id === input.edgeId);
  if (!split) return graph;

  // No handle was chosen: the gesture says "put this node in the middle", not
  // "leave by this port". On a single-`default` node that is the same document
  // as naming it. On a node with several ports it is an unwired split, which
  // is what it is — validation reports the unwired ports, and naming one the
  // user did not pick would silence that by guessing.
  const outgoingHandle = null;

  return {
    nodes: [...graph.nodes, input.node],
    edges: [
      ...graph.edges.map((edge) =>
        edge.id === input.edgeId
          ? // Everything else on the edge survives: its id, its source, its
            // source handle, its label, and the target handle it named.
            { ...edge, target: input.node.id, targetHandle: null }
          : edge,
      ),
      {
        id: `${input.node.id}->${split.target}`,
        source: input.node.id,
        target: split.target,
        sourceHandle: outgoingHandle,
        targetHandle: split.targetHandle,
        label: null,
        // Derived, so it is never written into the document as an id. The save
        // path re-derives from content; this value only has to be unique on
        // the canvas until then.
        data: { synthesizedId: true },
      },
    ],
  };
}

/**
 * Connect two nodes: draw it, or refuse and say why.
 *
 * Refusing here is not a substitute for validation. This sees one connection;
 * `validateWorkflowDefinition` sees the graph, and it is the authority on what
 * publishes. What this adds is immediacy for the handful of cases where there
 * is nothing to be immediate about later — a connection that produces no
 * document at all.
 */
export function connectCanvasNodes(
  graph: EditableCanvasGraph,
  connection: CanvasConnection,
  predicates: NodePredicates,
): ConnectResult {
  const refuse = (refused: ConnectionRefusal): ConnectResult => ({
    graph,
    refused,
    warned: null,
  });

  const source = graph.nodes.find((node) => node.id === connection.source);
  const target = graph.nodes.find((node) => node.id === connection.target);
  if (!source || !target) return refuse("UNKNOWN_ENDPOINT");
  if (source.id === target.id) return refuse("SELF_CONNECTION");
  if (predicates.isTerminal(source.type)) return refuse("SOURCE_IS_TERMINAL");
  if (predicates.isEntry(target.type)) return refuse("TARGET_IS_ENTRY");

  const targetHandle = handleOrNull(connection.targetHandle);
  const dragged = effectiveSourceHandle(handleOrNull(connection.sourceHandle));
  const sourceHandle = storedSourceHandle(dragged, source);

  let warned: ConnectionWarning | null = null;
  for (const edge of graph.edges) {
    // Compared through the same `?? "default"` the runtime applies, so a
    // stored edge spelling the handle explicitly and a new one leaving it
    // absent are recognised as the one handle they are.
    if (edge.source !== source.id) continue;
    if (effectiveSourceHandle(edge.sourceHandle) !== dragged) continue;
    // The same edge twice adds nothing and is worth nobody's attention. A
    // DIFFERENT edge on the same handle is the ambiguity: drawn, and flagged.
    if (edge.target === target.id && edge.targetHandle === targetHandle) {
      return refuse("DUPLICATE_EDGE");
    }
    warned = "HANDLE_OCCUPIED";
  }

  return {
    graph: {
      nodes: graph.nodes,
      edges: [
        ...graph.edges,
        {
          id: allocateEdgeId(source.id, sourceHandle, target.id, graph.edges),
          source: source.id,
          target: target.id,
          sourceHandle,
          targetHandle,
          label: null,
          data: { synthesizedId: true },
        },
      ],
    },
    refused: null,
    warned,
  };
}

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------

/**
 * Replace a node's config, and re-derive the ports it offers.
 *
 * The second half is the reason this is not a one-line spread. A `decision`
 * node's handles ARE its config — `branches[].handle ?? targetEdgeId ?? id`
 * plus `defaultEdgeId` — so editing branches without re-deriving leaves the
 * canvas drawing ports the document no longer declares, and lets a user wire
 * one. Edges pointing at a port that has just disappeared are deliberately
 * left alone: the server reports them (`ORPHAN_NODE_HANDLE`) and their owner
 * is better placed to decide whether the branch or the edge was the mistake.
 *
 * The config object is REPLACED, never merged into, so the reference changes
 * and the save path can see the edit. See the header.
 */
export function setCanvasNodeConfig(
  graph: EditableCanvasGraph,
  input: {
    nodeId: string;
    config: Record<string, unknown>;
    configFields?: unknown;
  },
): EditableCanvasGraph {
  const current = graph.nodes.find((node) => node.id === input.nodeId);
  // Nothing to change, or the caller handed back the object it was given. A
  // rebuilt but equal config is still an edit — see the header — but the same
  // object is not, and treating it as one would cost an undo entry for a form
  // that re-rendered.
  if (!current || current.data.config === input.config) return graph;

  return {
    nodes: graph.nodes.map((node) =>
      node.id === input.nodeId
        ? {
            ...node,
            data: {
              ...node.data,
              config: input.config,
              outputHandles: resolveCanvasNodeHandles({
                nodeType: node.type,
                config: input.config,
                configFields: input.configFields,
                // Deliberately empty: for every type but `decision` this is
                // what `defaultOutputHandles` reads, and feeding it the current
                // edges is how a canvas invents a port from a drifted edge.
                outgoingEdges: [],
              }),
            },
          }
        : node,
    ),
    edges: graph.edges,
  };
}

export function setCanvasNodeLabel(
  graph: EditableCanvasGraph,
  input: { nodeId: string; label: string },
): EditableCanvasGraph {
  const current = graph.nodes.find((node) => node.id === input.nodeId);
  if (!current || current.data.label === input.label) return graph;

  return {
    nodes: graph.nodes.map((node) =>
      node.id === input.nodeId
        ? { ...node, data: { ...node.data, label: input.label } }
        : node,
    ),
    edges: graph.edges,
  };
}

export function moveCanvasNode(
  graph: EditableCanvasGraph,
  input: { nodeId: string; position: CanvasPosition },
): EditableCanvasGraph {
  const current = graph.nodes.find((node) => node.id === input.nodeId);
  // A drag that ends where it started, and a click a canvas reports as a
  // position change, are not statements about layout. Recording them would
  // fill the undo stack with entries that restore nothing.
  if (
    !current ||
    (current.position.x === input.position.x && current.position.y === input.position.y)
  ) {
    return graph;
  }

  return {
    nodes: graph.nodes.map((node) =>
      node.id === input.nodeId
        ? { ...node, position: { x: input.position.x, y: input.position.y } }
        : node,
    ),
    edges: graph.edges,
  };
}

// ---------------------------------------------------------------------------
// Removing
// ---------------------------------------------------------------------------

/**
 * Delete nodes, and the edges that would be left pointing at nothing.
 *
 * The cascade is right here and wrong in `toStoredGraph`, which is why only
 * one of them does it. There, a missing node means "the caller no longer draws
 * this" and cascading would delete edges a caller was in the middle of
 * re-pointing. Here the caller IS the intent, and an edge whose endpoint is
 * gone is not a graph the server would accept — it is UNKNOWN_EDGE_TARGET.
 */
export function deleteCanvasNodes(
  graph: EditableCanvasGraph,
  nodeIds: ReadonlyArray<string>,
): EditableCanvasGraph {
  const removed = new Set(nodeIds);
  if (removed.size === 0) return graph;
  const nodes = graph.nodes.filter((node) => !removed.has(node.id));
  // Named nodes the graph does not hold. Nothing went, so no edge can have gone
  // with it either.
  if (nodes.length === graph.nodes.length) return graph;
  return {
    nodes,
    edges: graph.edges.filter(
      (edge) => !removed.has(edge.source) && !removed.has(edge.target),
    ),
  };
}

export function deleteCanvasEdges(
  graph: EditableCanvasGraph,
  edgeIds: ReadonlyArray<string>,
): EditableCanvasGraph {
  const removed = new Set(edgeIds);
  if (removed.size === 0) return graph;
  const edges = graph.edges.filter((edge) => !removed.has(edge.id));
  // Deleting a node cascades to its edges here AND is reported by a canvas as
  // an edge removal in the same gesture, so this arrives a second time with
  // nothing left to remove. It must not read as an edit.
  if (edges.length === graph.edges.length) return graph;
  return { nodes: graph.nodes, edges };
}

// ---------------------------------------------------------------------------
// Ids and defaults
// ---------------------------------------------------------------------------

/**
 * `triggermanual_1`, `decision_2` — the type, reduced to what an id may hold,
 * and the lowest free counter.
 *
 * Lowest free rather than highest-plus-one so a graph does not accumulate
 * gaps over a session of adding and undoing, and so the same sequence of
 * actions yields the same document twice.
 */
export function allocateNodeId(
  nodeType: string,
  nodes: ReadonlyArray<{ id: string }>,
): string {
  const prefix = nodeType.replace(/[^a-z0-9]+/gi, "_").toLowerCase() || "node";
  const taken = new Set(nodes.map((node) => node.id));
  let counter = 1;
  while (taken.has(`${prefix}_${counter}`)) counter += 1;
  return `${prefix}_${counter}`;
}

/**
 * A canvas-only id for a new edge, shaped like the one `deriveEdgeId` produces
 * for a stored edge with no id of its own.
 *
 * Never written to the document — `toStoredGraph` re-derives from content for
 * exactly the edges that carry `synthesizedId` — so this only has to be unique
 * among what the canvas is holding right now.
 */
function allocateEdgeId(
  source: string,
  sourceHandle: string | null,
  target: string,
  edges: ReadonlyArray<{ id: string }>,
): string {
  const base = `${source}:${sourceHandle ?? ""}->${target}`;
  const taken = new Set(edges.map((edge) => edge.id));
  if (!taken.has(base)) return base;
  let counter = 2;
  while (taken.has(`${base}#${counter}`)) counter += 1;
  return `${base}#${counter}`;
}

/**
 * The config a new node starts with: every field that authored a
 * `defaultValue`, and nothing else.
 *
 * A field with no default is left absent rather than given `null` or `""`. The
 * difference is visible to validation — required-field checks read "absent",
 * and an empty string is a value someone typed — and to `toStoredGraph`, which
 * would otherwise write a config full of blanks for a node nobody configured.
 *
 * Defaults are read from the catalog's own field list rather than from a
 * per-type table here, so a node type that changes its defaults in authoring
 * changes them for the designer in the same edit.
 */
export function defaultConfigFromFields(configFields: unknown): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (!Array.isArray(configFields)) return config;
  for (const entry of configFields) {
    if (!isRecord(entry)) continue;
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    if (!key || !("defaultValue" in entry)) continue;
    config[key] = cloneDefault(entry.defaultValue);
  }
  return config;
}

/**
 * Defaults arrive from a JSON column shared by every node of a type, so a
 * mutable one has to be copied before it reaches a node's config — two
 * `decision` nodes appending to one `branches` array would otherwise edit each
 * other. Scalars are returned as they are, which covers most of the catalog.
 */
function cloneDefault(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneDefault);
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) copy[key] = cloneDefault(entry);
    return copy;
  }
  return value;
}

/** An empty handle is not a handle; absent is what "the document names none" is. */
function handleOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The handle an absent `sourceHandle` stands for, straight out of
 * `selectNextEdge`'s own `edge.sourceHandle ?? "default"`.
 *
 * It is not a wildcard. An edge with no handle matches the port literally
 * called `"default"` and no other, which is why comparing two edges by their
 * raw fields would read one handle as two.
 */
const IMPLICIT_SOURCE_HANDLE = "default";

function effectiveSourceHandle(handle: string | null | undefined): string {
  return handleOrNull(handle) ?? IMPLICIT_SOURCE_HANDLE;
}

/**
 * What to STORE for an edge leaving `handle`.
 *
 * Absent only where absent cannot be misread: the source node offers exactly
 * one port and it is `"default"`. Anywhere else the handle is written out —
 * on a multi-port node an edge with no handle is redrawn against the FIRST
 * port, so omitting it would move the user's edge on the next reload even
 * though the runtime would still walk it correctly.
 */
function storedSourceHandle(handle: string, source: CanvasNode): string | null {
  const handles = source.data.outputHandles;
  const onlyDefault =
    handles.length === 1 && handles[0]?.id === IMPLICIT_SOURCE_HANDLE;
  return onlyDefault && handle === IMPLICIT_SOURCE_HANDLE ? null : handle;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
