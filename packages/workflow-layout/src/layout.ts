// SPDX-License-Identifier: BUSL-1.1
import {
  alignLinearChains,
  alignLinearPrefixesToFanout,
  reorderChildrenByPortOrder,
} from "./alignment.ts";
import { PADDING } from "./constants.ts";
import {
  defaultIsTerminalNodeType,
  defaultIsTriggerNodeType,
  defaultOutputHandles,
} from "./defaults.ts";
import {
  buildElkLayoutGraph,
  extractElkRoutePoints,
  getElk,
} from "./elk.ts";
import {
  normalizeNodePositions,
  separateOverlappingNodes,
} from "./geometry.ts";
import {
  applyDeterministicFallbackLayout,
  collectCoercedEdgeHandles,
  detectBackEdgeIds,
  sortEdges,
  syncLayoutGraph,
} from "./graph.ts";
import type {
  WorkflowLayoutDefinition,
  WorkflowLayoutDefinitionEdge,
  WorkflowLayoutEdge,
  WorkflowLayoutNode,
  WorkflowLayoutOptions,
} from "./types.ts";

export async function layoutWorkflowGraph(
  nodes: WorkflowLayoutNode[],
  edges: WorkflowLayoutEdge[],
  options: WorkflowLayoutOptions = {},
): Promise<{ nodes: WorkflowLayoutNode[]; edges: WorkflowLayoutEdge[] }> {
  if (nodes.length === 0) {
    return { nodes, edges };
  }

  const runtime = options.runtime ?? "server";
  const isTriggerNodeType =
    options.isTriggerNodeType ?? defaultIsTriggerNodeType;
  const isTerminalNodeType =
    options.isTerminalNodeType ?? defaultIsTerminalNodeType;
  void isTerminalNodeType;

  const synced = syncLayoutGraph(nodes, edges);
  const fallbackNodes = applyDeterministicFallbackLayout(
    synced.nodes,
    synced.edges,
  );
  const sortedEdges = sortEdges(synced.nodes, synced.edges);
  const backEdgeIds = detectBackEdgeIds(synced.nodes, synced.edges);

  // Report every edge whose handle had to be coerced to place it. Layout draws
  // these anyway — a blank canvas helps nobody find the problem — but the
  // process runtime matches handles exactly and fails the run with
  // NO_EDGE_FOR_HANDLE, so a coerced edge is drawn attached to a port that will
  // never route. Saying so is the whole point: a canvas that renders a broken
  // graph as though it were fine is worse than one that renders nothing.
  for (const coerced of collectCoercedEdgeHandles(synced.nodes, synced.edges)) {
    options.onWarning?.(
      `Workflow auto-layout attached edge "${coerced.edgeId}" to handle ` +
        `"${coerced.resolvedHandle}" on node "${coerced.sourceNodeId}", but the ` +
        `edge declares handle "${coerced.requestedHandle ?? "(none)"}", which ` +
        "that node does not have. Layout can place it; the runtime cannot route it.",
    );
  }
  const graph = buildElkLayoutGraph({
    nodes: synced.nodes,
    sortedEdges,
    backEdgeIds,
    isTriggerNodeType,
  });

  try {
    const elk = await getElk(runtime);
    if (!elk) {
      options.onWarning?.(
        "Workflow auto-layout used deterministic fallback because ELK is unavailable.",
      );
      return { nodes: fallbackNodes, edges: synced.edges };
    }

    const layout = await elk.layout(graph);
    const rawNodes = synced.nodes.map((node) => {
      const layoutNode = layout.children?.find(
        (candidate) => candidate.id === node.id,
      );
      return {
        ...node,
        position: {
          x: layoutNode?.x ?? node.position.x,
          y: layoutNode?.y ?? node.position.y,
        },
      };
    });

    const normalizedNodes = normalizeNodePositions(rawNodes);
    const rawMinX =
      rawNodes.length > 0 ? Math.min(...rawNodes.map((n) => n.position.x)) : 0;
    const rawMinY =
      rawNodes.length > 0 ? Math.min(...rawNodes.map((n) => n.position.y)) : 0;
    const routeOffset = {
      x: PADDING - rawMinX,
      y: PADDING - rawMinY,
    };

    const layoutEdgeById = new Map(
      (layout.edges ?? []).map((edge) => [edge.id, edge] as const),
    );

    const laidOutEdges = synced.edges.map((edge) => {
      if (!options.includeEdgeRoutePoints) {
        return edge;
      }
      const layoutEdge = layoutEdgeById.get(edge.id);
      const routePoints = layoutEdge
        ? extractElkRoutePoints(layoutEdge, routeOffset)
        : undefined;

      if (!routePoints) {
        return edge;
      }

      return {
        ...edge,
        data: {
          ...(edge.data ?? {}),
          routePoints,
        },
      };
    });

    const { nodes: reorderedNodes, reorderedNodeIds } =
      reorderChildrenByPortOrder(normalizedNodes, laidOutEdges);
    const { nodes: alignedNodes, alignedNodeIds } =
      alignLinearPrefixesToFanout(reorderedNodes, laidOutEdges, backEdgeIds);
    const {
      nodes: chainAlignedNodes,
      alignedNodeIds: chainAlignedNodeIds,
    } = alignLinearChains(alignedNodes, laidOutEdges, backEdgeIds);
    const repositionedNodeIds = new Set([
      ...reorderedNodeIds,
      ...alignedNodeIds,
      ...chainAlignedNodeIds,
    ]);
    const separatedNodes = separateOverlappingNodes(chainAlignedNodes);
    const separatedNodeIds = new Set(
      separatedNodes
        .filter((node) => {
          const before = chainAlignedNodes.find(
            (candidate) => candidate.id === node.id,
          );
          return before
            ? before.position.x !== node.position.x ||
                before.position.y !== node.position.y
            : false;
        })
        .map((node) => node.id),
    );
    const staleRouteNodeIds = new Set([
      ...repositionedNodeIds,
      ...separatedNodeIds,
    ]);

    const finalEdges =
      staleRouteNodeIds.size === 0
        ? laidOutEdges
        : laidOutEdges.map((edge) => {
            if (
              !staleRouteNodeIds.has(edge.source) &&
              !staleRouteNodeIds.has(edge.target)
            ) {
              return edge;
            }
            const { routePoints: _dropped, ...rest } =
              (edge.data as Record<string, unknown> & {
                routePoints?: unknown;
              }) ?? {};
            void _dropped;
            return { ...edge, data: rest };
          });

    return { nodes: separatedNodes, edges: finalEdges };
  } catch (error) {
    options.onWarning?.(
      "Workflow auto-layout failed; using deterministic fallback.",
      error,
    );
    return { nodes: fallbackNodes, edges: synced.edges };
  }
}

function buildLayoutNodesFromDefinition(
  definition: WorkflowLayoutDefinition,
  options: WorkflowLayoutOptions,
) {
  const outgoingEdgesByNode = new Map<string, WorkflowLayoutDefinitionEdge[]>();
  for (const edge of definition.edges) {
    outgoingEdgesByNode.set(edge.source, [
      ...(outgoingEdgesByNode.get(edge.source) ?? []),
      edge,
    ]);
  }

  return definition.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    label: node.label,
    position: node.position,
    config: node.config,
    outputHandles:
      options.resolveNodeOutputHandles?.({
        node,
        outgoingEdges: outgoingEdgesByNode.get(node.id) ?? [],
        definition,
      }) ??
      defaultOutputHandles({
        node,
        outgoingEdges: outgoingEdgesByNode.get(node.id) ?? [],
      }),
  }));
}

export async function layoutWorkflowDefinition<
  TDefinition extends WorkflowLayoutDefinition,
>(
  definition: TDefinition,
  options: WorkflowLayoutOptions = {},
): Promise<TDefinition> {
  const layoutNodes = buildLayoutNodesFromDefinition(definition, options);
  const { nodes } = await layoutWorkflowGraph(
    layoutNodes,
    definition.edges,
    options,
  );
  const positionByNodeId = new Map(
    nodes.map((node) => [node.id, node.position] as const),
  );

  return {
    ...definition,
    nodes: definition.nodes.map((node) => ({
      ...node,
      position: positionByNodeId.get(node.id) ?? node.position,
    })),
  };
}
