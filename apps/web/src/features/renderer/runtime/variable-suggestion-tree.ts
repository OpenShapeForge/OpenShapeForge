// SPDX-License-Identifier: BUSL-1.1
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";

export type VariableFieldTreeNode = {
  fieldPath: string;
  suggestion: VariableSuggestion;
  children: VariableFieldTreeNode[];
};

export type WorkflowVariableSuggestionGroup = {
  sourceNodeId: string;
  sourceNodeLabel: string;
  sourceNodeDistance?: number;
  suggestions: VariableSuggestion[];
  fieldTree: VariableFieldTreeNode[];
};

type MutableTreeNode = {
  fieldPath: string;
  suggestion: VariableSuggestion;
  childMap: Map<string, MutableTreeNode>;
};

/**
 * Splits a workflow output field path on dots that are not inside `[...]` (array indices).
 */
export function splitFieldPathSegments(fieldPath: string): string[] {
  const segments: string[] = [];
  let current = "";
  let bracketDepth = 0;

  for (let i = 0; i < fieldPath.length; i++) {
    const c = fieldPath[i];
    if (c === "[") {
      bracketDepth += 1;
    } else if (c === "]") {
      bracketDepth -= 1;
    }

    if (c === "." && bracketDepth === 0) {
      if (current.length > 0) {
        segments.push(current);
        current = "";
      }
    } else {
      current += c;
    }
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

function makeSyntheticSuggestion(
  fieldPath: string,
  segment: string,
  donor: VariableSuggestion,
): VariableSuggestion {
  const label = segment.charAt(0).toUpperCase() + segment.slice(1);
  return {
    path: `${donor.sourceNodeId}::${fieldPath}`,
    displayPath: fieldPath,
    fieldPath,
    insertText: "",
    label,
    sourceNodeId: donor.sourceNodeId,
    sourceNodeLabel: donor.sourceNodeLabel,
    sourceNodeTone: donor.sourceNodeTone,
    sourceNodeDistance: donor.sourceNodeDistance,
    valueType: "object",
  };
}

export function buildVariableFieldTree(
  suggestions: VariableSuggestion[],
): VariableFieldTreeNode[] {
  const byPath = new Map(suggestions.map((s) => [s.fieldPath, s]));
  const roots = new Map<string, MutableTreeNode>();

  for (const suggestion of suggestions) {
    const segments = splitFieldPathSegments(suggestion.fieldPath);
    let map = roots;
    let prefix = "";

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const path = prefix ? `${prefix}.${seg}` : seg;
      const sug = byPath.get(path) ?? (i < segments.length - 1
        ? makeSyntheticSuggestion(path, seg, suggestion)
        : null);
      if (!sug) {
        break;
      }

      if (!map.has(seg)) {
        map.set(seg, {
          fieldPath: path,
          suggestion: sug,
          childMap: new Map(),
        });
      }

      const node = map.get(seg)!;
      if (i === segments.length - 1) {
        break;
      }

      map = node.childMap;
      prefix = path;
    }
  }

  function sortKey(left: MutableTreeNode, right: MutableTreeNode) {
    return left.suggestion.label.localeCompare(right.suggestion.label, undefined, {
      sensitivity: "base",
    });
  }

  function toPublicTree(map: Map<string, MutableTreeNode>): VariableFieldTreeNode[] {
    return Array.from(map.values())
      .sort(sortKey)
      .map((node) => ({
        fieldPath: node.fieldPath,
        suggestion: node.suggestion,
        children: toPublicTree(node.childMap),
      }));
  }

  return toPublicTree(roots);
}

export function variableTreeExpansionKey(groupId: string, fieldPath: string) {
  return `${groupId}::${fieldPath}`;
}

export type VisibleVariableTreeRow = {
  suggestion: VariableSuggestion;
  depth: number;
  hasChildren: boolean;
  treeKey: string;
};

/**
 * Depth-first list of visible rows; children are listed only when expandedByKey[treeKey] is true.
 */
export function flattenVisibleVariableTree(input: {
  roots: VariableFieldTreeNode[];
  groupId: string;
  expandedByKey: Record<string, boolean>;
}): VisibleVariableTreeRow[] {
  const rows: VisibleVariableTreeRow[] = [];

  function walk(nodes: VariableFieldTreeNode[], depth: number) {
    for (const node of nodes) {
      const treeKey = variableTreeExpansionKey(input.groupId, node.fieldPath);
      const hasChildren = node.children.length > 0;
      rows.push({
        suggestion: node.suggestion,
        depth,
        hasChildren,
        treeKey,
      });
      if (hasChildren && input.expandedByKey[treeKey]) {
        walk(node.children, depth + 1);
      }
    }
  }

  walk(input.roots, 0);
  return rows;
}

export function groupVariableSuggestionsBySourceNode(
  suggestions: VariableSuggestion[],
): WorkflowVariableSuggestionGroup[] {
  const groups = new Map<string, WorkflowVariableSuggestionGroup>();

  for (const suggestion of suggestions) {
    const current = groups.get(suggestion.sourceNodeId);
    if (current) {
      current.suggestions.push(suggestion);
      continue;
    }

    groups.set(suggestion.sourceNodeId, {
      sourceNodeId: suggestion.sourceNodeId,
      sourceNodeLabel: suggestion.sourceNodeLabel,
      sourceNodeDistance: suggestion.sourceNodeDistance,
      suggestions: [suggestion],
      fieldTree: [],
    });
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      fieldTree: buildVariableFieldTree(group.suggestions),
    }))
    .sort((left, right) => {
      const leftDistance = left.sourceNodeDistance ?? Number.POSITIVE_INFINITY;
      const rightDistance = right.sourceNodeDistance ?? Number.POSITIVE_INFINITY;
      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }
      return left.sourceNodeLabel.localeCompare(right.sourceNodeLabel, undefined, {
        sensitivity: "base",
      });
    });
}
