// SPDX-License-Identifier: BUSL-1.1
"use client";

/**
 * The workflow designer: a canvas you can edit, and somewhere to save it.
 *
 * Assembly. Every decision this screen makes lives in
 * `examples/plugins/workflow/web/` — the palette's gate, the graph operations,
 * the config form, the reading of a validation result — because `apps/web` has
 * no test runner and no DOM environment, so logic here could not be tested at
 * all. What is left is wiring: React state, the handlers React Flow reports
 * into, and the server actions the page handed down.
 *
 * ## Why the actions arrive as props
 *
 * There is no client-side GraphQL in this app. `lib/server/graphql-client.ts`
 * is `server-only`, no rewrite exposes the API, and in local development the
 * browser cannot reach its port at all. So a server component passes server
 * action references down, exactly as `hooks/use-infinite-list.ts` and the
 * generated entity pages already do.
 *
 * ## Positions are written when the author has said something about position
 *
 * `toStoredGraph`'s `writePositions` is off by default so that a graph nobody
 * has arranged cannot acquire an arrangement as a side effect of an edit made
 * for some other reason — materialising a layout is irreversible in practice,
 * because "nobody has laid this out" becomes "this is the layout" for every
 * node at once.
 *
 * But off, a NEW node's position is not written either, and a graph with no
 * layout does not persist a drag: the author moves a card, saves, reloads, and
 * it is back where auto-layout put it. A canvas that lets a user drag a node
 * and then drops the change is worse than one that does not move.
 *
 * So the flag follows the author rather than a constant: it is on once they
 * have placed or moved a node in this session, and off until then. Editing
 * config and wiring cannot disturb layout; touching layout persists it.
 *
 * ## Dropping onto an edge inserts, and the drag says so before it happens
 *
 * A palette drop over an edge runs the node BETWEEN that edge's endpoints —
 * `insertCanvasNodeIntoEdge`, which re-points the edge it splits rather than
 * adding a second one out of the same port. Which edge that is, if any, is
 * `findCanvasEdgeAtPoint`'s answer, because a step edge does not run in a
 * straight line between two cards and the endpoints cannot say where it is.
 *
 * The node type comes from the palette rather than from the drag: while a drag
 * is in flight the drag data store is protected, so the canvas can see that one
 * of ITS drags is overhead but not what is on it. The type is captured when the
 * drag starts, and the preview card is built by the same `createCanvasNode` the
 * drop will call, so nothing about the card changes when the author lets go.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ReactFlowProvider,
  useReactFlow,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import { Button } from "@openshapeforge/ui";
import type { LucideIconName } from "@/components/ui/icons/LucideIconByName";
import {
  WorkflowFlowCanvas,
  type WorkflowCanvasEdge,
  type WorkflowCanvasNode,
} from "../canvas";
import {
  addCanvasNode,
  buildWorkflowPalette,
  connectCanvasNodes,
  createCanvasNode,
  deleteCanvasEdges,
  deleteCanvasNodes,
  insertCanvasNodeIntoEdge,
  moveCanvasNode,
  setCanvasNodeConfig,
  setCanvasNodeLabel,
  summarizeWorkflowValidation,
  type ConnectionRefusal,
  type ConnectionWarning,
  type EditableCanvasGraph,
} from "../../../../../../../examples/plugins/workflow/web/editor/index";
import {
  toCanvasEdges,
  toCanvasNodes,
  toStoredGraph,
  type CanvasNode,
} from "../../../../../../../examples/plugins/workflow/web/graph/index";
import {
  EDGE_HIT_TOLERANCE_PX,
  findCanvasEdgeAtPoint,
} from "../../../../../../../examples/plugins/workflow/web/canvas/edge-hit-test";
import {
  isEntryNodeType,
  isTerminalNodeType,
} from "../../../../../../../examples/plugins/workflow/runtime/definition-types";
import {
  resolveWorkflowNodePresentation,
  type WorkflowNodePresentation,
} from "../../../../../../../examples/plugins/workflow/web/presentation";
import { WorkflowNodePalette } from "./NodePalette";
import { WorkflowNodeInspector } from "./NodeInspector";
import { WorkflowValidationPanel } from "./ValidationPanel";
import { useCanvasHistory, useCanvasHistoryShortcuts } from "./use-canvas-history";
import {
  useWorkflowDefinitionLock,
  type DefinitionLockActions,
} from "./use-definition-lock";
import type {
  WorkflowActionResult,
  WorkflowDefinitionSummary,
  WorkflowValidationIssueView,
} from "../../actions/workflow-definitions";

/** The catalog slice the editor reads, as the page fetched it. */
export type WorkflowEditorNodeType = {
  type: string;
  catalog: string;
  category: string;
  label: Record<string, string> | null;
  description: Record<string, string> | null;
  runtimeSupport: string;
  /** The `Field[]` the inspector renders. Served as JSON. */
  configFields: unknown;
};

export type WorkflowEditorProps = {
  definition: WorkflowDefinitionSummary;
  /** The draft graph, exactly as the API returned it. */
  graph: unknown;
  /** The version the graph came from; null when the definition has none yet. */
  version: number | null;
  nodeTypes: WorkflowEditorNodeType[];
  save: (input: {
    definitionId: string;
    expectedUpdatedAt: string;
    definition: unknown;
    changelog?: string;
  }) => Promise<WorkflowActionResult<WorkflowDefinitionSummary>>;
  publish: (input: {
    definitionId: string;
    version: number;
  }) => Promise<WorkflowActionResult<{ version: number; publishedAt: string | null }>>;
  validate: (
    definition: unknown,
  ) => Promise<WorkflowActionResult<{ valid: boolean; issues: WorkflowValidationIssueView[] }>>;
  lockActions: DefinitionLockActions;
  locale?: string;
};

/**
 * Wording for a connection the canvas would not draw.
 *
 * Each is a state the server refuses at write, or a gesture with no meaning.
 * Anything the server defers to publish is drawn and reported by the
 * validation panel instead — a designer stricter than the API it saves through
 * is a designer that disagrees with it.
 */
const REFUSAL_MESSAGE: Record<ConnectionRefusal, string> = {
  UNKNOWN_ENDPOINT: "One end of that connection is not on the canvas.",
  SELF_CONNECTION: "A node cannot connect to itself.",
  TARGET_IS_ENTRY: "A trigger starts a workflow, so nothing can point at it.",
  SOURCE_IS_TERMINAL: "An end node finishes a workflow, so nothing can leave it.",
  DUPLICATE_EDGE: "Those two are already connected that way.",
};

const WARNING_MESSAGE: Record<ConnectionWarning, string> = {
  HANDLE_OCCUPIED:
    "That output now has two edges. The graph still saves; publishing will refuse it until one is removed.",
};

/**
 * The delete gesture, as a coalescing tag that names no element on purpose.
 *
 * Deleting a node arrives twice: React Flow reports the edges first, through
 * `onEdgesChange`, and then the node through `onNodesChange`, where
 * `deleteCanvasNodes` finds the edges already gone. One keypress has to be one
 * undo, so both halves carry this and collapse into a single entry.
 *
 * Two deletions in a row stay apart because selecting the second node commits
 * first — a delete needs a selection, and a selection ends the open run.
 */
const DELETE_EDIT = { kind: "delete", target: "" };

/** The palette drag in flight, and what letting go of it would do. */
type PaletteDrag = {
  nodeType: string;
  /** Where the card would land, in flow coordinates. */
  position: { x: number; y: number };
  /** The edge the drop would split, or null for a loose node. */
  edgeId: string | null;
};

/**
 * One card on the canvas, from the graph node the editor holds.
 *
 * Shared by the drawn nodes and by the preview of the one being dragged, so a
 * card cannot look like two different things either side of a drop.
 */
function toCanvasCard(
  node: CanvasNode,
  presentation: WorkflowNodePresentation,
  options: { selected?: boolean; preview?: "palette" | "edgeInsert" } = {},
): WorkflowCanvasNode {
  return {
    id: node.id,
    type: "workflowNode" as const,
    position: node.position,
    selected: options.selected === true,
    // A preview stands for a node that does not exist yet, so nothing may drag
    // it, select it or delete it.
    ...(options.preview ? { draggable: false, selectable: false } : {}),
    data: {
      label: node.data.label,
      typeLabel: presentation.typeLabel,
      iconName: presentation.iconName as LucideIconName,
      categoryTone: presentation.categoryTone,
      isTrigger: presentation.isTrigger,
      isTerminal: presentation.isTerminal,
      outputHandles: node.data.outputHandles,
      palettePreview: options.preview === "palette",
      edgeInsertPreview: options.preview === "edgeInsert",
    },
  };
}

export function WorkflowEditor(props: WorkflowEditorProps) {
  return (
    <ReactFlowProvider>
      <WorkflowEditorSurface {...props} />
    </ReactFlowProvider>
  );
}

function WorkflowEditorSurface({
  definition,
  graph: storedGraph,
  version,
  nodeTypes,
  save,
  publish,
  validate,
  lockActions,
  locale = "en",
}: WorkflowEditorProps) {
  // The canvas converts a drop point to flow coordinates itself. What is read
  // here is the viewport — for the click-to-add position, and for the zoom that
  // turns a pointer distance into a flow-space one — and the measured node
  // boxes the edge hit test needs, which only React Flow has.
  const { getNodes, getViewport } = useReactFlow<WorkflowCanvasNode, WorkflowCanvasEdge>();

  const catalog = useMemo(
    () => new Map(nodeTypes.map((entry) => [entry.type, entry] as const)),
    [nodeTypes],
  );
  const configFieldsFor = useCallback(
    (nodeType: string) => catalog.get(nodeType)?.configFields,
    [catalog],
  );

  // The document every save merges onto. Held apart from the canvas graph
  // because `toStoredGraph` needs the ORIGINAL objects to tell an edit from a
  // value it handed over — rebuilding it from the canvas would destroy every
  // key this repo does not understand.
  const [base, setBase] = useState<Record<string, unknown>>(
    () => (storedGraph && typeof storedGraph === "object" ? storedGraph : { nodes: [], edges: [] }) as Record<string, unknown>,
  );
  // The canvas graph, and the graphs behind it. `base` is deliberately NOT on
  // that stack: an undo restores a canvas, and the document it merges onto is
  // whatever was last written. Rewinding both would resurrect the keys a save
  // removed — see the history module's header.
  const history = useCanvasHistory(() => {
    const source = (storedGraph ?? { nodes: [], edges: [] }) as Parameters<typeof toCanvasNodes>[0];
    return {
      nodes: toCanvasNodes(source, { resolveConfigFields: (type) => catalog.get(type)?.configFields }),
      edges: toCanvasEdges(source),
    };
  });
  const graph: EditableCanvasGraph = history.graph;
  // Not a flag anybody has to remember to set: the present graph differs from
  // the one that was written, or it does not. Undoing back to what was saved
  // therefore stops offering a save with nothing in it.
  const dirty = history.dirty;

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [paletteDrag, setPaletteDrag] = useState<PaletteDrag | null>(null);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(definition.updatedAt);
  const [latestVersion, setLatestVersion] = useState<number | null>(version);
  const [layoutTouched, setLayoutTouched] = useState(false);
  const [busy, setBusy] = useState<"save" | "publish" | "validate" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [issues, setIssues] = useState<WorkflowValidationIssueView[] | null>(null);

  const lock = useWorkflowDefinitionLock(definition.id, lockActions);
  const readOnly = lock.held === null;

  // Not gated on `busy`: a save records the graph it SENT, so undoing while one
  // is in flight leaves the editor correctly dirty rather than racing it.
  useCanvasHistoryShortcuts({ enabled: !readOnly, undo: history.undo, redo: history.redo });

  const summary = useMemo(() => summarizeWorkflowValidation(issues), [issues]);
  const palette = useMemo(
    () => buildWorkflowPalette({ nodeTypes, locale }),
    [nodeTypes, locale],
  );
  const presentationFor = useCallback(
    (nodeType: string) =>
      resolveWorkflowNodePresentation({ nodeType, entry: catalog.get(nodeType), locale }),
    [catalog, locale],
  );

  /**
   * Every graph change goes through here, so nothing can move the canvas
   * without the history seeing it — which is what keeps both "dirty" and the
   * undo stack honest without a flag to remember.
   *
   * The optional second argument is the coalescing tag: consecutive edits
   * carrying the same one replace each other rather than stacking, which is
   * what makes a drag one undo. A gesture that happens once passes none.
   */
  const edit = history.edit;

  /**
   * Choose what to work on, which is also where a run of edits ends.
   *
   * Selecting something else is the boundary between two label edits, two
   * config edits or two deletions of the same kind, so it commits: without it,
   * renaming one node and then another would be a single undo.
   */
  const selectNode = useCallback(
    (nodeId: string | null) => {
      history.commit();
      setSelectedNodeId(nodeId);
    },
    [history.commit],
  );

  // Held apart from the preview below so that a drag, which reports a new
  // position several times a second, does not rebuild every card on the canvas
  // on every one of those reports.
  const graphCards = useMemo<WorkflowCanvasNode[]>(
    () =>
      graph.nodes.map((node) =>
        toCanvasCard(node, presentationFor(node.type), {
          selected: node.id === selectedNodeId,
        }),
      ),
    [graph.nodes, presentationFor, selectedNodeId],
  );

  const canvasNodes = useMemo<WorkflowCanvasNode[]>(() => {
    if (paletteDrag === null) return graphCards;

    // Built by the function the drop will call, against the graph it will be
    // added to, so the preview carries the id, label and ports the node is
    // about to have rather than a placeholder that changes on release.
    const preview = createCanvasNode({
      nodeType: paletteDrag.nodeType,
      position: paletteDrag.position,
      graph,
      configFields: configFieldsFor(paletteDrag.nodeType),
    });
    return [
      ...graphCards,
      toCanvasCard(preview, presentationFor(paletteDrag.nodeType), {
        preview: paletteDrag.edgeId === null ? "palette" : "edgeInsert",
      }),
    ];
  }, [configFieldsFor, graph, graphCards, paletteDrag, presentationFor]);

  const canvasEdges = useMemo<WorkflowCanvasEdge[]>(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        // Absent stays absent. Materializing "default" here would draw a
        // different document from the one that was read.
        ...(edge.sourceHandle != null ? { sourceHandle: edge.sourceHandle } : {}),
        ...(edge.targetHandle != null ? { targetHandle: edge.targetHandle } : {}),
        ...(edge.label != null ? { label: edge.label } : {}),
      })),
    [graph.edges],
  );

  // ---------------------------------------------------------------------
  // Canvas interaction
  // ---------------------------------------------------------------------

  const handleNodesChange = useCallback(
    (changes: NodeChange<WorkflowCanvasNode>[]) => {
      // Collected rather than applied one at a time. Dragging several nodes
      // reports one change per node per frame, and the tag has to name the
      // whole gesture: applied singly, consecutive frames would look like edits
      // to different targets and each would cost its own undo entry.
      const dragging: string[] = [];
      const moves: { nodeId: string; position: { x: number; y: number } }[] = [];
      const removed: string[] = [];
      let dragEnded = false;

      for (const change of changes) {
        if (change.type === "position") {
          dragging.push(change.id);
          // The release, which React Flow reports as a position change carrying
          // `dragging: false` — on the abort path as well as the ordinary one.
          if (change.dragging === false) dragEnded = true;
          if (!change.position) continue;

          // A position change that moves nothing is not a statement about
          // layout, and this is where that distinction is load-bearing rather
          // than tidy: `layoutTouched` is what turns `writePositions` on, so a
          // no-op change would materialise a layout for EVERY node on a graph
          // nobody has arranged — irreversibly, on a save the author made for
          // some other reason. Clicking a card must not do that, and neither
          // must a drag that ends where it started.
          const at = graph.nodes.find((node) => node.id === change.id)?.position;
          if (at && at.x === change.position.x && at.y === change.position.y) continue;
          moves.push({ nodeId: change.id, position: change.position });
        } else if (change.type === "remove") {
          removed.push(change.id);
        } else if (change.type === "select" && change.selected) {
          selectNode(change.id);
        }
      }

      if (moves.length > 0) {
        // Applied on every frame, not only on drop: the nodes React Flow draws
        // come from this state, so a card that only moved at drag-stop would
        // not follow the cursor. Still one undo — the tag names the nodes under
        // the cursor and does not change while they are under it.
        edit(
          (current) => moves.reduce((next, move) => moveCanvasNode(next, move), current),
          { kind: "move", target: dragging.join(" ") },
        );
        setLayoutTouched(true);
      }

      // After the move, so the frame carrying the release belongs to the drag
      // it ends rather than starting the next one.
      if (dragEnded) history.commit();

      if (removed.length > 0) {
        // One call rather than one per node: `deleteCanvasNodes` sweeps the
        // edges itself, and a multi-node delete is one gesture.
        edit((current) => deleteCanvasNodes(current, removed), DELETE_EDIT);
        setSelectedNodeId((current) =>
          current !== null && removed.includes(current) ? null : current,
        );
      }
    },
    [edit, graph.nodes, history.commit, selectNode],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<WorkflowCanvasEdge>[]) => {
      const removed = changes.filter((change) => change.type === "remove").map((change) => change.id);
      // Tagged like the node deletion it usually arrives with. Deleting an edge
      // on its own is one entry either way; deleting a node is reported here
      // first and through `onNodesChange` second, and is one gesture.
      if (removed.length > 0) edit((current) => deleteCanvasEdges(current, removed), DELETE_EDIT);
    },
    [edit],
  );

  const handleConnect = useCallback(
    (connection: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) => {
      // Computed against the graph in scope rather than inside a `setGraph`
      // updater. An updater has to be pure — React invokes it twice in
      // development to prove that it is — so a `setStatus` inside one fires
      // twice and makes a message the user never triggered look like an event.
      const result = connectCanvasNodes(graph, connection, {
        isEntry: isEntryNodeType,
        isTerminal: isTerminalNodeType,
      });
      setStatus(
        result.refused
          ? REFUSAL_MESSAGE[result.refused]
          : result.warned
            ? WARNING_MESSAGE[result.warned]
            : null,
      );
      // No tag: drawing an edge happens once, so it is always its own undo. A
      // refusal returns the graph it was given and records nothing.
      history.replace(result.graph);
    },
    [graph, history.replace],
  );

  /**
   * Put a new node on the canvas: loose, or between the endpoints of the edge
   * it was dropped on.
   *
   * The two are one function because they differ only in what happens to the
   * edges. Splitting re-points the edge it lands on and carries a new one
   * onward, which is what stops the gesture producing two edges on one source
   * handle — refused at publish, and fatal at run time.
   */
  const placeNode = useCallback(
    (
      nodeType: string,
      position: { x: number; y: number },
      splitEdgeId: string | null,
    ) => {
      edit((current) => {
        const node = createCanvasNode({
          nodeType,
          position,
          graph: current,
          configFields: configFieldsFor(nodeType),
        });
        return splitEdgeId === null
          ? addCanvasNode(current, node)
          : insertCanvasNodeIntoEdge(current, { node, edgeId: splitEdgeId });
      });
      // The author placed it. That is a statement about layout, so positions
      // are persisted from here on — including this node's own.
      setLayoutTouched(true);
    },
    [configFieldsFor, edit],
  );

  const handleAddFromPalette = useCallback(
    (nodeType: string) => {
      // A click has no drop point, so the node goes to the middle of what the
      // author is looking at rather than to the graph's origin, which may be
      // off screen entirely. It lands loose: a click chose a type, not a place.
      const viewport = getViewport();
      placeNode(
        nodeType,
        {
          x: -viewport.x / viewport.zoom + 160,
          y: -viewport.y / viewport.zoom + 120,
        },
        null,
      );
    },
    [getViewport, placeNode],
  );

  // ---------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------

  /**
   * The stored document for the graph as it stands.
   *
   * Built from `base` rather than from scratch, which is the whole reason
   * `base` is held: the definition column is jsonb and the read and write paths
   * both spread what they read, so a key nothing here understands survives —
   * unless a designer rebuilds the document, which is what this does not do.
   */
  const buildDocument = useCallback(
    () =>
      toStoredGraph({
        base: base as Parameters<typeof toStoredGraph>[0]["base"],
        nodes: graph.nodes,
        edges: graph.edges,
        writePositions: layoutTouched,
      }),
    [base, graph.edges, graph.nodes, layoutTouched],
  );

  const runValidation = useCallback(
    async (document: unknown) => {
      const result = await validate(document);
      if (result.ok) {
        setIssues(result.value.issues);
        return result.value.issues;
      }
      setStatus(`Validation could not run: ${result.error}`);
      return null;
    },
    [validate],
  );

  const handleValidate = useCallback(() => {
    setBusy("validate");
    void (async () => {
      await runValidation(buildDocument());
      setBusy(null);
    })();
  }, [buildDocument, runValidation]);

  const handleSave = useCallback(() => {
    setBusy("save");
    setStatus(null);
    void (async () => {
      // Captured alongside the document built from it. A save is asynchronous
      // and an author can undo while it is in flight; marking what was SENT is
      // what leaves them correctly dirty instead of telling them the screen is
      // what the server holds.
      const sent = graph;
      const document = buildDocument();
      const result = await save({
        definitionId: definition.id,
        expectedUpdatedAt,
        definition: document,
      });

      if (!result.ok) {
        // The API's own wording, which for this surface IS the content of the
        // failure: a stale token says somebody else saved, and no rephrasing
        // of that helps an author decide what to do about it.
        setStatus(`Not saved. ${result.error}`);
        setBusy(null);
        return;
      }

      // The refreshed token replaces the one just spent. Keeping the old one
      // would fail every subsequent save and look like a lost lock.
      setExpectedUpdatedAt(result.value.updatedAt);
      setLatestVersion(result.value.latestVersion);
      setBase(document as Record<string, unknown>);
      history.markSaved(sent);
      setStatus(`Saved as version ${result.value.latestVersion ?? "?"}.`);
      // Saving is the moment an author most wants to know what still stands
      // between this draft and a publish.
      await runValidation(document);
      setBusy(null);
    })();
  }, [
    buildDocument,
    definition.id,
    expectedUpdatedAt,
    graph,
    history.markSaved,
    runValidation,
    save,
  ]);

  const handlePublish = useCallback(() => {
    if (latestVersion === null) {
      setStatus("Save a version before publishing.");
      return;
    }
    setBusy("publish");
    setStatus(null);
    void (async () => {
      // Re-validated against what is on screen rather than against the last
      // answer, so a graph edited since the last check cannot be published on
      // a stale all-clear.
      const current = await runValidation(buildDocument());
      if (current !== null && summarizeWorkflowValidation(current).canPublish === false) {
        setStatus("Not published. Fix the issues below first.");
        setBusy(null);
        return;
      }

      const result = await publish({ definitionId: definition.id, version: latestVersion });
      setStatus(
        result.ok
          ? `Published version ${result.value.version}.`
          : `Not published. ${result.error}`,
      );
      setBusy(null);
    })();
  }, [buildDocument, definition.id, latestVersion, publish, runValidation]);

  // ---------------------------------------------------------------------
  // Drop target
  // ---------------------------------------------------------------------

  const canvasRef = useRef<HTMLDivElement | null>(null);

  // What is being dragged, kept out of state because nothing renders from it
  // and because the canvas cannot answer the question: the drag data store is
  // protected until the drop, so the type is captured when the drag starts.
  const draggedNodeType = useRef<string | null>(null);

  /**
   * The edge under a point, measured against the boxes React Flow drew.
   *
   * Sizes come from the flow rather than from the graph because only the
   * renderer knows them — a card grows with its title and its ports — and an
   * unmeasured node is left out entirely: its edges are not drawn where a
   * guessed box would put them.
   */
  const edgeUnderPoint = useCallback(
    (point: { x: number; y: number }) =>
      findCanvasEdgeAtPoint({
        point,
        edges: graph.edges,
        nodes: getNodes().flatMap((node) =>
          node.measured?.width && node.measured.height
            ? [
                {
                  id: node.id,
                  position: node.position,
                  width: node.measured.width,
                  height: node.measured.height,
                  outputHandles: node.data.outputHandles,
                },
              ]
            : [],
        ),
        // A pointer distance, so it is divided by the zoom: the target stays
        // the same size under the cursor however far the author has zoomed out.
        tolerance: EDGE_HIT_TOLERANCE_PX / getViewport().zoom,
      }),
    [getNodes, getViewport, graph.edges],
  );

  const handleCanvasDragOver = useCallback(
    (position: { x: number; y: number }) => {
      const nodeType = draggedNodeType.current;
      if (nodeType === null) return;
      const edgeId = edgeUnderPoint(position);
      setPaletteDrag((current) =>
        // `dragover` fires on a timer as well as on movement, so a cursor
        // resting over the canvas would otherwise re-render it forever.
        current !== null &&
        current.nodeType === nodeType &&
        current.edgeId === edgeId &&
        current.position.x === position.x &&
        current.position.y === position.y
          ? current
          : { nodeType, position, edgeId },
      );
    },
    [edgeUnderPoint],
  );

  const endPaletteDrag = useCallback(() => {
    draggedNodeType.current = null;
    setPaletteDrag(null);
  }, []);

  const handleDrop = useCallback(
    (nodeType: string, position: { x: number; y: number }) => {
      // Asked again at the drop point rather than read off the last `dragover`.
      // They agree to within a pixel, and only this one is where the node lands.
      placeNode(nodeType, position, edgeUnderPoint(position));
      endPaletteDrag();
    },
    [edgeUnderPoint, endPaletteDrag, placeNode],
  );

  const handlePaletteDragStart = useCallback((nodeType: string) => {
    draggedNodeType.current = nodeType;
  }, []);

  // Leaving the canvas ends the preview but not the drag: the cursor can come
  // back, and the type it is carrying has not changed.
  const handleCanvasDragLeave = useCallback(() => setPaletteDrag(null), []);

  const selected = selectedNodeId
    ? (graph.nodes.find((node) => node.id === selectedNodeId) ?? null)
    : null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="mr-auto flex flex-col">
          <h1 className="text-base font-medium">{definition.name}</h1>
          <p className="text-xs text-muted-foreground">
            {latestVersion === null ? "No version yet" : `Draft v${latestVersion}`}
            {definition.publishedVersion !== null
              ? ` · published v${definition.publishedVersion}`
              : " · never published"}
            {dirty ? " · unsaved changes" : ""}
          </p>
        </div>
        <Button
          variant="ghost"
          onClick={history.undo}
          disabled={readOnly || !history.canUndo}
          title="Undo (Ctrl+Z, ⌘Z)"
        >
          Undo
        </Button>
        <Button
          variant="ghost"
          onClick={history.redo}
          disabled={readOnly || !history.canRedo}
          title="Redo (Shift+Ctrl+Z, ⇧⌘Z)"
        >
          Redo
        </Button>
        <Button variant="ghost" onClick={handleValidate} disabled={busy !== null}>
          {busy === "validate" ? "Checking…" : "Check"}
        </Button>
        <Button onClick={handleSave} disabled={readOnly || busy !== null || !dirty}>
          {busy === "save" ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="secondary"
          onClick={handlePublish}
          // Gated on the graph, not only on the button: publishing refuses any
          // error-severity issue, so offering it on a graph that will be
          // refused is offering a button that cannot work.
          disabled={readOnly || busy !== null || dirty || !summary.canPublish}
        >
          {busy === "publish" ? "Publishing…" : "Publish"}
        </Button>
      </header>

      {lock.held === null ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-muted px-4 py-2 text-sm">
          <span>
            {lock.blockedBy
              ? `Someone else is editing this workflow (${lock.blockedBy.ownerUserId}). Their lock expires at ${lock.blockedBy.expiresAt}.`
              : (lock.error ?? "Read-only: no editing lock.")}
          </span>
          <Button variant="ghost" onClick={lock.steal} disabled={lock.pending}>
            Take over editing
          </Button>
        </div>
      ) : null}

      {status ? (
        <p className="border-b border-border px-4 py-2 text-sm text-muted-foreground">{status}</p>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,260px)_1fr_minmax(280px,340px)]">
        <WorkflowNodePalette
          groups={palette}
          presentationFor={presentationFor}
          onAddNode={handleAddFromPalette}
          onDragNodeStart={handlePaletteDragStart}
          onDragNodeEnd={endPaletteDrag}
          disabled={readOnly}
          className="border-r border-border"
        />

        <WorkflowFlowCanvas
          canvasRef={canvasRef}
          nodes={canvasNodes}
          edges={canvasEdges}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={handleConnect}
          onNodeClick={(_event, node) => selectNode(node.id)}
          onPaneClick={() => selectNode(null)}
          onAddNodeFromDrop={handleDrop}
          onCanvasDragOver={handleCanvasDragOver}
          onCanvasDragLeave={handleCanvasDragLeave}
          insertTargetEdgeId={paletteDrag?.edgeId ?? null}
          readOnly={readOnly}
          showMinimap
        />

        <div className="flex min-h-0 flex-col divide-y divide-border overflow-hidden">
          {selected ? (
            <WorkflowNodeInspector
              nodeId={selected.id}
              nodeType={selected.type}
              typeLabel={presentationFor(selected.type).typeLabel}
              label={selected.data.label}
              config={selected.data.config}
              configFields={configFieldsFor(selected.type)}
              readOnly={readOnly}
              // Both are reported per keystroke, and both are tagged by the
              // node they are about, so typing a name is one undo rather than
              // one per letter. Selecting something else ends the run.
              onLabelChange={(label) =>
                edit((current) => setCanvasNodeLabel(current, { nodeId: selected.id, label }), {
                  kind: "label",
                  target: selected.id,
                })
              }
              onConfigChange={(config) =>
                edit(
                  (current) =>
                    setCanvasNodeConfig(current, {
                      nodeId: selected.id,
                      config,
                      configFields: configFieldsFor(selected.type),
                    }),
                  { kind: "config", target: selected.id },
                )
              }
            />
          ) : (
            <p className="p-4 text-sm text-muted-foreground">
              Select a node to configure it.
            </p>
          )}
          <WorkflowValidationPanel
            summary={summary}
            checked={issues !== null}
            onSelectNode={selectNode}
          />
        </div>
      </div>
    </div>
  );
}
