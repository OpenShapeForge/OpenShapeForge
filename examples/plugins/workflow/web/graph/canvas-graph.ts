// SPDX-License-Identifier: BUSL-1.1
/**
 * A stored workflow graph, both ways: the document a designer draws, and the
 * document a designer saves.
 *
 * Pure by construction — no React, no `@xyflow/react`, nothing from `apps/web`
 * — because `apps/web` has no test runner at all and logic that lives there
 * cannot be tested. Everything here runs under `bun test`, and
 * `web/__tests__/canvas-graph-round-trip.test.ts` is where the guarantee below
 * is actually held.
 *
 * ## The guarantee
 *
 * **A canvas trip that changes nothing writes nothing.** Not "produces an
 * equivalent document" — the same bytes, keys and order included. Everything
 * else in this file follows from that, because the alternative is a save that
 * quietly edits parts of a document the user never looked at.
 *
 * It is not a nicety. The definition column is jsonb and
 * `normalizeDefinitionGraph` SPREADS what it reads, forcing only `nodes` and
 * `edges` to be arrays; `saveWorkflowDefinitionVersion` does the same on the
 * way in. So a key nothing in this repo understands survives a save today, and
 * a designer is the one component positioned to destroy that — it is the only
 * writer that rebuilds the whole document. `edge.targetHandle` is the standing
 * example: stored, part of edge identity in `definition-patch.ts`, read by
 * nothing.
 *
 * How it is obtained: **nothing is rebuilt.** `toStoredGraph` spreads the
 * ORIGINAL node and edge objects and assigns a field only when the canvas value
 * differs from the value `toCanvasNodes`/`toCanvasEdges` handed the canvas for
 * that same field. An untouched field is therefore never assigned at all, and
 * its stored value — including one of the wrong type, which the column permits
 * — is carried through by the spread rather than by being understood.
 *
 * ## Three specific ways this loses data, and what stops each
 *
 * 1. **Synthesizing on the way out and writing it back on the way in.**
 *    `label`, `position` and `config` are all optional in the stored shape, and
 *    all three must exist for a canvas to draw anything. They are synthesized
 *    for display and compared, not stored, on the way back. Positions get one
 *    extra gate: see {@link ToStoredGraphInput.writePositions}.
 *
 * 2. **Standardising `sourceHandle`.** Absent and `"default"` mean the same
 *    thing to every reader and are not the same document. More importantly the
 *    canvas does not draw the handle a document names — `resolveElkSourceHandleId`
 *    coerces an edge onto a port that exists so a drifted graph stays drawable
 *    — so writing back the DRAWN handle turns a broken edge into a second edge
 *    on an occupied port: AMBIGUOUS_EDGE_HANDLE at validation,
 *    AMBIGUOUS_EDGES_FOR_HANDLE at run time. Handles here are `string | null`,
 *    where null is "the document named none", and only an explicit change is
 *    ever written.
 *
 * 3. **Renumbering edges.** Edge ids are optional in the stored shape and the
 *    runtime never reads one, but `definition-patch.ts` addresses edges by id
 *    and a canvas needs unique keys regardless. {@link deriveEdgeId} derives
 *    them from content, so the id an edge shows does not move when an unrelated
 *    edge is inserted above it. A stored id is used verbatim and never
 *    renumbered, and a derived one is never written into the document.
 *
 * ## The two top-level keys this DOES write
 *
 * `processVariables` and `processVariableInitializers` used to reach the spread
 * like every other key nothing here understands. They no longer do, because the
 * designer edits them — see {@link ToStoredGraphInput.variables} — and the same
 * rule applies to them as to a node's `config`: the caller is handed the stored
 * array BY REFERENCE, and a key is assigned only when what comes back is a
 * different array. Handing the list straight back therefore writes nothing, and
 * every other top-level key is still carried by the spread and by nothing else.
 *
 * ## What is deliberately NOT translated
 *
 * - **A node's `type` is identity, not content.** It is never written back for
 *   a node that already exists. A designer that maps workflow types onto
 *   renderer keys — the usual `nodeTypes` arrangement — would otherwise rewrite
 *   every node's type on save. Changing a node's type means deleting it and
 *   adding another.
 * - **Deleting a node does not sweep its edges.** `deleteNode` in
 *   `definition-patch.ts` does that because it is given one intent; here the
 *   canvas already holds both lists, and cascading would delete edges a caller
 *   was in the middle of re-pointing.
 * - **Entries the canvas cannot key** — a node with no usable id, an edge with
 *   no usable source or target, anything that is not an object — are carried
 *   through untouched and in place. They are somebody's data and no designer
 *   can render them, so the only honest thing to do is not touch them.
 *
 * The types below are not `@xyflow/react`'s and are not trying to be. React
 * Flow's `sourceHandle?: string | null` cannot distinguish "the document named
 * none" from "not set", and that distinction is the one that has to survive. A
 * designer maps between the two shapes; the mapping is where the compromise
 * belongs.
 */
import type {
  WorkflowDefinitionEdge,
  WorkflowDefinitionGraph,
  WorkflowDefinitionNode,
} from "../../runtime/definition-types";
import {
  resolveCanvasNodeHandles,
  type CanvasOutputHandle,
} from "./canvas-handles";

export type CanvasPosition = { x: number; y: number };

/** Which of the drawable values the DOCUMENT did not carry. Informational. */
export type CanvasSynthesizedFields = {
  label: boolean;
  position: boolean;
  config: boolean;
};

export type CanvasNodeData = {
  /** What to show. Synthesized from the id, then the type, when absent. */
  label: string;
  /**
   * Always an object, so an inspector has somewhere to write; `{}` when the
   * document holds none.
   *
   * When the document holds one this is that object BY REFERENCE, which is how
   * `toStoredGraph` tells "the caller replaced this" from "the caller handed it
   * back". Edit it the way React state is edited — build a new object — and
   * never in place. Rebuilding an identical one is harmless but counts as an
   * edit, so it is written back.
   */
  config: Record<string, unknown>;
  /** The ports this node offers, in the order they should be drawn. */
  outputHandles: CanvasOutputHandle[];
  /**
   * Read by nothing on the way back — `toStoredGraph` re-derives from the base
   * document rather than trusting a flag a caller could have edited. Here so a
   * designer can tell a placeholder from a value: "this graph has no layout,
   * offer to arrange it" is not answerable from a position alone.
   */
  synthesized: CanvasSynthesizedFields;
};

export type CanvasNode = {
  id: string;
  /**
   * The STORED node type, not a renderer key. Remap it at render time if your
   * `nodeTypes` map needs something else, and keep this field intact: it is
   * what a new node is written with.
   */
  type: string;
  position: CanvasPosition;
  data: CanvasNodeData;
};

export type CanvasEdge = {
  /** Stored id when there is one, otherwise derived. See {@link deriveEdgeId}. */
  id: string;
  source: string;
  target: string;
  /** Null means the document names no handle, which is NOT the same as `"default"`. */
  sourceHandle: string | null;
  targetHandle: string | null;
  label: string | null;
  data: {
    /** True when the id above was derived, so the document cannot be patched by it. */
    synthesizedId: boolean;
  };
};

export type CanvasGraphOptions = {
  /**
   * The node catalog's `configFields` for a node type, when the caller has
   * them. Only the alias map is read; see
   * {@link resolveCanvasNodeHandles}'s `configFields` for why it is an input
   * rather than a lookup, and what a caller gives up by omitting it.
   */
  resolveConfigFields?: (nodeType: string) => unknown;
};

export type ToStoredGraphInput = {
  /**
   * The document the canvas was built from. Everything the canvas does not
   * describe comes from here, unchanged — top-level keys, unknown node and edge
   * keys, and every field no edit touched.
   */
  base: WorkflowDefinitionGraph;
  nodes: ReadonlyArray<CanvasNode>;
  edges: ReadonlyArray<CanvasEdge>;
  /**
   * Whether this canvas is authoritative about layout. Default false.
   *
   * Off, a `position` is written only for a node that already had one: dragging
   * a laid-out graph persists, and a graph with no layout does not acquire one.
   * That asymmetry is the point. Materialising positions is irreversible in
   * practice — "nobody has arranged this yet" becomes "this is the arrangement"
   * for every node at once, on a save the user made for some other reason.
   *
   * On, every node's current position is written. A designer that shows and
   * drags a graph should pass true; a tool that edits config or wiring should
   * not, and then cannot disturb layout at all.
   */
  writePositions?: boolean;
  /**
   * The definition's process variables, as the caller is holding them.
   *
   * Structural rather than imported, so this module keeps depending on nothing:
   * `ProcessVariableSet` in `editor/process-variables.ts` satisfies it, and the
   * dependency runs editor → graph like every other one in this folder.
   *
   * **Omit it and neither key is touched**, which is the same asymmetry
   * {@link writePositions} has and is there for the same reason: a tool that
   * edits wiring has nothing to say about a definition's variables, and a
   * caller that passes nothing must not be able to erase them.
   *
   * Passed, each list is written only when it is a DIFFERENT array from the one
   * `readProcessVariableSet` returned off `base` — which is the stored array
   * itself, by reference. A list handed straight back writes nothing. An empty
   * list is written only for a document that already carried the key, so a
   * definition that never had variables does not acquire an empty declaration.
   */
  variables?: {
    readonly fields: readonly unknown[];
    readonly initializers: readonly unknown[];
  };
};

// ---------------------------------------------------------------------------
// Stored -> canvas
// ---------------------------------------------------------------------------

export function toCanvasNodes(
  graph: WorkflowDefinitionGraph,
  options: CanvasGraphOptions = {},
): CanvasNode[] {
  const outgoing = outgoingEdgesBySource(graph);
  const nodes: CanvasNode[] = [];
  const claimed = new Set<string>();

  for (const entry of asArray(graph.nodes)) {
    const record = asRecord(entry);
    const id = asString(record.id);
    // A duplicate id is DUPLICATE_NODE_ID and only the first can be drawn —
    // the same first-occurrence-wins rule definition validation applies. The
    // rest are carried through by `toStoredGraph` rather than shown.
    if (!id || claimed.has(id)) continue;
    claimed.add(id);

    const type = asString(record.type) ?? "";
    const position = storedPosition(record);
    const config = storedConfig(record);

    nodes.push({
      id,
      type,
      position: position ?? { x: 0, y: 0 },
      data: {
        label: canvasLabel(record),
        config: config ?? {},
        outputHandles: resolveCanvasNodeHandles({
          nodeType: type,
          config: record.config,
          configFields: options.resolveConfigFields?.(type),
          outgoingEdges: outgoing.get(id) ?? [],
        }),
        synthesized: {
          label: asString(record.label) === null,
          position: position === null,
          config: config === undefined,
        },
      },
    });
  }

  return nodes;
}

export function toCanvasEdges(graph: WorkflowDefinitionGraph): CanvasEdge[] {
  return identifiedEdges(graph).map(({ record, id, source, target, synthesizedId }) => ({
    id,
    source,
    target,
    sourceHandle: canvasEdgeText(record.sourceHandle),
    targetHandle: canvasEdgeText(record.targetHandle),
    label: canvasEdgeText(record.label),
    data: { synthesizedId },
  }));
}

/**
 * The id a canvas keys this edge by.
 *
 * A stored id wins and is returned verbatim (trimmed, as every other reader
 * normalises one), because renumbering an edge that already has an id breaks
 * every patch addressing it. Otherwise the id is derived from the four fields
 * `edgeIdentity` in `definition-patch.ts` also treats as identifying — source,
 * source handle, target, target handle — so that the same edge derives the same
 * id no matter where it sits in the document. A counter would not: insert an
 * edge above another and every id below it moves, which strands any patch a
 * client is holding and re-keys the whole canvas on reload.
 *
 * `targetHandle` is in there because an edge is genuinely identified by it —
 * two edges may run between one pair of nodes into different target ports — and
 * leaving it out would collapse them onto one id.
 *
 * The parts are percent-encoded and joined with `:`, so a node id that itself
 * contains a separator cannot impersonate a different edge, and a part the
 * document does not carry is a bare `,`, which encoding never produces.
 *
 * Each part is normalised the way every other reader of a stored graph
 * normalises one, so a blank handle keys the same as an absent one: they draw
 * identically, and {@link identifiedEdges} is what keeps two edges that key
 * alike apart. `edgeIdentity` in `definition-patch.ts` does separate them,
 * because it decides which stored edge a write lands on rather than what a
 * canvas shows. Derived ids are for the canvas only and are never written into
 * the document — see this file's header.
 */
export function deriveEdgeId(edge: WorkflowDefinitionEdge): string {
  const record = asRecord(edge);
  const stored = asString(record.id);
  if (stored) return stored;
  return [
    idPart(record.source),
    idPart(record.sourceHandle),
    idPart(record.target),
    idPart(record.targetHandle),
  ].join(":");
}

// ---------------------------------------------------------------------------
// Canvas -> stored
// ---------------------------------------------------------------------------

export function toStoredGraph(input: ToStoredGraphInput): WorkflowDefinitionGraph {
  return {
    // The spread is load-bearing: every top-level key this repo does not know
    // about comes back, in place. Overwriting `nodes` and `edges` keeps their
    // original position, because they already exist on `base`.
    ...input.base,
    ...mergeProcessVariables(input),
    nodes: mergeNodes(input),
    edges: mergeEdges(input),
  };
}

/**
 * The two process-variable keys, when the caller edited them.
 *
 * Returns an object to spread rather than assigning, so a key that is not
 * written is not present at all — assigning `undefined` would put the key on
 * the document with nothing in it, which is a different document from one that
 * never had it.
 *
 * The comparison is the one `mergeNode` makes for `config`, for the same
 * reason: the caller was handed the stored array, so a different array is an
 * edit and the same array is not. See {@link ToStoredGraphInput.variables}.
 */
function mergeProcessVariables(
  input: ToStoredGraphInput,
): Partial<WorkflowDefinitionGraph> {
  const variables = input.variables;
  if (!variables) return {};

  const base = input.base as Record<string, unknown>;
  const merged: Record<string, unknown> = {};

  // The caller's array itself, not a copy. Copying would make the document this
  // produces hold a list the caller no longer recognises, so an editor that
  // adopted it as its new `base` — which is what a save does — would present
  // the variables as edited on the NEXT save and rewrite them every time. The
  // same reason a node's `config` is carried by reference rather than cloned.
  const storedFields = asStoredList(base.processVariables);
  if (
    variables.fields !== storedFields &&
    (storedFields !== undefined || variables.fields.length > 0)
  ) {
    merged.processVariables = variables.fields;
  }

  const storedInitializers = asStoredList(base.processVariableInitializers);
  if (
    variables.initializers !== storedInitializers &&
    (storedInitializers !== undefined || variables.initializers.length > 0)
  ) {
    merged.processVariableInitializers = variables.initializers;
  }

  return merged as Partial<WorkflowDefinitionGraph>;
}

/**
 * The stored list BY REFERENCE, or undefined when the document holds nothing
 * usable — which is a different fact from an empty list, exactly as it is for a
 * node's `config`. A value of the wrong type reads as undefined and is left to
 * the spread rather than replaced.
 */
function asStoredList(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
}

function mergeNodes(input: ToStoredGraphInput): WorkflowDefinitionNode[] {
  const canvasById = new Map(input.nodes.map((node) => [node.id, node] as const));
  const merged: Record<string, unknown>[] = [];
  const drawn = new Set<string>();

  for (const entry of asArray(input.base.nodes)) {
    const record = asRecord(entry);
    const id = asString(record.id);
    // A non-object entry yields no id either, so this one test covers both.
    if (!id || drawn.has(id)) {
      // Nothing could have drawn this, so nothing can have edited it. Carried
      // through in place rather than dropped: it is still somebody's data, and
      // a document the designer cannot render is one its owner has to be able
      // to fix through some other door.
      merged.push(entry as Record<string, unknown>);
      continue;
    }
    drawn.add(id);

    const node = canvasById.get(id);
    // Absent from the canvas means deleted. This is the only place a node
    // leaves the document.
    if (node) merged.push(mergeNode(record, node, input.writePositions === true));
  }

  for (const node of input.nodes) {
    if (drawn.has(node.id)) continue;
    merged.push(newNode(node, input.writePositions === true));
  }

  // The document's own shape is looser than this type, which is why
  // `definition-types.ts` calls the type documentation. Asserted once, here,
  // rather than by pretending the entries were validated.
  return merged as WorkflowDefinitionNode[];
}

function mergeNode(
  base: Record<string, unknown>,
  node: CanvasNode,
  writePositions: boolean,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  // Each field: assign only when the canvas value differs from the value the
  // canvas was handed. An untouched field is not assigned, so its stored value
  // survives whatever it is — a label that is a number, a position with a third
  // coordinate, a config that is a string.
  if (node.data.label !== canvasLabel(base)) {
    merged.label = node.data.label;
  }

  const storedCfg = storedConfig(base);
  if (storedCfg !== undefined) {
    if (node.data.config !== storedCfg) merged.config = node.data.config;
  } else if (Object.keys(node.data.config).length > 0) {
    // A node that had no config and now has fields is configured; one that had
    // none and still shows `{}` is not, however many times a designer rebuilt
    // the object around it.
    merged.config = node.data.config;
  }

  const storedPos = storedPosition(base);
  const moved =
    storedPos === null || storedPos.x !== node.position.x || storedPos.y !== node.position.y;
  if (moved && (storedPos !== null || writePositions)) {
    merged.position = { x: node.position.x, y: node.position.y };
  }

  // `type` is deliberately absent from this list; see the file header.
  return merged;
}

function newNode(node: CanvasNode, writePositions: boolean): Record<string, unknown> {
  // Minimal, and compared against the same synthesized values an existing node
  // is: a label a designer merely DISPLAYED for a node that has none must not
  // become that node's label just because the node is new.
  const created: Record<string, unknown> = { id: node.id, type: node.type };
  if (node.data.label !== canvasLabel(created)) created.label = node.data.label;
  if (Object.keys(node.data.config).length > 0) created.config = node.data.config;
  if (writePositions) created.position = { x: node.position.x, y: node.position.y };
  return created;
}

function mergeEdges(input: ToStoredGraphInput): WorkflowDefinitionEdge[] {
  const canvasById = new Map(input.edges.map((edge) => [edge.id, edge] as const));
  const identified = identifiedEdges(input.base);
  const drawnIndexes = new Map(identified.map((entry) => [entry.index, entry.id] as const));
  const merged: Record<string, unknown>[] = [];

  asArray(input.base.edges).forEach((entry, index) => {
    const id = drawnIndexes.get(index);
    if (id === undefined) {
      // Same argument as an undrawable node.
      merged.push(entry as Record<string, unknown>);
      return;
    }
    const edge = canvasById.get(id);
    if (edge) merged.push(mergeEdge(asRecord(entry), edge));
  });

  const drawn = new Set(drawnIndexes.values());
  for (const edge of input.edges) {
    if (drawn.has(edge.id)) continue;
    merged.push(newEdge(edge));
  }

  return merged as WorkflowDefinitionEdge[];
}

function mergeEdge(base: Record<string, unknown>, edge: CanvasEdge): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  // Endpoints can move — reconnecting an edge that carries a stored id keeps
  // that id — so they are compared like everything else rather than assumed.
  if (edge.source !== asString(base.source)) merged.source = edge.source;
  if (edge.target !== asString(base.target)) merged.target = edge.target;

  assignEdgeText(merged, "sourceHandle", edge.sourceHandle, base.sourceHandle);
  assignEdgeText(merged, "targetHandle", edge.targetHandle, base.targetHandle);
  assignEdgeText(merged, "label", edge.label, base.label);

  // `id` is never assigned: a stored one is already on the spread, and a derived
  // one belongs to the canvas.
  return merged;
}

function newEdge(edge: CanvasEdge): Record<string, unknown> {
  const created: Record<string, unknown> = { source: edge.source, target: edge.target };
  if (edge.sourceHandle !== null) created.sourceHandle = edge.sourceHandle;
  if (edge.targetHandle !== null) created.targetHandle = edge.targetHandle;
  if (edge.label !== null) created.label = edge.label;
  return created;
}

/**
 * Write a handle or a label only when the canvas changed it, and express
 * "cleared" as removal rather than as `""` — an empty `sourceHandle` reads as
 * `"default"` everywhere, which is a different document from one that names no
 * handle at all.
 */
function assignEdgeText(
  target: Record<string, unknown>,
  key: "sourceHandle" | "targetHandle" | "label",
  next: string | null,
  stored: unknown,
): void {
  if (next === canvasEdgeText(stored)) return;
  if (next === null) delete target[key];
  else target[key] = next;
}

// ---------------------------------------------------------------------------
// The synthesized values, derived once and used by both directions
// ---------------------------------------------------------------------------

/**
 * What a node with no label is shown as.
 *
 * The id, because that is what every server-side finding names — `Node "d" can
 * emit output handle "approve"` — so a canvas label that matches it is the one
 * an author can act on. A designer holding the node catalog should prefer the
 * type's own label at RENDER time; doing it here would make the value depend on
 * a catalog the write path cannot re-derive, and the comparison in `mergeNode`
 * would then read a caller's locale as an edit.
 */
function canvasLabel(node: Record<string, unknown>): string {
  return asString(node.label) ?? asString(node.id) ?? asString(node.type) ?? "";
}

/** A position only when the document holds a usable one. */
function storedPosition(node: Record<string, unknown>): CanvasPosition | null {
  const position = asRecord(node.position);
  return typeof position.x === "number" &&
    Number.isFinite(position.x) &&
    typeof position.y === "number" &&
    Number.isFinite(position.y)
    ? { x: position.x, y: position.y }
    : null;
}

/**
 * The stored config BY REFERENCE, so `mergeNode` can tell "the caller replaced
 * this" from "the caller passed it back". Undefined when the document holds
 * nothing usable, which is a different fact from an empty config.
 */
function storedConfig(node: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(node.config) ? (node.config as Record<string, unknown>) : undefined;
}

/** A stored string, verbatim, or null. Not trimmed: the document's value is the value. */
function canvasEdgeText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------
// Shared traversal
// ---------------------------------------------------------------------------

type IdentifiedEdge = {
  /** Position in `base.edges`, which is how the write path finds it again. */
  index: number;
  record: Record<string, unknown>;
  id: string;
  source: string;
  target: string;
  synthesizedId: boolean;
};

/**
 * Every edge a canvas can key, with the id it is keyed by.
 *
 * Run by both directions over the same document, so the read path and the write
 * path agree about which base edge a canvas edge came from. Uniqueness is
 * forced here rather than in {@link deriveEdgeId}, which answers about one edge:
 * a document may hold two edges identical in every field, or two carrying the
 * same explicit id — nothing validates edge id uniqueness — and a canvas still
 * has to show both so their owner can delete one. The suffix runs in document
 * order, so it is stable across reloads.
 */
function identifiedEdges(graph: WorkflowDefinitionGraph): IdentifiedEdge[] {
  const identified: IdentifiedEdge[] = [];
  const used = new Set<string>();

  asArray(graph.edges).forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const record = entry as Record<string, unknown>;
    // Without both endpoints there is nothing to attach to a canvas. Carried
    // through by the write path instead.
    const source = asString(record.source);
    const target = asString(record.target);
    if (!source || !target) return;

    // The document's shape is looser than the type, which is what `asRecord`
    // inside `deriveEdgeId` is for; the assertion only satisfies the signature.
    const derived = deriveEdgeId(record as WorkflowDefinitionEdge);
    let id = derived;
    for (let suffix = 2; used.has(id); suffix += 1) id = `${derived}#${suffix}`;
    used.add(id);

    identified.push({
      index,
      record,
      id,
      source,
      target,
      synthesizedId: asString(record.id) === null,
    });
  });

  return identified;
}

function outgoingEdgesBySource(
  graph: WorkflowDefinitionGraph,
): Map<string, { sourceHandle: string | null }[]> {
  const outgoing = new Map<string, { sourceHandle: string | null }[]>();
  for (const { record, source } of identifiedEdges(graph)) {
    const edges = outgoing.get(source) ?? [];
    edges.push({ sourceHandle: canvasEdgeText(record.sourceHandle) });
    outgoing.set(source, edges);
  }
  return outgoing;
}

// ---------------------------------------------------------------------------
// Reading a document the column did not constrain
// ---------------------------------------------------------------------------

/** `,` cannot appear in percent-encoded output, so it can only mean "absent". */
function idPart(value: unknown): string {
  const text = asString(value);
  return text === null ? "," : encodeURIComponent(text);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? (value as Record<string, unknown>) : {};
}

/** Identical to the `asString` every other reader of a stored graph uses. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
