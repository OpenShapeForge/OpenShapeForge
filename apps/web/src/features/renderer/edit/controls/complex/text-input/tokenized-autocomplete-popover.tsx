// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { Dispatch, SetStateAction } from "react";
import { PopoverContent } from "@/components/ui/overlay/popover";
import type { WorkflowVariableSuggestionGroup } from "@/features/renderer/runtime/variable-suggestion-tree";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import { AutocompleteListbox } from "./autocomplete-listbox";
import type { NavigationTarget } from "./types";

export function TokenizedAutocompletePopover({
  activeTarget,
  applySuggestion,
  emptyMessage,
  expandedFieldTree,
  expandedGroups,
  groupedSuggestions,
  lang,
  listboxId,
  queryActive,
  setActiveTarget,
  setExpandedFieldTree,
  toggleGroup,
}: {
  activeTarget: NavigationTarget | null;
  applySuggestion: (suggestion: VariableSuggestion) => void;
  emptyMessage?: string;
  lang: "nl" | "en";
  expandedFieldTree: Record<string, boolean>;
  expandedGroups: Record<string, boolean>;
  groupedSuggestions: WorkflowVariableSuggestionGroup[];
  listboxId: string;
  queryActive: boolean;
  setActiveTarget: Dispatch<SetStateAction<NavigationTarget | null>>;
  setExpandedFieldTree: Dispatch<SetStateAction<Record<string, boolean>>>;
  toggleGroup: (groupId: string, nextExpanded: boolean) => void;
}) {
  return (
    <PopoverContent
      className="w-(--radix-popover-trigger-width) min-w-80 overflow-hidden rounded-lg p-0"
      align="start"
      sideOffset={6}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
      onInteractOutside={(event) => event.preventDefault()}
    >
      <AutocompleteListbox
        listboxId={listboxId}
        suggestionGroups={groupedSuggestions}
        activeTarget={activeTarget}
        emptyMessage={emptyMessage ?? "Geen variabelen gevonden."}
        lang={lang}
        queryActive={queryActive}
        expandedGroups={expandedGroups}
        expandedFieldTree={expandedFieldTree}
        onToggleGroup={toggleGroup}
        onToggleFieldTreeNode={(treeKey, nextExpanded) =>
          setExpandedFieldTree((current) => ({
            ...current,
            [treeKey]: nextExpanded,
          }))}
        onSelectSuggestion={applySuggestion}
        onActivateGroup={(groupId) => setActiveTarget({ kind: "group", groupId })}
        onActivateSuggestion={(suggestion) =>
          setActiveTarget({
            kind: "item",
            groupId: suggestion.sourceNodeId,
            path: suggestion.path,
          })}
        portaled
      />
    </PopoverContent>
  );
}
