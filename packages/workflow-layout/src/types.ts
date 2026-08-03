// SPDX-License-Identifier: BUSL-1.1
export type WorkflowLayoutPosition = {
  x: number;
  y: number;
};

export type WorkflowLayoutOutputHandle = {
  id: string;
  label: string;
};

export type WorkflowLayoutNode = {
  id: string;
  type: string;
  label: string;
  position: WorkflowLayoutPosition;
  config?: Record<string, unknown>;
  width?: number;
  height?: number;
  outputHandles?: WorkflowLayoutOutputHandle[];
};

export type WorkflowLayoutEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  label?: string | null;
  data?: Record<string, unknown>;
};

export type WorkflowLayoutDefinitionNode = {
  id: string;
  type: string;
  label: string;
  position: WorkflowLayoutPosition;
  config: Record<string, unknown>;
};

export type WorkflowLayoutDefinitionEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  label?: string;
};

export type WorkflowLayoutDefinition = {
  nodes: WorkflowLayoutDefinitionNode[];
  edges: WorkflowLayoutDefinitionEdge[];
};

export type WorkflowLayoutOptions = {
  runtime?: "browser" | "server";
  includeEdgeRoutePoints?: boolean;
  onWarning?: (message: string, error?: unknown) => void;
  isTriggerNodeType?: (node: WorkflowLayoutNode) => boolean;
  isTerminalNodeType?: (node: WorkflowLayoutNode) => boolean;
  resolveNodeOutputHandles?: (input: {
    node: WorkflowLayoutDefinitionNode;
    outgoingEdges: WorkflowLayoutDefinitionEdge[];
    definition: WorkflowLayoutDefinition;
  }) => WorkflowLayoutOutputHandle[];
};

export type WorkflowLayoutRuntime = NonNullable<WorkflowLayoutOptions["runtime"]>;
