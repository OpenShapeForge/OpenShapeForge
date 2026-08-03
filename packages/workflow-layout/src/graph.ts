// SPDX-License-Identifier: BUSL-1.1
import { NODE_HEIGHT, NODE_WIDTH, PADDING } from "./constants.ts";
import { normalizeHandleId } from "./defaults.ts";
import { normalizeNodePositions, resolveNodeSize } from "./geometry.ts";
import type { WorkflowLayoutEdge, WorkflowLayoutNode } from "./types.ts";

export function resolveElkSourceHandleId(
  node: WorkflowLayoutNode | undefined,
  sourceHandle: string | null | undefined,
) {
  const normalizedSourceHandle = normalizeHandleId(sourceHandle);
  const availableHandles = node?.outputHandles ?? [];

  if (
    normalizedSourceHandle &&
    availableHandles.some((handle) => handle.id === normalizedSourceHandle)
  ) {
    return normalizedSourceHandle;
  }

  if (availableHandles.some((handle) => handle.id === "default")) {
    return "default";
  }

  return availableHandles[0]?.id ?? normalizedSourceHandle ?? "default";
}

export function detectBackEdgeIds(
  nodes: WorkflowLayoutNode[],
  edges: WorkflowLayoutEdge[],
): Set<string> {
  const outgoing = new Map<string, Array<{ edgeId: string; target: string }>>();
  for (const node of nodes) {
    outgoing.set(node.id, []);
  }
  for (const edge of edges) {
    outgoing.get(edge.source)?.push({ edgeId: edge.id, target: edge.target });
  }

  const visited = new Set<string>();
  const onStack = new Set<string>();
  const backEdgeIds = new Set<string>();

  function dfs(nodeId: string) {
    visited.add(nodeId);
    onStack.add(nodeId);

    for (const { edgeId, target } of outgoing.get(nodeId) ?? []) {
      if (!visited.has(target)) {
        dfs(target);
      } else if (onStack.has(target)) {
        backEdgeIds.add(edgeId);
      }
    }

    onStack.delete(nodeId);
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      dfs(node.id);
    }
  }

  return backEdgeIds;
}

export function sortEdges(
  nodes: WorkflowLayoutNode[],
  edges: WorkflowLayoutEdge[],
) {
  const nodeOrder = new Map(
    nodes.map((node, index) => [node.id, index] as const),
  );
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const handleOrder = new Map(
    nodes.map((node) => [
      node.id,
      new Map(
        (node.outputHandles ?? []).map((handle, index) => [
          handle.id,
          index,
        ] as const),
      ),
    ] as const),
  );

  return edges.slice().sort((left, right) => {
    const sourceDiff =
      (nodeOrder.get(left.source) ?? 0) - (nodeOrder.get(right.source) ?? 0);
    if (sourceDiff !== 0) {
      return sourceDiff;
    }

    const sourceHandleOrder = handleOrder.get(left.source);
    const handleDiff =
      (sourceHandleOrder?.get(
        resolveElkSourceHandleId(nodeById.get(left.source), left.sourceHandle),
      ) ?? 0) -
      (sourceHandleOrder?.get(
        resolveElkSourceHandleId(nodeById.get(right.source), right.sourceHandle),
      ) ?? 0);
    if (handleDiff !== 0) {
      return handleDiff;
    }

    // Codepoint order, not `localeCompare`: this is the final tiebreak that
    // makes edge order — and so the laid-out geometry — reproducible, and
    // `localeCompare` with no locale argument reads the runtime's default. Two
    // machines could otherwise lay the same graph out differently.
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export function applyDeterministicFallbackLayout(
  nodes: WorkflowLayoutNode[],
  edges: WorkflowLayoutEdge[],
) {
  const layerByNodeId = new Map<string, number>();
  const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>(nodes.map((node) => [node.id, []]));

  for (const edge of sortEdges(nodes, edges)) {
    outgoing.get(edge.source)?.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  const queue = nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id);

  if (queue.length === 0 && nodes[0]) {
    queue.push(nodes[0].id);
  }

  for (const nodeId of queue) {
    layerByNodeId.set(nodeId, 0);
  }

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId) break;
    const nodeLayer = layerByNodeId.get(nodeId) ?? 0;

    for (const targetId of outgoing.get(nodeId) ?? []) {
      layerByNodeId.set(
        targetId,
        Math.max(layerByNodeId.get(targetId) ?? 0, nodeLayer + 1),
      );
      indegree.set(targetId, (indegree.get(targetId) ?? 0) - 1);
      if ((indegree.get(targetId) ?? 0) === 0) {
        queue.push(targetId);
      }
    }
  }

  let maxAssignedLayer = Math.max(-1, ...layerByNodeId.values());
  for (const node of nodes) {
    if (!layerByNodeId.has(node.id)) {
      maxAssignedLayer += 1;
      layerByNodeId.set(node.id, maxAssignedLayer);
    }
  }

  const nodesByLayer = new Map<number, WorkflowLayoutNode[]>();
  for (const node of nodes) {
    const layer = layerByNodeId.get(node.id) ?? 0;
    const existing = nodesByLayer.get(layer) ?? [];
    existing.push(node);
    nodesByLayer.set(layer, existing);
  }

  const horizontalGap = 72;
  const verticalGap = 120;
  let primaryOffset = PADDING;

  const laidOut = Array.from(nodesByLayer.entries())
    .sort(([left], [right]) => left - right)
    .flatMap(([, layerNodes]) => {
      const maxLayerHeight = Math.max(
        ...layerNodes.map((node) => node.height ?? NODE_HEIGHT),
      );
      const result = layerNodes.map((node, index) => ({
        ...node,
        position: {
          x: PADDING + index * ((node.width ?? NODE_WIDTH) + horizontalGap),
          y: primaryOffset,
        },
      }));

      primaryOffset += maxLayerHeight + verticalGap;
      return result;
    });

  return normalizeNodePositions(laidOut);
}

export function syncLayoutGraph(
  nodes: WorkflowLayoutNode[],
  edges: WorkflowLayoutEdge[],
) {
  const syncedNodes = nodes.map((node) => {
    const size = resolveNodeSize(node);
    return {
      ...node,
      width: size.width,
      height: size.height,
    };
  });

  const syncedEdges = edges.map((edge) => ({ ...edge }));

  return {
    nodes: syncedNodes,
    edges: syncedEdges,
  };
}
