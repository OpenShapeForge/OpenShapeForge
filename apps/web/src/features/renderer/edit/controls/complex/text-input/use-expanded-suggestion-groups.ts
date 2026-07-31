// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkflowVariableSuggestionGroup } from "@/features/renderer/runtime/variable-suggestion-tree";
import { booleanRecordsEqual } from "./navigation";

export function useExpandedSuggestionGroups(
  suggestionGroups: WorkflowVariableSuggestionGroup[],
  queryActive: boolean,
) {
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (queryActive) {
      setExpandedGroups((current) => {
        const next = Object.fromEntries(suggestionGroups.map((group) => [group.sourceNodeId, true]));
        return booleanRecordsEqual(current, next) ? current : next;
      });
      return;
    }

    setExpandedGroups((current) => {
      const next = Object.fromEntries(
        suggestionGroups.map((group) => [group.sourceNodeId, current[group.sourceNodeId] ?? false]),
      );
      return booleanRecordsEqual(current, next) ? current : next;
    });
  }, [queryActive, suggestionGroups]);

  const toggleGroup = useCallback((groupId: string, nextExpanded: boolean) => {
    setExpandedGroups((current) => ({
      ...current,
      [groupId]: nextExpanded,
    }));
  }, []);

  return { expandedGroups, setExpandedGroups, toggleGroup };
}
