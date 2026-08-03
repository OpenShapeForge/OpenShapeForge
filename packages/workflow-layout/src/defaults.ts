// SPDX-License-Identifier: BUSL-1.1
import type {
  WorkflowLayoutDefinition,
  WorkflowLayoutDefinitionEdge,
  WorkflowLayoutDefinitionNode,
  WorkflowLayoutNode,
  WorkflowLayoutOutputHandle,
} from "./types.ts";

export function defaultIsTriggerNodeType(node: WorkflowLayoutNode) {
  return node.type.startsWith("trigger");
}

export function defaultIsTerminalNodeType(node: WorkflowLayoutNode) {
  return node.type === "end";
}

export function normalizeHandleId(handleId: string | null | undefined) {
  return typeof handleId === "string" && handleId.trim().length > 0
    ? handleId.trim()
    : null;
}

/**
 * A last-resort label for a handle nothing named.
 *
 * Layout needs a string because label length feeds `estimateWorkflowNodeSize`,
 * and a handle with no label would size differently from the same handle once a
 * caller supplied one. These are English rather than localized on purpose: this
 * package has no locale and should not acquire one to serve a fallback. A
 * caller that cares passes `resolveNodeOutputHandles` and never reaches here.
 */
export function defaultHandleLabel(handleId: string) {
  switch (handleId) {
    case "default":
      return "Next";
    case "yes":
      return "Yes";
    case "no":
      return "No";
    case "error":
      return "Error";
    case "timeout":
      return "Timeout";
    default:
      return handleId;
  }
}

export function defaultOutputHandles(input: {
  node: WorkflowLayoutDefinitionNode;
  outgoingEdges: WorkflowLayoutDefinitionEdge[];
  definition?: WorkflowLayoutDefinition;
}): WorkflowLayoutOutputHandle[] {
  if (input.node.type === "end") {
    return [];
  }

  const handles = input.outgoingEdges
    .map((edge) => normalizeHandleId(edge.sourceHandle) ?? "default")
    .filter((handleId, index, all) => all.indexOf(handleId) === index)
    // Sorted so a handle's port index — and therefore the laid-out geometry —
    // does not depend on edge insertion order. Locale-independent because these
    // are handle IDs, not display text: a locale-sensitive comparison would
    // make the layout differ between two machines with different defaults.
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  if (handles.length === 0) {
    return [{ id: "default", label: defaultHandleLabel("default") }];
  }

  return handles.map((id) => ({
    id,
    label: defaultHandleLabel(id),
  }));
}
