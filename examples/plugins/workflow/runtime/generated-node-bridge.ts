// SPDX-License-Identifier: BUSL-1.1
import type {
  GeneratedWorkflowNodeResolvedConfig,
  GeneratedWorkflowNodeType,
} from "../../../../apps/api/src/generated/workflow/node-catalog.js";
import {
  registerWorkflowNodeBridge,
  type WorkflowNodeBridgeHandler,
} from "./node-bridge.js";

export type GeneratedWorkflowNodeBridgeHandler<
  NodeType extends GeneratedWorkflowNodeType,
> = WorkflowNodeBridgeHandler<GeneratedWorkflowNodeResolvedConfig<NodeType>>;

export function registerGeneratedWorkflowNodeBridge<
  NodeType extends GeneratedWorkflowNodeType,
>(
  nodeType: NodeType,
  handler: GeneratedWorkflowNodeBridgeHandler<NodeType>,
): void {
  registerWorkflowNodeBridge(nodeType, handler as WorkflowNodeBridgeHandler);
}
