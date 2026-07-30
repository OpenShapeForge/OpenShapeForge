// SPDX-License-Identifier: BUSL-1.1
import {
  flattenVisibleVariableTree,
  type WorkflowVariableSuggestionGroup,
} from "@/features/renderer/runtime/variable-suggestion-tree";
import type { NavigationEntry, NavigationTarget } from "./types";

export function navigationTargetFromEntry(entry: NavigationEntry | undefined): NavigationTarget | null {
  if (!entry) {
    return null;
  }

  return entry.kind === "group"
    ? { kind: "group", groupId: entry.groupId }
    : { kind: "item", groupId: entry.groupId, path: entry.path };
}

export function navigationTargetsEqual(left: NavigationTarget | null, right: NavigationTarget | null) {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.kind !== right.kind || left.groupId !== right.groupId) {
    return false;
  }
  return left.kind === "group" || left.path === (right as Extract<NavigationTarget, { kind: "item" }>).path;
}

export function booleanRecordsEqual(left: Record<string, boolean>, right: Record<string, boolean>) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key) => left[key] === right[key]);
}

export function buildNavigationEntries({
  groupedSuggestions,
  expandedGroups,
  expandedFieldTree,
  queryActive,
}: {
  groupedSuggestions: WorkflowVariableSuggestionGroup[];
  expandedGroups: Record<string, boolean>;
  expandedFieldTree: Record<string, boolean>;
  queryActive: boolean;
}): NavigationEntry[] {
  return groupedSuggestions.flatMap((group) => {
    const entries: NavigationEntry[] = [
      { kind: "group", groupId: group.sourceNodeId },
    ];
    const isExpanded = queryActive || (expandedGroups[group.sourceNodeId] ?? false);

    if (isExpanded) {
      if (queryActive) {
        entries.push(
          ...group.suggestions.map((suggestion) => ({
            kind: "item" as const,
            groupId: group.sourceNodeId,
            path: suggestion.path,
            suggestion,
            depth: 0,
          })),
        );
      } else {
        entries.push(
          ...flattenVisibleVariableTree({
            roots: group.fieldTree,
            groupId: group.sourceNodeId,
            expandedByKey: expandedFieldTree,
          }).map((row) => ({
            kind: "item" as const,
            groupId: group.sourceNodeId,
            path: row.suggestion.path,
            suggestion: row.suggestion,
            depth: row.depth,
            treeKey: row.treeKey,
            hasChildren: row.hasChildren,
          })),
        );
      }
    }

    return entries;
  });
}
