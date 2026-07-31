// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import {
  navigationTargetFromEntry,
  navigationTargetsEqual,
} from "./navigation";
import type { NavigationEntry, NavigationTarget } from "./types";

export function useTokenizedNavigation({
  expandedFieldTree,
  expandedGroups,
  listboxId,
  navigationEntries,
  open,
  queryActive,
  setExpandedFieldTree,
  toggleGroup,
}: {
  expandedFieldTree: Record<string, boolean>;
  expandedGroups: Record<string, boolean>;
  listboxId: string;
  navigationEntries: NavigationEntry[];
  open: boolean;
  queryActive: boolean;
  setExpandedFieldTree: Dispatch<SetStateAction<Record<string, boolean>>>;
  toggleGroup: (groupId: string, nextExpanded: boolean) => void;
}) {
  const [activeTarget, setActiveTarget] = useState<NavigationTarget | null>(null);

  const findNavigationEntryIndex = useCallback(
    (target: NavigationTarget | null) => {
      if (!target) {
        return -1;
      }

      return navigationEntries.findIndex((entry) => {
        if (target.kind === "group") {
          return entry.kind === "group" && entry.groupId === target.groupId;
        }

        return entry.kind === "item" &&
          entry.groupId === target.groupId &&
          entry.path === target.path;
      });
    },
    [navigationEntries],
  );

  const findNavigationEntry = useCallback(
    (target: NavigationTarget | null) => {
      const index = findNavigationEntryIndex(target);
      return index === -1 ? null : navigationEntries[index] ?? null;
    },
    [findNavigationEntryIndex, navigationEntries],
  );

  const getDefaultNavigationTarget = useCallback(
    (direction: 1 | -1) => {
      if (navigationEntries.length === 0) {
        return null;
      }

      if (queryActive) {
        const firstItem = navigationEntries.find((entry) => entry.kind === "item");
        if (firstItem?.kind === "item") {
          return { kind: "item", groupId: firstItem.groupId, path: firstItem.path } satisfies NavigationTarget;
        }
      }

      const fallbackEntry =
        direction === 1
          ? navigationEntries[0]
          : navigationEntries[navigationEntries.length - 1];

      return navigationTargetFromEntry(fallbackEntry);
    },
    [navigationEntries, queryActive],
  );

  const moveActiveTarget = useCallback(
    (direction: 1 | -1) => {
      setActiveTarget((current) => {
        if (navigationEntries.length === 0) {
          return null;
        }

        const currentIndex = findNavigationEntryIndex(current);
        if (currentIndex === -1) {
          return getDefaultNavigationTarget(direction);
        }

        const nextIndex = currentIndex + direction;
        if (nextIndex < 0 || nextIndex >= navigationEntries.length) {
          return current;
        }

        const nextEntry = navigationEntries[nextIndex];
        return navigationTargetFromEntry(nextEntry);
      });
    },
    [findNavigationEntryIndex, getDefaultNavigationTarget, navigationEntries],
  );

  useEffect(() => {
    if (!open) {
      setActiveTarget(null);
      return;
    }

    setActiveTarget((current) => {
      const firstItem = queryActive
        ? navigationEntries.find((entry) => entry.kind === "item")
        : undefined;
      const defaultTarget = navigationTargetFromEntry(firstItem ?? navigationEntries[0]);

      if (!current) {
        return defaultTarget;
      }

      const stillExists = navigationEntries.some((entry) => {
        if (current.kind === "group") {
          return entry.kind === "group" && entry.groupId === current.groupId;
        }

        return entry.kind === "item" &&
          entry.groupId === current.groupId &&
          entry.path === current.path;
      });

      if (!stillExists || (queryActive && current.kind === "group")) {
        return navigationTargetsEqual(current, defaultTarget) ? current : defaultTarget;
      }

      return current;
    });
  }, [navigationEntries, open, queryActive]);

  useEffect(() => {
    if (!open || !activeTarget) {
      return;
    }

    const activeId =
      activeTarget.kind === "group"
        ? `${listboxId}-group-${activeTarget.groupId}`
        : `${listboxId}-option-${activeTarget.path}`;
    const activeElement = document.getElementById(activeId);
    if (typeof activeElement?.scrollIntoView === "function") {
      activeElement.scrollIntoView({ block: "nearest" });
    }
  }, [activeTarget, listboxId, open]);

  const expandActiveTargetRight = useCallback(() => {
    const target = activeTarget ?? getDefaultNavigationTarget(1);
    if (!target) {
      return;
    }
    setActiveTarget(target);

    if (target.kind === "group") {
      const isExpanded = queryActive || (expandedGroups[target.groupId] ?? false);
      if (!isExpanded) {
        toggleGroup(target.groupId, true);
        return;
      }

      const firstItem = navigationEntries.find(
        (entry) => entry.kind === "item" && entry.groupId === target.groupId,
      );
      setActiveTarget(navigationTargetFromEntry(firstItem));
      return;
    }

    const entry = findNavigationEntry(target);
    if (entry?.kind === "item" && !queryActive && entry.hasChildren && entry.treeKey) {
      const isExpanded = expandedFieldTree[entry.treeKey] ?? false;
      if (!isExpanded) {
        setExpandedFieldTree((current) => ({
          ...current,
          [entry.treeKey!]: true,
        }));
        return;
      }

      const nextEntry = navigationEntries[findNavigationEntryIndex(target) + 1];
      if (
        nextEntry?.kind === "item" &&
        nextEntry.groupId === entry.groupId &&
        nextEntry.depth > entry.depth
      ) {
        setActiveTarget(navigationTargetFromEntry(nextEntry));
      }
    }
  }, [
    activeTarget,
    expandedFieldTree,
    expandedGroups,
    findNavigationEntry,
    findNavigationEntryIndex,
    getDefaultNavigationTarget,
    navigationEntries,
    queryActive,
    setExpandedFieldTree,
    toggleGroup,
  ]);

  const collapseActiveTargetLeft = useCallback(() => {
    const target = activeTarget ?? getDefaultNavigationTarget(1);
    if (!target) {
      return;
    }
    setActiveTarget(target);

    if (target.kind === "item") {
      const entry = findNavigationEntry(target);
      if (entry?.kind === "item" && !queryActive && entry.hasChildren && entry.treeKey && (expandedFieldTree[entry.treeKey] ?? false)) {
        setExpandedFieldTree((current) => ({
          ...current,
          [entry.treeKey!]: false,
        }));
        return;
      }

      if (entry?.kind === "item" && !queryActive && entry.depth > 0) {
        const currentIndex = findNavigationEntryIndex(target);
        const parentEntry = navigationEntries
          .slice(0, currentIndex)
          .reverse()
          .find((candidate) =>
            candidate.kind === "item" &&
            candidate.groupId === entry.groupId &&
            candidate.depth < entry.depth,
          );
        if (parentEntry?.kind === "item") {
          setActiveTarget(navigationTargetFromEntry(parentEntry));
          return;
        }
      }

      if (!queryActive && (expandedGroups[target.groupId] ?? false)) {
        toggleGroup(target.groupId, false);
        setActiveTarget({ kind: "group", groupId: target.groupId });
        return;
      }

      setActiveTarget({ kind: "group", groupId: target.groupId });
      return;
    }

    if (target.kind === "group" && !queryActive && (expandedGroups[target.groupId] ?? false)) {
      toggleGroup(target.groupId, false);
    }
  }, [
    activeTarget,
    expandedFieldTree,
    expandedGroups,
    findNavigationEntry,
    findNavigationEntryIndex,
    getDefaultNavigationTarget,
    navigationEntries,
    queryActive,
    setExpandedFieldTree,
    toggleGroup,
  ]);

  const commitActiveTarget = useCallback(
    (applySuggestion: (suggestion: VariableSuggestion) => void) => {
      const target = activeTarget ?? getDefaultNavigationTarget(1);
      const entry = findNavigationEntry(target);
      if (!target || !entry) {
        return;
      }
      setActiveTarget(target);

      if (entry.kind === "item") {
        if (!queryActive && entry.hasChildren && entry.treeKey && entry.suggestion.insertText.length === 0) {
          setExpandedFieldTree((current) => ({
            ...current,
            [entry.treeKey!]: !(current[entry.treeKey!] ?? false),
          }));
          return;
        }

        if (entry.suggestion.insertText.length > 0) {
          applySuggestion(entry.suggestion);
        }
        return;
      }

      const isExpanded = queryActive || (expandedGroups[entry.groupId] ?? false);
      toggleGroup(entry.groupId, !isExpanded);
    },
    [
      activeTarget,
      expandedGroups,
      findNavigationEntry,
      getDefaultNavigationTarget,
      queryActive,
      setExpandedFieldTree,
      toggleGroup,
    ],
  );

  return {
    activeTarget,
    collapseActiveTargetLeft,
    commitActiveTarget,
    expandActiveTargetRight,
    moveActiveTarget,
    setActiveTarget,
  };
}
