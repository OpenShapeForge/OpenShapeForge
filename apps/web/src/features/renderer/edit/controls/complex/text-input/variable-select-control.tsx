// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Input } from "@/components/ui/forms/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/overlay/popover";
import {
  flattenVisibleVariableTree,
  groupVariableSuggestionsBySourceNode,
} from "@/features/renderer/runtime/variable-suggestion-tree";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import { AutocompleteListbox } from "./autocomplete-listbox";
import {
  filterSuggestions,
  findSuggestion,
  formatSuggestionValue,
} from "./suggestions";
import type { TextInputControlProps } from "./types";
import { useExpandedSuggestionGroups } from "./use-expanded-suggestion-groups";

export function VariableSelectTextInputControl({
  value,
  suggestions,
  onValueChange,
  emptyMessage,
  suggestionHeaderLabel,
  lang = "nl",
  className,
  onKeyDown,
  onBlur,
  onFocus,
  onClick,
  placeholder,
  id,
  disabled,
  readOnly,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: TextInputControlProps) {
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [expandedFieldTree, setExpandedFieldTree] = useState<Record<string, boolean>>({});
  const listboxInteractionRef = useRef(false);
  const suppressOpenOnFocusRef = useRef(false);
  const blurResetTimerRef = useRef<number | null>(null);

  const selectedSuggestion = useMemo(
    () => findSuggestion(suggestions ?? [], value),
    [suggestions, value],
  );
  const filteredSuggestions = useMemo(
    () => filterSuggestions(suggestions ?? [], query),
    [suggestions, query],
  );
  const suggestionGroups = useMemo(
    () => groupVariableSuggestionsBySourceNode(filteredSuggestions),
    [filteredSuggestions],
  );
  const queryActive = query.trim().length > 0;
  const { expandedGroups, toggleGroup } = useExpandedSuggestionGroups(
    suggestionGroups,
    queryActive,
  );
  const visibleSuggestions = useMemo(
    () =>
      suggestionGroups.flatMap((group) => {
        if (!queryActive && !(expandedGroups[group.sourceNodeId] ?? false)) {
          return [];
        }
        if (queryActive) {
          return group.suggestions;
        }
        return flattenVisibleVariableTree({
          roots: group.fieldTree,
          groupId: group.sourceNodeId,
          expandedByKey: expandedFieldTree,
        }).map((row) => row.suggestion);
      }),
    [expandedFieldTree, expandedGroups, queryActive, suggestionGroups],
  );

  useEffect(() => {
    if (!open) {
      setActiveIndex(0);
      return;
    }

    setActiveIndex((current) =>
      Math.min(current, Math.max(visibleSuggestions.length - 1, 0)),
    );
  }, [open, visibleSuggestions.length]);

  useEffect(() => () => {
    if (blurResetTimerRef.current !== null) {
      window.clearTimeout(blurResetTimerRef.current);
    }
  }, []);

  function commitSuggestion(suggestion: VariableSuggestion) {
    if (blurResetTimerRef.current !== null) {
      window.clearTimeout(blurResetTimerRef.current);
      blurResetTimerRef.current = null;
    }
    listboxInteractionRef.current = false;
    onValueChange(suggestion.path);
    setQuery("");
    setOpen(false);

    window.requestAnimationFrame(() => {
      suppressOpenOnFocusRef.current = true;
      inputRef.current?.focus();
      inputRef.current?.select();
      window.setTimeout(() => {
        suppressOpenOnFocusRef.current = false;
      }, 0);
    });
  }

  function resetDraft() {
    if (blurResetTimerRef.current !== null) {
      window.clearTimeout(blurResetTimerRef.current);
      blurResetTimerRef.current = null;
    }
    listboxInteractionRef.current = false;
    setQuery("");
    setOpen(false);
  }

  function markListboxInteraction() {
    listboxInteractionRef.current = true;
    if (blurResetTimerRef.current !== null) {
      window.clearTimeout(blurResetTimerRef.current);
      blurResetTimerRef.current = null;
    }
    window.setTimeout(() => {
      listboxInteractionRef.current = false;
    }, 120);
  }

  const inputValue = open
    ? query
    : selectedSuggestion
      ? formatSuggestionValue(selectedSuggestion)
      : value;

  return (
    <Popover open={open}>
    <PopoverAnchor asChild>
    <div className="relative">
      <Input
        ref={inputRef}
        id={id}
        className={className}
        value={inputValue}
        autoComplete="off"
        aria-autocomplete="list"
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        aria-activedescendant={
          open && visibleSuggestions.length > 0 && visibleSuggestions[activeIndex]
            ? `${listboxId}-option-${visibleSuggestions[activeIndex].path}`
            : undefined
        }
        disabled={disabled}
        readOnly={readOnly}
        placeholder={placeholder}
        onFocus={(event) => {
          if (suppressOpenOnFocusRef.current) {
            onFocus?.(event);
            return;
          }
          setOpen(true);
          setQuery("");
          onFocus?.(event);
        }}
        onClick={(event) => {
          if (!open) {
            setOpen(true);
            setQuery("");
          }
          onClick?.(event);
        }}
        onChange={(event) => {
          if (!open) {
            setOpen(true);
          }
          setQuery(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (!open && event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setQuery("");
            return;
          }

          if (open && visibleSuggestions.length > 0 && event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((current) =>
              Math.min(current + 1, visibleSuggestions.length - 1),
            );
            return;
          }

          if (open && visibleSuggestions.length > 0 && event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((current) => Math.max(current - 1, 0));
            return;
          }

          if (
            open &&
            visibleSuggestions.length > 0 &&
            (event.key === "Enter" || event.key === "Tab")
          ) {
            const activeSuggestion = visibleSuggestions[activeIndex];
            if (activeSuggestion) {
              event.preventDefault();
              commitSuggestion(activeSuggestion);
              return;
            }
          }

          if (event.key === "Escape") {
            event.preventDefault();
            resetDraft();
            return;
          }

          onKeyDown?.(event);
        }}
        onBlur={(event) => {
          const nextFocusTarget = event.relatedTarget;
          const listbox = document.getElementById(listboxId);
          if (nextFocusTarget instanceof Node && listbox?.contains(nextFocusTarget)) {
            onBlur?.(event);
            return;
          }
          if (listboxInteractionRef.current) {
            onBlur?.(event);
            return;
          }
          blurResetTimerRef.current = window.setTimeout(() => {
            if (!listboxInteractionRef.current) {
              resetDraft();
            }
          }, 120);
          onBlur?.(event);
        }}
      />
    </div>
    </PopoverAnchor>
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
          suggestionGroups={suggestionGroups}
          activeTarget={
            visibleSuggestions[activeIndex]
              ? {
                  kind: "item",
                  groupId: visibleSuggestions[activeIndex].sourceNodeId,
                  path: visibleSuggestions[activeIndex].path,
                }
              : null
          }
          emptyMessage={emptyMessage ?? "Geen variabelen gevonden."}
          headerLabel={suggestionHeaderLabel}
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
          onPointerInteract={markListboxInteraction}
          onSelectSuggestion={commitSuggestion}
          onActivateSuggestion={(suggestion) =>
            setActiveIndex(
              visibleSuggestions.findIndex((entry) => entry.path === suggestion.path),
            )}
          showSourceLabel
          portaled
        />
      </PopoverContent>
    </Popover>
  );
}
