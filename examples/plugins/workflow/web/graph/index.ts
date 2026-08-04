// SPDX-License-Identifier: BUSL-1.1
/**
 * The translation layer between a stored workflow graph and a canvas graph.
 *
 * `canvas-graph.ts` carries the document both ways and states the guarantee it
 * holds; `canvas-handles.ts` decides which ports a node offers. Both are pure —
 * no React, no `@xyflow/react`, nothing from `apps/web` — so they run under
 * `bun test`, which is the only place logic this load-bearing can be held.
 */
export {
  deriveEdgeId,
  toCanvasEdges,
  toCanvasNodes,
  toStoredGraph,
  type CanvasEdge,
  type CanvasGraphOptions,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasPosition,
  type CanvasSynthesizedFields,
  type ToStoredGraphInput,
} from "./canvas-graph";
export {
  resolveCanvasNodeHandles,
  type CanvasOutputHandle,
  type ResolveCanvasNodeHandlesInput,
} from "./canvas-handles";
