// SPDX-License-Identifier: BUSL-1.1
"use client";

/**
 * A stored workflow graph, drawn.
 *
 * This is the join between the two halves of the canvas work, and it is the
 * only place that knows both exist:
 *
 *   - the graph adapter turns a stored definition into canvas nodes and edges,
 *     deciding ids, ports and positions but nothing about appearance;
 *   - the presentation resolver decides appearance from the node catalog;
 *   - the render layer draws whatever it is handed and resolves nothing.
 *
 * Keeping those three apart is what lets the first two be tested at all —
 * `apps/web` has no test runner, so anything with logic in it lives in the
 * plugin, where `bun test examples` reaches it. What is left here is assembly.
 *
 * Read-only, deliberately. Editing needs a definition lock, an autosave path
 * and an undo stack, none of which exist yet; a canvas that let a user drag a
 * node and then quietly dropped the change would be worse than one that does
 * not move.
 */
import { useCallback, useMemo, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import {
  toCanvasEdges,
  toCanvasNodes,
} from "../../../../../../examples/plugins/workflow/web/graph/index";
import { resolveWorkflowNodePresentation } from "../../../../../../examples/plugins/workflow/web/presentation";
import {
  WorkflowFlowCanvas,
  type WorkflowCanvasEdge,
  type WorkflowCanvasNode,
} from "./canvas";
import type { LucideIconName } from "@/components/ui/icons/LucideIconByName";

/** The catalog slice this view needs, as the page fetched it. */
export type WorkflowNodeTypeSummary = {
  type: string;
  category?: Record<string, string> | null;
  label?: Record<string, string> | null;
};

export type WorkflowGraphViewProps = {
  /** The stored definition graph, exactly as the API returned it. */
  graph: unknown;
  nodeTypes: WorkflowNodeTypeSummary[];
  locale?: string;
  className?: string;
};

export function WorkflowGraphView({
  graph,
  nodeTypes,
  locale,
  className,
}: WorkflowGraphViewProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const catalog = useMemo(
    () => new Map(nodeTypes.map((entry) => [entry.type, entry] as const)),
    [nodeTypes],
  );

  const { nodes, edges } = useMemo(() => {
    // The adapter takes the document as-is. It tolerates a malformed one by
    // producing an empty graph rather than throwing, which is what lets a bad
    // definition be looked at instead of only failing.
    const stored = (graph ?? {}) as Parameters<typeof toCanvasNodes>[0];
    const adapted = toCanvasNodes(stored);
    const adaptedEdges = toCanvasEdges(stored);

    const canvasNodes: WorkflowCanvasNode[] = adapted.map((node) => {
      const presentation = resolveWorkflowNodePresentation({
        nodeType: node.type,
        entry: catalog.get(node.type),
        ...(locale ? { locale } : {}),
      });
      return {
        id: node.id,
        // One render type for every workflow node; the STORED type stays in
        // `data` territory rather than becoming the React Flow key.
        type: "workflowNode" as const,
        position: node.position,
        selected: node.id === selectedNodeId,
        data: {
          label: node.data.label,
          typeLabel: presentation.typeLabel,
          // The presentation resolver only ever returns a name the icon
          // registry knows, and its own test keeps that total against the
          // authored node types.
          iconName: presentation.iconName as LucideIconName,
          categoryTone: presentation.categoryTone,
          isTrigger: presentation.isTrigger,
          isTerminal: presentation.isTerminal,
          outputHandles: node.data.outputHandles,
        },
      };
    });

    const canvasEdges: WorkflowCanvasEdge[] = adaptedEdges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      // Absent stays absent. Materializing "default" here would be a different
      // document from the one that was read, and the adapter is careful about
      // exactly that — undoing it at the last step would be a poor joke.
      ...(edge.sourceHandle != null ? { sourceHandle: edge.sourceHandle } : {}),
      ...(edge.label != null ? { label: edge.label } : {}),
    }));

    return { nodes: canvasNodes, edges: canvasEdges };
  }, [graph, catalog, locale, selectedNodeId]);

  const handleNodeClick = useCallback(
    (_event: unknown, node: WorkflowCanvasNode) => setSelectedNodeId(node.id),
    [],
  );
  const handlePaneClick = useCallback(() => setSelectedNodeId(null), []);

  return (
    <ReactFlowProvider>
      <WorkflowFlowCanvas
        nodes={nodes}
        edges={edges}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        readOnly
        showMinimap
        {...(className ? { className } : {})}
      />
    </ReactFlowProvider>
  );
}
