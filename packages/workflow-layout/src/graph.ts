// SPDX-License-Identifier: BUSL-1.1
import { NODE_HEIGHT, NODE_WIDTH, PADDING } from "./constants.ts";
import { normalizeHandleId } from "./defaults.ts";
import { normalizeNodePositions, resolveNodeSize } from "./geometry.ts";
import type { WorkflowLayoutEdge, WorkflowLayoutNode } from "./types.ts";

/**
 * Which port an edge leaves from, for layout purposes.
 *
 * When the edge names a handle the node does not have, this falls back —
 * `default` if the node has one, else the node's first handle. That keeps a
 * drifted graph drawable, which is the right call for a layout engine: refusing
 * to place an edge would leave the user staring at a blank canvas with no way
 * to find the problem.
 *
 * But it is a *presentation* fallback and nothing more. The process runtime
 * matches handles by exact string and fails the run with NO_EDGE_FOR_HANDLE
 * when nothing matches — it does not fall back. So a coerced edge is drawn
 * attached to a port the engine will never route through, and the canvas looks
 * correct precisely where the graph is broken.
 *
 * That is why {@link collectCoercedEdgeHandles} exists and why the layout entry
 * point reports what it coerced. Falling back silently is the failure mode this
 * package must not have: it makes a drawing that disagrees with the engine, and
 * says nothing.
 */
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

/** One edge whose declared handle does not exist on its source node. */
export type CoercedEdgeHandle = {
  edgeId: string;
  sourceNodeId: string;
  /** The handle the edge asked for; null when it named none. */
  requestedHandle: string | null;
  /** The port layout attached it to instead. */
  resolvedHandle: string;
};

/**
 * Every edge {@link resolveElkSourceHandleId} would silently move.
 *
 * Done as one pass over the edge list rather than inside the resolver, because
 * the resolver is also called from `sortEdges`' comparator — warning from there
 * would fire O(n log n) times per layout and in an order that depends on the
 * sort. One pass, in edge order, reports each drifted edge exactly once.
 *
 * An edge naming no handle is not drift: absent means `default` by the same
 * convention the runtime uses, so it is only reported when the node has no
 * `default` port to land on.
 */
export function collectCoercedEdgeHandles(
  nodes: WorkflowLayoutNode[],
  edges: WorkflowLayoutEdge[],
): CoercedEdgeHandle[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const coerced: CoercedEdgeHandle[] = [];

  for (const edge of edges) {
    const node = nodeById.get(edge.source);
    // A dangling edge is a different defect, reported by definition validation
    // rather than invented here from a node this package cannot see.
    if (!node) continue;

    const requested = normalizeHandleId(edge.sourceHandle);
    const available = node.outputHandles ?? [];
    const wanted = requested ?? "default";
    if (available.some((handle) => handle.id === wanted)) continue;

    // A node with no declared handles has nothing to drift from — the caller
    // simply did not supply them, which is a different situation from an edge
    // naming a handle that is genuinely absent.
    if (available.length === 0) continue;

    coerced.push({
      edgeId: edge.id,
      sourceNodeId: edge.source,
      requestedHandle: requested,
      resolvedHandle: resolveElkSourceHandleId(node, edge.sourceHandle),
    });
  }

  return coerced;
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
