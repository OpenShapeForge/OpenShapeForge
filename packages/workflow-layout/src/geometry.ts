// SPDX-License-Identifier: BUSL-1.1
import {
  NODE_HEIGHT,
  NODE_OVERLAP_GAP,
  NODE_TITLE_EXTRA_LINE_HEIGHT,
  NODE_TITLE_WRAP_TARGET_CHARACTERS,
  NODE_WIDTH,
  OUTPUT_LABEL_BASE_LINE_COUNT,
  OUTPUT_LABEL_COLUMN_MIN_WIDTH,
  OUTPUT_LABEL_EXTRA_LINE_HEIGHT,
  PADDING,
  VERTICAL_OUTPUT_SECTION_HEIGHT,
} from "./constants.ts";
import type { WorkflowLayoutNode } from "./types.ts";

type NodeRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export function estimateWorkflowNodeSize(
  node: Pick<WorkflowLayoutNode, "label" | "type" | "outputHandles">,
) {
  const outputs = node.outputHandles ?? [];
  const label =
    typeof node.label === "string" && node.label.trim() ? node.label : node.type;
  const titleLineCount = label.split(/\r?\n/).reduce(
    (lineCount, line) =>
      lineCount +
      Math.max(
        1,
        Math.ceil(
          Math.max(line.trim().length, 1) / NODE_TITLE_WRAP_TARGET_CHARACTERS,
        ),
      ),
    0,
  );
  const extraTitleHeight =
    Math.max(0, titleLineCount - 1) * NODE_TITLE_EXTRA_LINE_HEIGHT;
  const outputLabelLineCount = outputs.reduce((lineCount, output) => {
    const estimatedLineCount = Math.max(
      1,
      Math.ceil(
        Math.max(output.label.trim().length, 1) / OUTPUT_LABEL_COLUMN_MIN_WIDTH,
      ),
    );
    return Math.max(lineCount, estimatedLineCount);
  }, 1);
  const extraHeight =
    outputs.length > 1
      ? VERTICAL_OUTPUT_SECTION_HEIGHT +
        Math.max(0, outputLabelLineCount - OUTPUT_LABEL_BASE_LINE_COUNT) *
          OUTPUT_LABEL_EXTRA_LINE_HEIGHT
      : 0;

  return {
    width: NODE_WIDTH,
    height: NODE_HEIGHT + extraTitleHeight + extraHeight,
  };
}

export function resolveNodeSize(node: WorkflowLayoutNode) {
  const estimated = estimateWorkflowNodeSize(node);
  return {
    width: Math.max(node.width ?? 0, estimated.width),
    height: Math.max(node.height ?? 0, estimated.height),
  };
}

export function normalizeNodePositions(
  nodes: WorkflowLayoutNode[],
  padding = PADDING,
) {
  if (nodes.length === 0) {
    return nodes;
  }

  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));

  return nodes.map((node) => ({
    ...node,
    position: {
      x: node.position.x - minX + padding,
      y: node.position.y - minY + padding,
    },
  }));
}

export function getNodeWidth(node: WorkflowLayoutNode) {
  return node.width ?? NODE_WIDTH;
}

export function getNodeHeight(node: WorkflowLayoutNode) {
  return node.height ?? NODE_HEIGHT;
}

export function getNodeCenterX(node: WorkflowLayoutNode) {
  return node.position.x + getNodeWidth(node) / 2;
}

export function getNodeRectAtX(node: WorkflowLayoutNode, x: number): NodeRect {
  return {
    left: x,
    right: x + getNodeWidth(node),
    top: node.position.y,
    bottom: node.position.y + getNodeHeight(node),
  };
}

export function rectsOverlap(left: NodeRect, right: NodeRect, gap = 0) {
  return (
    left.left - gap < right.right &&
    left.right + gap > right.left &&
    left.top - gap < right.bottom &&
    left.bottom + gap > right.top
  );
}

export function separateOverlappingNodes(
  nodes: WorkflowLayoutNode[],
): WorkflowLayoutNode[] {
  const sorted = [...nodes].sort((a, b) => a.position.x - b.position.x);
  const positions = new Map(sorted.map((n) => [n.id, { ...n.position }]));

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (!a) continue;
    const aPos = positions.get(a.id);
    if (!aPos) continue;
    const aRight = aPos.x + getNodeWidth(a);
    const aTop = aPos.y;
    const aBottom = aTop + getNodeHeight(a);

    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (!b) continue;
      const bPos = positions.get(b.id);
      if (!bPos) continue;
      const bTop = bPos.y;
      const bBottom = bTop + getNodeHeight(b);

      const verticallyOverlapping = aTop < bBottom && aBottom > bTop;
      if (!verticallyOverlapping) continue;

      const overlap = aRight - bPos.x;
      if (overlap > 0) {
        bPos.x += overlap + NODE_OVERLAP_GAP;
      }
    }
  }

  return nodes.map((n) => {
    const pos = positions.get(n.id);
    if (!pos || (pos.x === n.position.x && pos.y === n.position.y)) return n;
    return { ...n, position: pos };
  });
}
