// SPDX-License-Identifier: BUSL-1.1
export { estimateWorkflowNodeSize } from "./geometry.ts";
export { layoutWorkflowDefinition, layoutWorkflowGraph } from "./layout.ts";
/**
 * Exported so a caller can ask the question without laying anything out — a
 * designer wants to flag a drifted edge while the user is looking at it, not
 * only when something happens to trigger a re-layout.
 */
export { collectCoercedEdgeHandles, type CoercedEdgeHandle } from "./graph.ts";
export type {
  WorkflowLayoutDefinition,
  WorkflowLayoutDefinitionEdge,
  WorkflowLayoutDefinitionNode,
  WorkflowLayoutEdge,
  WorkflowLayoutNode,
  WorkflowLayoutOptions,
  WorkflowLayoutOutputHandle,
  WorkflowLayoutPosition,
} from "./types.ts";
