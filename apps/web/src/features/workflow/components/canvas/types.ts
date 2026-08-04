// SPDX-License-Identifier: BUSL-1.1
/**
 * The graph shape the canvas renders.
 *
 * Everything presentational is resolved before it gets here. The canvas is
 * handed a label, a type label, an icon *name*, a colour tone and two booleans
 * — it never looks a node type up in a registry, asks an API what a type is
 * called, or branches on a particular type. That is deliberate: the node
 * catalog in this repository is served over the network, so a component that
 * resolved presentation itself would either have to be async or hold a
 * module-level cache that is stale on first paint. Resolving in the caller also
 * makes every one of these components a pure function of its props.
 */
import type { Edge, Node } from "@xyflow/react";
import type { LucideIconName } from "@/components/ui/icons/LucideIconByName";

/**
 * How a node is coloured. A subset of the design system's node categories: the
 * fourth one it declares belongs to a different editor.
 */
export type WorkflowNodeTone = "trigger" | "default" | "ai";

/** One source handle under the card, in the order it should be drawn. */
export type WorkflowCanvasOutputHandle = {
  id: string;
  label: string;
};

/** Run state overlaid on a node when the canvas shows an execution. */
export type WorkflowCanvasNodeRuntime = {
  /** Short status word, shown as a badge. */
  status?: string | null;
  /** What the node is waiting for, when it is parked. */
  waitKind?: string | null;
  /** Times this node ran. Only shown above one — "×1" is noise. */
  executionCount?: number | null;
  /** The node the run is sitting on right now. */
  isActive?: boolean;
  /** Fade a node the run did not reach. */
  shouldDim?: boolean;
};

/**
 * Highlight for the handle a drag is about to snap to. `role` says which side
 * of the pending connection this node would be.
 */
export type WorkflowCanvasNodeAutoConnectPreview = {
  role: "source" | "target";
  handleId: string;
};

export type WorkflowCanvasNodeData = {
  /** The author's name for this node. */
  label: string;
  /** What kind of node it is, in the reader's language. Shown as the subtitle. */
  typeLabel: string;
  /** Resolved by the caller; unknown names are a build error, not a grey circle. */
  iconName: LucideIconName;
  categoryTone: WorkflowNodeTone;
  /** A trigger starts a workflow, so it has no incoming connector. */
  isTrigger: boolean;
  /** A terminal node ends one, so it has no outgoing connector. */
  isTerminal: boolean;
  outputHandles: WorkflowCanvasOutputHandle[];
  runtime?: WorkflowCanvasNodeRuntime | null;
  autoConnectPreview?: WorkflowCanvasNodeAutoConnectPreview | null;
  /** The ghost card following the cursor during a palette drag. */
  palettePreview?: boolean;
  /** The card previewing a split of the edge it is hovering. */
  edgeInsertPreview?: boolean;
  /** Occupies its space without being drawn — a drag overlay renders it instead. */
  visualHidden?: boolean;
};

/** A node on the workflow canvas. `workflowNode` is the only node type. */
export type WorkflowCanvasNode = Node<WorkflowCanvasNodeData, "workflowNode">;

/**
 * Edges carry no data the canvas reads. They are drawn by the stock
 * `smoothstep` edge, which the canvas fills in for any edge that does not name
 * a type of its own.
 */
export type WorkflowCanvasEdge = Edge;

/** A viewport, saved so it can be restored after the canvas unmounts. */
export type CanvasViewport = {
  x: number;
  y: number;
  zoom: number;
};
