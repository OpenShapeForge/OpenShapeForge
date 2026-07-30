// SPDX-License-Identifier: BUSL-1.1
"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import { flattenVisibleVariableTree } from "@/features/renderer/runtime/variable-suggestion-tree";
import { cn } from "@/lib/utils";
import { getSuggestionStoredValue } from "./helpers";
import type {
  OptionVariablePickerSelection,
  OptionVariablePickerValueMode,
} from "./types";
import type { OptionVariableSuggestionGroup } from "./use-option-variable-picker";

type VariableSectionProps = {
  groups: OptionVariableSuggestionGroup[];
  query: string;
  selectedSuggestion: VariableSuggestion | null;
  expandedGroups: Record<string, boolean>;
  setExpandedGroups: Dispatch<SetStateAction<Record<string, boolean>>>;
  expandedFieldTree: Record<string, boolean>;
  setExpandedFieldTree: Dispatch<SetStateAction<Record<string, boolean>>>;
  label: string;
  lang: "nl" | "en";
  valueMode: OptionVariablePickerValueMode;
  onChange: (nextValue: string, selection: OptionVariablePickerSelection) => void;
  onClose: () => void;
};

export function VariableSection({
  groups,
  query,
  selectedSuggestion,
  expandedGroups,
  setExpandedGroups,
  expandedFieldTree,
  setExpandedFieldTree,
  label,
  lang,
  valueMode,
  onChange,
  onClose,
}: VariableSectionProps) {
  if (groups.length === 0) {
    return null;
  }

  return (
    <section className="space-y-1">
      <div className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="space-y-1">
        {groups.map((group) => (
          <VariableGroup
            key={group.sourceNodeId}
            group={group}
            query={query}
            selectedSuggestion={selectedSuggestion}
            expandedGroups={expandedGroups}
            setExpandedGroups={setExpandedGroups}
            expandedFieldTree={expandedFieldTree}
            setExpandedFieldTree={setExpandedFieldTree}
            lang={lang}
            valueMode={valueMode}
            onChange={onChange}
            onClose={onClose}
          />
        ))}
      </div>
    </section>
  );
}

type VariableGroupProps = Omit<VariableSectionProps, "groups" | "label"> & {
  group: OptionVariableSuggestionGroup;
};

function VariableGroup({
  group,
  query,
  selectedSuggestion,
  expandedGroups,
  setExpandedGroups,
  expandedFieldTree,
  setExpandedFieldTree,
  lang,
  valueMode,
  onChange,
  onClose,
}: VariableGroupProps) {
  const isSearch = query.trim().length > 0;
  const isExpanded = isSearch || (expandedGroups[group.sourceNodeId] ?? false);

  return (
    <section className="space-y-1">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent/50"
        onClick={() =>
          setExpandedGroups((current) => ({
            ...current,
            [group.sourceNodeId]: !isExpanded,
          }))
        }
      >
        {isExpanded ? (
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
        <div className="space-y-0.5 pl-6">
          {isSearch
            ? group.suggestions.map((suggestion) => (
                <SearchSuggestionRow
                  key={suggestion.path}
                  suggestion={suggestion}
                  selectedSuggestion={selectedSuggestion}
                  valueMode={valueMode}
                  onChange={onChange}
                  onClose={onClose}
                />
              ))
            : flattenVisibleVariableTree({
                roots: group.fieldTree,
                groupId: group.sourceNodeId,
                expandedByKey: expandedFieldTree,
              }).map((row) => (
                <TreeSuggestionRow
                  key={row.suggestion.path}
                  row={row}
                  selectedSuggestion={selectedSuggestion}
                  expandedFieldTree={expandedFieldTree}
                  setExpandedFieldTree={setExpandedFieldTree}
                  lang={lang}
                  valueMode={valueMode}
                  onChange={onChange}
                  onClose={onClose}
                />
              ))}
        </div>
      ) : null}
    </section>
  );
}

type SuggestionRowProps = {
  suggestion: VariableSuggestion;
  selectedSuggestion: VariableSuggestion | null;
  valueMode: OptionVariablePickerValueMode;
  onChange: (nextValue: string, selection: OptionVariablePickerSelection) => void;
  onClose: () => void;
};

function SearchSuggestionRow({
  suggestion,
  selectedSuggestion,
  valueMode,
  onChange,
  onClose,
}: SuggestionRowProps) {
  const isSelected = selectedSuggestion?.path === suggestion.path;

  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent/50",
        isSelected ? "bg-accent font-medium ring-1 ring-border/80" : undefined,
      )}
      onClick={() => {
        onChange(getSuggestionStoredValue(suggestion, valueMode), {
          kind: "variable",
          suggestion,
        });
        onClose();
      }}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">
          {suggestion.label}
        </span>
        <span className="block text-xs text-muted-foreground">
          {getSuggestionStoredValue(suggestion, valueMode)}
        </span>
      </span>
    </button>
  );
}

type TreeSuggestionRow = ReturnType<typeof flattenVisibleVariableTree>[number];

type TreeSuggestionRowProps = {
  row: TreeSuggestionRow;
  selectedSuggestion: VariableSuggestion | null;
  expandedFieldTree: Record<string, boolean>;
  setExpandedFieldTree: Dispatch<SetStateAction<Record<string, boolean>>>;
  lang: "nl" | "en";
  valueMode: OptionVariablePickerValueMode;
  onChange: (nextValue: string, selection: OptionVariablePickerSelection) => void;
  onClose: () => void;
};

function TreeSuggestionRow({
  row,
  selectedSuggestion,
  expandedFieldTree,
  setExpandedFieldTree,
  lang,
  valueMode,
  onChange,
  onClose,
}: TreeSuggestionRowProps) {
  const suggestion = row.suggestion;
  const isSelected = selectedSuggestion?.path === suggestion.path;

  return (
    <div
      className={cn(
        "flex w-full items-start gap-0.5 rounded-md py-1.5 pr-2",
        isSelected ? "bg-accent font-medium ring-1 ring-border/80" : "hover:bg-accent/50",
      )}
      style={{
        paddingLeft: `${10 + row.depth * 14}px`,
      }}
    >
      {row.hasChildren ? (
        <button
          type="button"
          className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-accent/80"
          aria-expanded={expandedFieldTree[row.treeKey] ?? false}
          aria-label={
            expandedFieldTree[row.treeKey]
              ? lang === "nl"
                ? "Inklappen"
                : "Collapse"
              : lang === "nl"
                ? "Uitklappen"
                : "Expand"
          }
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setExpandedFieldTree((current) => ({
              ...current,
              [row.treeKey]: !current[row.treeKey],
            }));
          }}
        >
          {expandedFieldTree[row.treeKey] ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </button>
      ) : (
        <span
          className="mt-0.5 inline-flex w-5 shrink-0 justify-center"
          aria-hidden
        />
      )}
      <button
        type="button"
        className="min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-left text-sm"
        onClick={() => {
          onChange(getSuggestionStoredValue(suggestion, valueMode), {
            kind: "variable",
            suggestion,
          });
          onClose();
        }}
      >
        <span className="block truncate font-medium text-foreground">
          {suggestion.label}
        </span>
        <span className="block text-xs text-muted-foreground">
          {getSuggestionStoredValue(suggestion, valueMode)}
        </span>
      </button>
    </div>
  );
}
