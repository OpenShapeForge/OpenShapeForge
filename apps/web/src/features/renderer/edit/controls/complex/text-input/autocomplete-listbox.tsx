// SPDX-License-Identifier: BUSL-1.1
"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useRef, type MouseEvent, type PointerEvent } from "react";
import {
  flattenVisibleVariableTree,
  type WorkflowVariableSuggestionGroup,
} from "@/features/renderer/runtime/variable-suggestion-tree";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import { cn } from "@/lib/utils";
import type { NavigationTarget } from "./types";

export function AutocompleteListbox({
  listboxId,
  suggestionGroups,
  activeTarget,
  emptyMessage,
  queryActive,
  expandedGroups,
  expandedFieldTree,
  onToggleGroup,
  onToggleFieldTreeNode,
  onPointerInteract,
  onSelectSuggestion,
  onActivateGroup,
  onActivateSuggestion,
  headerLabel,
  lang,
  alwaysExpanded = false,
  showSourceLabel = false,
  portaled = false,
}: {
  listboxId: string;
  suggestionGroups: WorkflowVariableSuggestionGroup[];
  activeTarget?: NavigationTarget | null;
  emptyMessage: string;
  queryActive: boolean;
  expandedGroups: Record<string, boolean>;
  expandedFieldTree: Record<string, boolean>;
  onToggleGroup: (groupId: string, nextExpanded: boolean) => void;
  onToggleFieldTreeNode: (treeKey: string, nextExpanded: boolean) => void;
  onPointerInteract?: () => void;
  onSelectSuggestion: (suggestion: VariableSuggestion) => void;
  onActivateGroup?: (groupId: string) => void;
  onActivateSuggestion?: (suggestion: VariableSuggestion) => void;
  headerLabel?: string;
  lang: "nl" | "en";
  alwaysExpanded?: boolean;
  portaled?: boolean;
  showSourceLabel?: boolean;
}) {
  const pointerSelectionRef = useRef<string | null>(null);

  function selectSuggestionFromPointer(
    suggestion: VariableSuggestion,
    event: PointerEvent<HTMLElement> | MouseEvent<HTMLElement>,
  ) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest("[data-variable-tree-toggle='true']")) {
      return;
    }
    event.preventDefault();
    if (pointerSelectionRef.current === suggestion.path) {
      return;
    }
    pointerSelectionRef.current = suggestion.path;
    onSelectSuggestion(suggestion);
    window.setTimeout(() => {
      if (pointerSelectionRef.current === suggestion.path) {
        pointerSelectionRef.current = null;
      }
    }, 0);
  }

  function renderSuggestionRow(
    suggestion: VariableSuggestion,
    options: {
      depth: number;
      treeBranch?: {
        treeKey: string;
        hasChildren: boolean;
        isExpanded: boolean;
      };
    },
  ) {
    const isItemActive =
      activeTarget?.kind === "item" && activeTarget.path === suggestion.path;
    const branch = options.treeBranch;
    const selectSuggestion = (event: PointerEvent<HTMLElement> | MouseEvent<HTMLElement>) => {
      onPointerInteract?.();
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("[data-variable-tree-toggle='true']")) {
        return;
      }
      if (branch?.hasChildren && suggestion.insertText.length === 0) {
        event.preventDefault();
        event.stopPropagation();
        onToggleFieldTreeNode(branch.treeKey, !branch.isExpanded);
        return;
      }
      selectSuggestionFromPointer(suggestion, event);
    };

    return (
      <div
        key={suggestion.path}
        className={cn(
          "flex w-full items-start gap-0.5 rounded-md py-1.5 pr-2",
          isItemActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
        )}
        style={{
          paddingLeft: `${10 + options.depth * 14}px`,
        }}
        onPointerDownCapture={selectSuggestion}
        onMouseDownCapture={selectSuggestion}
      >
        {branch?.hasChildren ? (
          <button
            type="button"
            data-variable-tree-toggle="true"
            className={cn(
              "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-sm",
              isItemActive ? "hover:bg-black/5" : "hover:bg-accent/80",
            )}
            aria-expanded={branch.isExpanded}
            aria-label={
              branch.isExpanded
                ? lang === "nl"
                  ? "Inklappen"
                  : "Collapse"
                : lang === "nl"
                  ? "Uitklappen"
                  : "Expand"
            }
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleFieldTreeNode(branch.treeKey, !branch.isExpanded);
            }}
            onMouseDown={(event) => event.preventDefault()}
          >
            {branch.isExpanded ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </button>
        ) : (
          <span className="mt-0.5 inline-flex w-5 shrink-0 justify-center" aria-hidden />
        )}
        <button
          id={`${listboxId}-option-${suggestion.path}`}
          type="button"
          role="option"
          aria-selected={isItemActive}
          className={cn(
            "min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-left",
            isItemActive ? undefined : "hover:bg-transparent",
          )}
          style={
            isItemActive && suggestion.sourceNodeTone
              ? {
                  backgroundColor: suggestion.sourceNodeTone.background,
                  color: suggestion.sourceNodeTone.text,
                }
              : undefined
          }
          onPointerDownCapture={selectSuggestion}
          onPointerDown={selectSuggestion}
          onMouseDown={selectSuggestion}
          onClick={selectSuggestion}
          onMouseEnter={() => onActivateSuggestion?.(suggestion)}
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{suggestion.label}</span>
            {showSourceLabel ? (
              <span className="block truncate text-xs text-muted-foreground">
                {queryActive ? suggestion.sourceNodeLabel : suggestion.displayPath}
              </span>
            ) : null}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      className={portaled ? "overflow-hidden" : "absolute top-[calc(100%+0.375rem)] z-50 w-full min-w-64 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"}
      onPointerDownCapture={() => onPointerInteract?.()}
      onMouseDownCapture={() => onPointerInteract?.()}
    >
      <div className="border-b border-border/70 px-3 py-2 text-xs text-muted-foreground">
        {headerLabel ?? "Upstream outputs"}
      </div>
      <div
        id={listboxId}
        role="listbox"
        className="max-h-96 overflow-y-auto p-1"
      >
        {suggestionGroups.length > 0 ? (
          suggestionGroups.map((group) => {
            const isExpanded = alwaysExpanded || queryActive || (expandedGroups[group.sourceNodeId] ?? false);
            const isGroupActive =
              activeTarget?.kind === "group" && activeTarget.groupId === group.sourceNodeId;
            const groupTone = group.suggestions[0]?.sourceNodeTone;

            return (
              <section key={group.sourceNodeId} className="py-1">
                <button
                  id={`${listboxId}-group-${group.sourceNodeId}`}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent/50",
                    isGroupActive ? "bg-accent text-accent-foreground" : undefined,
                    alwaysExpanded ? "cursor-default" : undefined,
                  )}
                  style={
                    isGroupActive && groupTone
                      ? {
                          backgroundColor: groupTone.background,
                          color: groupTone.text,
                        }
                      : undefined
                  }
                  onPointerDown={(event) => {
                    event.preventDefault();
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => onActivateGroup?.(group.sourceNodeId)}
                  onClick={() => {
                    onActivateGroup?.(group.sourceNodeId);
                    if (!alwaysExpanded) {
                      onToggleGroup(group.sourceNodeId, !isExpanded);
                    }
                  }}
                >
                  {alwaysExpanded ? null : isExpanded ? (
                    <ChevronDown className="size-4" />
                  ) : (
                    <ChevronRight className="size-4" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {group.sourceNodeLabel}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {group.suggestions.length}
                  </span>
                </button>

                {isExpanded ? (
                  <div className="mt-1 space-y-0.5">
                    {queryActive || alwaysExpanded
                      ? group.suggestions.map((suggestion) =>
                          renderSuggestionRow(suggestion, { depth: 0 }),
                        )
                      : flattenVisibleVariableTree({
                          roots: group.fieldTree,
                          groupId: group.sourceNodeId,
                          expandedByKey: expandedFieldTree,
                        }).map((row) =>
                          renderSuggestionRow(row.suggestion, {
                            depth: row.depth,
                            treeBranch: row.hasChildren
                              ? {
                                  treeKey: row.treeKey,
                                  hasChildren: true,
                                  isExpanded: expandedFieldTree[row.treeKey] ?? false,
                                }
                              : undefined,
                          }),
                        )}
                  </div>
                ) : null}
              </section>
            );
          })
        ) : (
          <div className="px-3 py-2 text-sm text-muted-foreground">
            {emptyMessage}
          </div>
        )}
      </div>
    </div>
  );
}
