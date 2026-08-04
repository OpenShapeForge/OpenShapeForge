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
} from "../../../../../../../examples/plugins/workflow/web/graph/index";
import {
  isEntryNodeType,
  isTerminalNodeType,
} from "../../../../../../../examples/plugins/workflow/runtime/definition-types";
import { resolveWorkflowNodePresentation } from "../../../../../../../examples/plugins/workflow/web/presentation";
import { WorkflowNodePalette } from "./NodePalette";
import { WorkflowNodeInspector } from "./NodeInspector";
import { WorkflowValidationPanel } from "./ValidationPanel";
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
  // The canvas converts a drop point to flow coordinates itself; what is
  // needed here is only the viewport, for the click-to-add position.
  const { getViewport } = useReactFlow();

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
  const [graph, setGraph] = useState<EditableCanvasGraph>(() => {
    const source = (storedGraph ?? { nodes: [], edges: [] }) as Parameters<typeof toCanvasNodes>[0];
    return {
      nodes: toCanvasNodes(source, { resolveConfigFields: (type) => catalog.get(type)?.configFields }),
      edges: toCanvasEdges(source),
    };
  });

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(definition.updatedAt);
  const [latestVersion, setLatestVersion] = useState<number | null>(version);
  const [dirty, setDirty] = useState(false);
  const [layoutTouched, setLayoutTouched] = useState(false);
  const [busy, setBusy] = useState<"save" | "publish" | "validate" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [issues, setIssues] = useState<WorkflowValidationIssueView[] | null>(null);

  const lock = useWorkflowDefinitionLock(definition.id, lockActions);
  const readOnly = lock.held === null;

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

  /** Every graph change goes through here, so "dirty" cannot be forgotten. */
  const edit = useCallback(
    (next: (current: EditableCanvasGraph) => EditableCanvasGraph) => {
      setGraph((current) => {
        const updated = next(current);
        if (updated !== current) setDirty(true);
        return updated;
      });
    },
    [],
  );

  const canvasNodes = useMemo<WorkflowCanvasNode[]>(
    () =>
      graph.nodes.map((node) => {
        const presentation = presentationFor(node.type);
        return {
          id: node.id,
          type: "workflowNode" as const,
          position: node.position,
          selected: node.id === selectedNodeId,
          data: {
            label: node.data.label,
            typeLabel: presentation.typeLabel,
            iconName: presentation.iconName as LucideIconName,
            categoryTone: presentation.categoryTone,
            isTrigger: presentation.isTrigger,
            isTerminal: presentation.isTerminal,
            outputHandles: node.data.outputHandles,
          },
        };
      }),
    [graph.nodes, presentationFor, selectedNodeId],
  );

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
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          const position = change.position;
          // Applied on every frame, not only on drop: the nodes React Flow
          // draws come from this state, so a card that only moved at drag-stop
          // would not follow the cursor.
          edit((current) => moveCanvasNode(current, { nodeId: change.id, position }));
          setLayoutTouched(true);
        } else if (change.type === "remove") {
          edit((current) => deleteCanvasNodes(current, [change.id]));
          setSelectedNodeId((current) => (current === change.id ? null : current));
        } else if (change.type === "select" && change.selected) {
          setSelectedNodeId(change.id);
        }
      }
    },
    [edit],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<WorkflowCanvasEdge>[]) => {
      const removed = changes.filter((change) => change.type === "remove").map((change) => change.id);
      if (removed.length > 0) edit((current) => deleteCanvasEdges(current, removed));
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
      if (result.graph !== graph) {
        setGraph(result.graph);
        setDirty(true);
      }
    },
    [graph],
  );

  const addNodeAt = useCallback(
    (nodeType: string, position: { x: number; y: number }) => {
      edit((current) =>
        addCanvasNode(
          current,
          createCanvasNode({
            nodeType,
            position,
            graph: current,
            configFields: configFieldsFor(nodeType),
          }),
        ),
      );
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
      // off screen entirely.
      const viewport = getViewport();
      addNodeAt(nodeType, {
        x: -viewport.x / viewport.zoom + 160,
        y: -viewport.y / viewport.zoom + 120,
      });
    },
    [addNodeAt, getViewport],
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
      setDirty(false);
      setStatus(`Saved as version ${result.value.latestVersion ?? "?"}.`);
      // Saving is the moment an author most wants to know what still stands
      // between this draft and a publish.
      await runValidation(document);
      setBusy(null);
    })();
  }, [buildDocument, definition.id, expectedUpdatedAt, runValidation, save]);

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
  const handleDrop = useCallback(
    (nodeType: string, position: { x: number; y: number }) => addNodeAt(nodeType, position),
    [addNodeAt],
  );

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
          onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
          onPaneClick={() => setSelectedNodeId(null)}
          onAddNodeFromDrop={handleDrop}
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
              onLabelChange={(label) =>
                edit((current) => setCanvasNodeLabel(current, { nodeId: selected.id, label }))
              }
              onConfigChange={(config) =>
                edit((current) =>
                  setCanvasNodeConfig(current, {
                    nodeId: selected.id,
                    config,
                    configFields: configFieldsFor(selected.type),
                  }),
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
            onSelectNode={setSelectedNodeId}
          />
        </div>
      </div>
    </div>
  );
}
