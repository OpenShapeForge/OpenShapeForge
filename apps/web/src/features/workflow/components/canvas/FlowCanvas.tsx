// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  Background,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
  type OnBeforeDelete,
  type OnConnect,
  type OnMoveEnd,
  type OnNodeDrag,
} from "@xyflow/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type RefObject,
} from "react";
// React Flow ships unstyled: without this the viewport, handles and edges have
// no layout at all. It is imported by the component that cannot render without
// it rather than by each page that happens to mount one.
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import { CanvasMinimapPanel } from "./CanvasMinimapPanel";
import { CanvasViewportControl } from "./CanvasViewportControl";
import styles from "./canvas.module.css";
import {
  DEFAULT_FIT_MAX_ZOOM,
  DEFAULT_FIT_MIN_ZOOM,
  DEFAULT_FIT_PADDING,
  DEFAULT_MAX_ZOOM,
  NODE_DRAG_AUTO_PAN_SPEED,
  PALETTE_MIME_TYPE,
} from "./constants";
import { workflowNodeTypes } from "./NodeCard";
import type {
  CanvasViewport,
  WorkflowCanvasEdge,
  WorkflowCanvasNode,
} from "./types";

/**
 * Layers a hovered, a selected and a drop-target edge sit in. Any three values
 * above what the other edges use would do; these leave room between them and
 * below React Flow's own overlays.
 */
const EDGE_HOVER_Z_INDEX = 1100;
const EDGE_SELECTED_Z_INDEX = 1150;
const EDGE_INSERT_TARGET_Z_INDEX = 1200;

export type WorkflowFlowCanvasProps = {
  /** The element a screenshot or an export would capture. */
  canvasRef?: RefObject<HTMLDivElement | null>;
  nodes: WorkflowCanvasNode[];
  edges: WorkflowCanvasEdge[];
  onNodesChange?: (changes: NodeChange<WorkflowCanvasNode>[]) => void;
  onEdgesChange?: (changes: EdgeChange<WorkflowCanvasEdge>[]) => void;
  onConnect?: OnConnect;
  isValidConnection?: IsValidConnection;
  onNodeClick: (event: MouseEvent, node: WorkflowCanvasNode) => void;
  onNodeDoubleClick?: (event: MouseEvent, node: WorkflowCanvasNode) => void;
  onNodeDragStart?: OnNodeDrag<WorkflowCanvasNode>;
  onNodeDrag?: OnNodeDrag<WorkflowCanvasNode>;
  onNodeDragStop?: OnNodeDrag<WorkflowCanvasNode>;
  onEdgeClick?: (event: MouseEvent, edge: WorkflowCanvasEdge) => void;
  onPaneClick: () => void;
  onBeforeDelete?: OnBeforeDelete<WorkflowCanvasNode, WorkflowCanvasEdge>;
  /** A node type was dropped from a palette at this point on the canvas. */
  onAddNodeFromDrop?: (
    nodeType: string,
    flowPosition: { x: number; y: number },
  ) => void;
  /**
   * A palette drag is over the canvas at this point in flow coordinates.
   *
   * The point, and not what is being dragged: while a drag is in flight the
   * drag data store is protected, so `getData` returns nothing and only the
   * MIME TYPE can be read. Which node type is on its way is known to whatever
   * started the drag, and that is where a caller reads it from.
   */
  onCanvasDragOver?: (flowPosition: { x: number; y: number }) => void;
  onCanvasDragLeave?: () => void;
  /**
   * The edge a drop would be inserted into: drawn as the drop target, and
   * lifted above its neighbours so it stays legible under the dragged card.
   */
  insertTargetEdgeId?: string | null;
  initialViewport?: CanvasViewport | null;
  onViewportChange?: (viewport: CanvasViewport) => void;
  /**
   * Look, don't touch. One prop rather than a separate viewer component: every
   * difference between reading a graph and editing one is a handler that is
   * absent, so a second component would be this one with the handlers deleted.
   */
  readOnly?: boolean;
  className?: string;
  /** Renders the floating viewport control when supplied. */
  onFitView?: () => void;
  /** Renders the bottom-right minimap. Off by default. */
  showMinimap?: boolean;
};

/**
 * Reads the dragged node type out of a palette drag.
 *
 * Only on `drop`. `dataTransfer` exposes its *types* while a drag is in flight
 * and its contents only once the drag ends, which is why the payload is
 * deliberately small: everything the canvas has to decide before then is
 * answered by the MIME type alone.
 */
function getDraggedNodeType(event: DragEvent): string | null {
  const raw = event.dataTransfer.getData(PALETTE_MIME_TYPE);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    return typeof parsed.type === "string" && parsed.type.length > 0
      ? parsed.type
      : null;
  } catch {
    return null;
  }
}

/** The React Flow surface a workflow graph is drawn on. */
export function WorkflowFlowCanvas({
  canvasRef,
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  isValidConnection,
  onNodeClick,
  onNodeDoubleClick,
  onNodeDragStart,
  onNodeDrag,
  onNodeDragStop,
  onEdgeClick,
  onPaneClick,
  onBeforeDelete,
  onAddNodeFromDrop,
  onCanvasDragOver,
  onCanvasDragLeave,
  insertTargetEdgeId = null,
  initialViewport = null,
  onViewportChange,
  readOnly = false,
  className,
  onFitView,
  showMinimap = false,
}: WorkflowFlowCanvasProps) {
  const { screenToFlowPosition } = useReactFlow();
  const flowViewportRef = useRef<HTMLDivElement | null>(null);
  const flowViewportReadyRef = useRef(false);
  const [isFlowViewportReady, setIsFlowViewportReady] = useState(false);

  // `fitView` runs once, against whatever box exists at mount. In a layout that
  // measures late — a flex or grid column, a panel that opens — that box is
  // 0×0, and the fit it computes is wrong for the rest of the session. So the
  // flow is not mounted until the box has real dimensions.
  useEffect(() => {
    const element = flowViewportRef.current;
    if (!element) {
      return;
    }

    const markReady = () => {
      if (flowViewportReadyRef.current) return;
      flowViewportReadyRef.current = true;
      setIsFlowViewportReady(true);
    };

    if (typeof ResizeObserver === "undefined") {
      markReady();
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || flowViewportReadyRef.current) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        markReady();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Which edge the cursor is over. Deliberately local: an edge being hovered is
  // not a change to the graph, and lifting it into the owner's state would make
  // a mouse crossing the canvas look like an edit to autosave.
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const handleEdgeMouseEnter = useCallback(
    (_event: MouseEvent, edge: WorkflowCanvasEdge) => setHoveredEdgeId(edge.id),
    [],
  );
  const handleEdgeMouseLeave = useCallback(
    (_event: MouseEvent, edge: WorkflowCanvasEdge) =>
      setHoveredEdgeId((current) => (current === edge.id ? null : current)),
    [],
  );
  const handleMoveEnd = useCallback<OnMoveEnd>(
    (_event, viewport) => {
      onViewportChange?.(viewport);
    },
    [onViewportChange],
  );

  // SVG paint order is document order — there is no `z-index` on a path. React
  // Flow does group edges into one `<svg>` layer per distinct `zIndex`, so
  // raising an edge's `zIndex` is the only way to bring it to the front.
  // A drop target beats selection and selection beats hover, so the edge under
  // discussion stays on top while the cursor crosses the ones around it.
  const edgesWithInteractionElevation = useMemo(() => {
    const hasElevatedEdge =
      hoveredEdgeId !== null ||
      insertTargetEdgeId !== null ||
      edges.some((edge) => edge.selected === true);
    if (!hasElevatedEdge) return edges;

    let touched = false;
    const next = edges.map((edge) => {
      if (edge.id === insertTargetEdgeId) {
        touched = true;
        return {
          ...edge,
          zIndex: EDGE_INSERT_TARGET_Z_INDEX,
          className: cn(edge.className, styles.edgeInsertTarget),
        };
      }
      const nextZIndex =
        edge.selected === true
          ? EDGE_SELECTED_Z_INDEX
          : edge.id === hoveredEdgeId
            ? EDGE_HOVER_Z_INDEX
            : null;
      if (nextZIndex === null) return edge;
      touched = true;
      return { ...edge, zIndex: nextZIndex };
    });
    return touched ? next : edges;
  }, [edges, hoveredEdgeId, insertTargetEdgeId]);

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      // `dragleave` also fires when the cursor crosses from the canvas onto a
      // node inside it, which is not leaving. Both checks below exist to tell
      // those apart: the pointer is still within our box, or the element being
      // entered is one of our descendants.
      const bounds = event.currentTarget.getBoundingClientRect();
      const pointerIsInsideCanvas =
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom;
      if (pointerIsInsideCanvas) {
        return;
      }

      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        return;
      }

      onCanvasDragLeave?.();
    },
    [onCanvasDragLeave],
  );

  const handleDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const nodeType = getDraggedNodeType(event);
      if (!nodeType) {
        return;
      }

      // The drop point is reported once, here. A caller that tracked the drag
      // holds the last point the cursor moved over, which is the same place
      // give or take a pixel, but only this one is where the node lands.
      onAddNodeFromDrop?.(
        nodeType,
        screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      );
    },
    [onAddNodeFromDrop, screenToFlowPosition],
  );

  const handleDragOver = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      // The payload cannot be read yet — see `onCanvasDragOver` — so a palette
      // drag is recognised by its type being on the drag rather than by what
      // that type contains. `drop` is the first moment the contents open up.
      if (!event.dataTransfer.types.includes(PALETTE_MIME_TYPE)) {
        return;
      }

      onCanvasDragOver?.(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    },
    [onCanvasDragOver, screenToFlowPosition],
  );

  return (
    <section className={cn(styles.canvasColumn, className)}>
      <div className={styles.canvasShell}>
        <div
          ref={canvasRef}
          className={styles.canvas}
          data-read-only={readOnly ? "true" : undefined}
        >
          <div
            ref={flowViewportRef}
            className="h-full min-h-0 w-full"
            onDragLeave={readOnly ? undefined : handleDragLeave}
          >
            {isFlowViewportReady ? (
              <ReactFlow
                nodes={nodes}
                edges={edgesWithInteractionElevation}
                nodeTypes={workflowNodeTypes}
                onNodesChange={readOnly ? undefined : onNodesChange}
                onEdgesChange={readOnly ? undefined : onEdgesChange}
                onConnect={readOnly ? undefined : onConnect}
                isValidConnection={readOnly ? undefined : isValidConnection}
                onNodeClick={onNodeClick}
                onNodeDoubleClick={onNodeDoubleClick}
                onNodeDragStart={readOnly ? undefined : onNodeDragStart}
                onNodeDrag={readOnly ? undefined : onNodeDrag}
                onNodeDragStop={readOnly ? undefined : onNodeDragStop}
                onEdgeClick={readOnly ? undefined : onEdgeClick}
                onEdgeMouseEnter={handleEdgeMouseEnter}
                onEdgeMouseLeave={handleEdgeMouseLeave}
                onPaneClick={onPaneClick}
                onBeforeDelete={readOnly ? undefined : onBeforeDelete}
                onMoveEnd={handleMoveEnd}
                onDrop={readOnly ? undefined : handleDrop}
                onDragOver={readOnly ? undefined : handleDragOver}
                // Only fills in a type an edge did not state. `smoothstep` is
                // the stock orthogonal edge; a routed replacement registers
                // under the same key later, so no stored graph has to change.
                defaultEdgeOptions={{ type: "smoothstep" }}
                defaultViewport={initialViewport ?? undefined}
                fitView={!initialViewport}
                fitViewOptions={{
                  padding: DEFAULT_FIT_PADDING,
                  minZoom: DEFAULT_FIT_MIN_ZOOM,
                  maxZoom: DEFAULT_FIT_MAX_ZOOM,
                }}
                minZoom={DEFAULT_FIT_MIN_ZOOM}
                maxZoom={DEFAULT_MAX_ZOOM}
                nodesDraggable={!readOnly}
                nodesConnectable={!readOnly}
                elementsSelectable
                // Design-tool conventions: drag on the pane draws a selection
                // box that catches partially covered nodes; panning is scroll,
                // middle-drag or space-drag; zoom is pinch, not wheel.
                selectionMode={SelectionMode.Partial}
                selectionOnDrag={!readOnly}
                autoPanOnNodeFocus={false}
                autoPanOnNodeDrag
                autoPanSpeed={NODE_DRAG_AUTO_PAN_SPEED}
                panOnDrag={false}
                panOnScroll
                panOnScrollSpeed={1.5}
                zoomOnScroll={false}
                zoomOnPinch
                zoomOnDoubleClick
                proOptions={{ hideAttribution: true }}
              >
                {showMinimap ? <CanvasMinimapPanel /> : null}
                <Background gap={18} size={1} />
              </ReactFlow>
            ) : null}
          </div>
          {onFitView ? <CanvasViewportControl onFitView={onFitView} /> : null}
        </div>
      </div>
    </section>
  );
}
