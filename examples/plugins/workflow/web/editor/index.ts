// SPDX-License-Identifier: BUSL-1.1
/**
 * The editor's decisions, apart from the components that display them.
 *
 * `web/graph/` carries a document to a canvas and back; this is what an editor
 * does in between — what the palette may offer, how a graph changes, what a
 * node's config form looks like, and what a validation result means. All pure,
 * for the reason the adapter is: `apps/web` has no test runner, so anything
 * that can be wrong lives where `bun test examples` reaches it and the
 * components stay assembly.
 */
export {
  buildWorkflowPalette,
  type BuildWorkflowPaletteInput,
  type WorkflowPaletteGroup,
  type WorkflowPaletteItem,
  type WorkflowPaletteNodeType,
  type WorkflowPaletteUnavailability,
} from "./palette";
export {
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
  type CanvasConnection,
  type ConnectionRefusal,
  type ConnectionWarning,
  type ConnectResult,
  type CreateCanvasNodeInput,
  type EditableCanvasGraph,
  type NodePredicates,
} from "./graph-edit";
export {
  buildWorkflowNodeConfigForm,
  type BuildWorkflowNodeConfigFormInput,
  type WorkflowNodeConfigFieldConfig,
  type WorkflowNodeConfigFieldDisplayMode,
  type WorkflowNodeConfigForm,
} from "./config-form";
export {
  summarizeWorkflowValidation,
  type WorkflowValidationIssue,
  type WorkflowValidationSummary,
} from "./validation-view";
