// SPDX-License-Identifier: BUSL-1.1
import {
  LINEAR_CHAIN_COLLISION_GAP,
  NODE_WIDTH,
} from "./constants.ts";
import {
  getNodeCenterX,
  getNodeRectAtX,
  getNodeWidth,
  rectsOverlap,
} from "./geometry.ts";
import { resolveElkSourceHandleId } from "./graph.ts";
import type { WorkflowLayoutEdge, WorkflowLayoutNode } from "./types.ts";

export function reorderChildrenByPortOrder(
  nodes: WorkflowLayoutNode[],
  edges: WorkflowLayoutEdge[],
): { nodes: WorkflowLayoutNode[]; reorderedNodeIds: Set<string> } {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const positionOverrides = new Map<string, { x: number; y: number }>();

  for (const parentNode of nodes) {
    if ((parentNode.outputHandles ?? []).length <= 1) continue;

    const outEdges = edges.filter((e) => e.source === parentNode.id);
    if (outEdges.length <= 1) continue;

    const targetPortIndex = new Map<string, number>();
    for (const edge of outEdges) {
      const handleId = resolveElkSourceHandleId(parentNode, edge.sourceHandle);
      const portIndex = (parentNode.outputHandles ?? []).findIndex(
        (h) => h.id === handleId,
      );
      const resolved =
        portIndex >= 0 ? portIndex : (parentNode.outputHandles ?? []).length;
      const existing = targetPortIndex.get(edge.target);
      if (existing === undefined || resolved < existing) {
        targetPortIndex.set(edge.target, resolved);
      }
    }

    const childIds = Array.from(targetPortIndex.keys());
    const hasSharedChild = childIds.some((childId) => {
      const parentIds = new Set(
        edges.filter((e) => e.target === childId).map((e) => e.source),
      );
      return parentIds.size > 1;
    });
    if (hasSharedChild) continue;

    const childEntries = childIds
      .map((id) => ({
        node: nodeById.get(id),
        portIndex: targetPortIndex.get(id) ?? 0,
      }))
      .filter(
        (x): x is { node: WorkflowLayoutNode; portIndex: number } =>
          x.node !== undefined,
      );

    if (childEntries.length <= 1) continue;

    const ys = childEntries.map((c) => c.node.position.y);
    if (Math.max(...ys) - Math.min(...ys) > 100) continue;

    const byPortIndex = [...childEntries].sort(
      (a, b) => a.portIndex - b.portIndex,
    );
    const groupMinX = Math.min(...childEntries.map((c) => c.node.position.x));
    const groupMaxX = Math.max(
      ...childEntries.map((c) => c.node.position.x + (c.node.width ?? NODE_WIDTH)),
    );
    const groupCenterX = (groupMinX + groupMaxX) / 2;
    const totalWidth =
      byPortIndex.reduce((sum, c) => sum + (c.node.width ?? NODE_WIDTH), 0) +
      (byPortIndex.length - 1) * 72;

    let currentX = groupCenterX - totalWidth / 2;
    for (const child of byPortIndex) {
      positionOverrides.set(child.node.id, {
        x: currentX,
        y: child.node.position.y,
      });
      currentX += (child.node.width ?? NODE_WIDTH) + 72;
    }
  }

  const reorderedNodeIds = new Set(positionOverrides.keys());
  const reorderedNodes = nodes.map((n) => {
    const override = positionOverrides.get(n.id);
    return override ? { ...n, position: override } : n;
  });

  return { nodes: reorderedNodes, reorderedNodeIds };
}

export function alignLinearPrefixesToFanout(
  nodes: WorkflowLayoutNode[],
  edges: WorkflowLayoutEdge[],
  backEdgeIds: Set<string>,
): { nodes: WorkflowLayoutNode[]; alignedNodeIds: Set<string> } {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const forwardEdges = edges.filter((edge) => !backEdgeIds.has(edge.id));
  const incomingByTarget = new Map<string, WorkflowLayoutEdge[]>();
  const outgoingBySource = new Map<string, WorkflowLayoutEdge[]>();
  const positionOverrides = new Map<string, { x: number; y: number }>();

  for (const edge of forwardEdges) {
    incomingByTarget.set(edge.target, [
      ...(incomingByTarget.get(edge.target) ?? []),
      edge,
    ]);
    outgoingBySource.set(edge.source, [
      ...(outgoingBySource.get(edge.source) ?? []),
      edge,
    ]);
  }

  for (const fanoutNode of nodes) {
    const fanoutEdges = outgoingBySource.get(fanoutNode.id) ?? [];
    if ((fanoutNode.outputHandles ?? []).length <= 1 || fanoutEdges.length <= 1) {
      continue;
    }

    const incomingEdges = incomingByTarget.get(fanoutNode.id) ?? [];
    if (incomingEdges.length !== 1) {
      continue;
    }

    const chainNodeIds: string[] = [];
    const seen = new Set<string>([fanoutNode.id]);
    let currentId: string | undefined = incomingEdges[0]?.source;
    let expectedTargetId = fanoutNode.id;

    while (currentId && !seen.has(currentId)) {
      const currentNode = nodeById.get(currentId);
      if (!currentNode) break;

      const outgoing = outgoingBySource.get(currentId) ?? [];
      if (outgoing.length !== 1 || outgoing[0]?.target !== expectedTargetId) {
        break;
      }

      chainNodeIds.push(currentId);
      seen.add(currentId);
      expectedTargetId = currentId;

      const incoming: WorkflowLayoutEdge[] =
        incomingByTarget.get(currentId) ?? [];
      if (incoming.length !== 1) break;

      currentId = incoming[0]?.source;
    }

    if (chainNodeIds.length === 0) continue;

    const targetCenterX = fanoutNode.position.x + (fanoutNode.width ?? NODE_WIDTH) / 2;
    for (const nodeId of chainNodeIds) {
      const node = nodeById.get(nodeId);
      if (!node) continue;

      const nextX = targetCenterX - (node.width ?? NODE_WIDTH) / 2;
      if (Math.abs(nextX - node.position.x) < 1) continue;

      positionOverrides.set(nodeId, {
        x: nextX,
        y: node.position.y,
      });
    }
  }

  const alignedNodeIds = new Set(positionOverrides.keys());
  const alignedNodes = nodes.map((node) => {
    const override = positionOverrides.get(node.id);
    return override ? { ...node, position: override } : node;
  });

  return { nodes: alignedNodes, alignedNodeIds };
}

export function alignLinearChains(
  nodes: WorkflowLayoutNode[],
  edges: WorkflowLayoutEdge[],
  backEdgeIds: Set<string>,
): { nodes: WorkflowLayoutNode[]; alignedNodeIds: Set<string> } {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const forwardEdges = edges.filter((edge) => !backEdgeIds.has(edge.id));
  const incomingByTarget = new Map<string, WorkflowLayoutEdge[]>();
  const outgoingBySource = new Map<string, WorkflowLayoutEdge[]>();
  const positionOverrides = new Map<string, { x: number; y: number }>();

  for (const edge of forwardEdges) {
    incomingByTarget.set(edge.target, [
      ...(incomingByTarget.get(edge.target) ?? []),
      edge,
    ]);
    outgoingBySource.set(edge.source, [
      ...(outgoingBySource.get(edge.source) ?? []),
      edge,
    ]);
  }

  const isLinearContinuationNode = (nodeId: string) => {
    const node = nodeById.get(nodeId);
    if (!node) return false;

    return (
      (incomingByTarget.get(nodeId) ?? []).length === 1 &&
      (outgoingBySource.get(nodeId) ?? []).length <= 1 &&
      (node.outputHandles ?? []).length <= 1
    );
  };

  for (const edge of forwardEdges) {
    const sourceOutgoingCount = outgoingBySource.get(edge.source)?.length ?? 0;
    const sourceIncomingCount = incomingByTarget.get(edge.source)?.length ?? 0;
    const sourceNode = nodeById.get(edge.source);
    const startsChain =
      sourceOutgoingCount !== 1 ||
      sourceIncomingCount !== 1 ||
      (sourceNode?.outputHandles ?? []).length > 1;

    if (!startsChain || !isLinearContinuationNode(edge.target)) continue;

    const chainIds = [edge.target];
    const seen = new Set<string>(chainIds);
    let currentId = edge.target;

    while (true) {
      const outgoing = outgoingBySource.get(currentId) ?? [];
      if (outgoing.length !== 1) break;

      const nextId = outgoing[0]?.target;
      if (!nextId || seen.has(nextId) || !isLinearContinuationNode(nextId)) {
        break;
      }

      chainIds.push(nextId);
      seen.add(nextId);
      currentId = nextId;
    }

    if (chainIds.length < 2) continue;

    const anchorNode = nodeById.get(chainIds[0] ?? "");
    if (!anchorNode) continue;

    const chainIdSet = new Set(chainIds);
    const anchorCenterX = getNodeCenterX(anchorNode);
    const proposed = new Map<string, { x: number; y: number }>();
    let hasCollision = false;

    for (const nodeId of chainIds.slice(1)) {
      const node = nodeById.get(nodeId);
      if (!node) continue;

      const nextX = anchorCenterX - getNodeWidth(node) / 2;
      if (Math.abs(nextX - node.position.x) < 1) continue;

      const nextRect = getNodeRectAtX(node, nextX);
      hasCollision = nodes.some((otherNode) => {
        if (chainIdSet.has(otherNode.id)) return false;

        const otherOverride = positionOverrides.get(otherNode.id);
        const otherRect = getNodeRectAtX(
          otherNode,
          otherOverride?.x ?? otherNode.position.x,
        );
        return rectsOverlap(nextRect, otherRect, LINEAR_CHAIN_COLLISION_GAP);
      });

      if (hasCollision) break;

      proposed.set(nodeId, {
        x: nextX,
        y: node.position.y,
      });
    }

    if (hasCollision) continue;

    for (const [nodeId, position] of proposed) {
      positionOverrides.set(nodeId, position);
    }
  }

  const alignedNodeIds = new Set(positionOverrides.keys());
  const alignedNodes = nodes.map((node) => {
    const override = positionOverrides.get(node.id);
    return override ? { ...node, position: override } : node;
  });

  return { nodes: alignedNodes, alignedNodeIds };
}
