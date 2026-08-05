// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { HeadingInput, Input } from "@/components/ui/forms/input";
import { InputMultiline } from "@openshapeforge/ui";
import { groupVariableSuggestionsBySourceNode } from "@/features/renderer/runtime/variable-suggestion-tree";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import { AutocompleteListbox } from "./autocomplete-listbox";
import {
  filterSuggestions,
  mergeSuggestions,
} from "./suggestions";
import type {
  NativeTextElement,
  TextInputControlProps,
  TriggerMatch,
} from "./types";
import { useRemoteChipSuggestions } from "./use-remote-chip-suggestions";

function findTriggerBeforeCursor(value: string, cursor: number): TriggerMatch | null {
  const beforeCursor = value.slice(0, cursor);
  const dollarStart = beforeCursor.lastIndexOf("$");
  const atStart = beforeCursor.lastIndexOf("@");
  const triggerStart = Math.max(dollarStart, atStart);
  if (triggerStart === -1) {
    return null;
  }

  const query = beforeCursor.slice(triggerStart + 1);
  if (/[\s\n\r{}]/.test(query)) {
    return null;
  }

  return {
    start: triggerStart,
    end: cursor,
    query,
    trigger: atStart > dollarStart ? "@" : "$",
  };
}

export function PlainTextInputControl({
  multiline = false,
  rows,
  value,
  suggestions = [],
  onValueChange,
  emptyMessage,
  variant,
  onKeyDown,
  onBlur,
  onFocus,
  onClick,
  suggestionHeaderLabel: _suggestionHeaderLabel,
  lang = "nl",
  ...props
}: TextInputControlProps) {
  const inputRef = useRef<NativeTextElement | null>(null);
  const listboxId = useId();
  const [isFocused, setIsFocused] = useState(false);
  const [triggerState, setTriggerState] = useState<TriggerMatch | null>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const remoteChipSuggestions = useRemoteChipSuggestions({
    query,
    suggestions,
    triggerState,
  });
  const mergedSuggestions = useMemo(
    () => mergeSuggestions(suggestions, remoteChipSuggestions),
    [remoteChipSuggestions, suggestions],
  );
  const filteredSuggestions = useMemo(
    () => filterSuggestions(mergedSuggestions, query),
    [mergedSuggestions, query],
  );
  const suggestionGroups = useMemo(
    () => groupVariableSuggestionsBySourceNode(filteredSuggestions),
    [filteredSuggestions],
  );
  const visibleSuggestions = filteredSuggestions;
  const hasActiveElement =
    typeof document !== "undefined" && inputRef.current === document.activeElement;
  const open =
    (isFocused || hasActiveElement) &&
    triggerState !== null &&
    suggestionGroups.length > 0;
  const queryActive = query.trim().length > 0;
  const activeSuggestion = visibleSuggestions[activeIndex] ?? null;

  const syncAutocompleteFromElement = useCallback((element: NativeTextElement | null) => {
    if (!element) {
      setTriggerState(null);
      setQuery("");
      return;
    }
    const cursor = element.selectionStart ?? element.value.length;
    const nextTriggerState = findTriggerBeforeCursor(element.value, cursor);
    setTriggerState(nextTriggerState);
    setQuery(nextTriggerState?.query ?? "");
  }, []);

  useEffect(() => {
    setActiveIndex((current) =>
      Math.min(current, Math.max(visibleSuggestions.length - 1, 0)),
    );
  }, [visibleSuggestions.length]);

  function applyNativeSuggestion(suggestion: VariableSuggestion) {
    const element = inputRef.current;
    if (!element || !triggerState) {
      return;
    }
    const cursor = element.selectionStart ?? triggerState.end;
    const nextValue = `${value.slice(0, triggerState.start)}${suggestion.insertText}${value.slice(cursor)}`;
    const nextCursor = triggerState.start + suggestion.insertText.length;
    onValueChange(nextValue);
    setTriggerState(null);
    setQuery("");
    window.requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(nextCursor, nextCursor);
    });
  }

  const commonProps = {
    ...props,
    ref: inputRef as never,
    value,
    onChange: (event: ChangeEvent<NativeTextElement>) => {
      onValueChange(event.currentTarget.value);
      syncAutocompleteFromElement(event.currentTarget);
    },
    onFocus: (event: FocusEvent<NativeTextElement>) => {
      const element = event.currentTarget;
      setIsFocused(true);
      window.requestAnimationFrame(() => syncAutocompleteFromElement(element));
      onFocus?.(event);
    },
    onClick: (event: MouseEvent<NativeTextElement>) => {
      syncAutocompleteFromElement(event.currentTarget);
      onClick?.(event);
    },
    onKeyUp: (event: KeyboardEvent<NativeTextElement>) => {
      syncAutocompleteFromElement(event.currentTarget);
    },
    onKeyDown: (event: KeyboardEvent<NativeTextElement>) => {
      if (open && event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) =>
          Math.min(current + 1, Math.max(visibleSuggestions.length - 1, 0)),
        );
        return;
      }
      if (open && event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (open && activeSuggestion && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        applyNativeSuggestion(activeSuggestion);
        return;
      }
      if (open && event.key === "Escape") {
        event.preventDefault();
        setTriggerState(null);
        setQuery("");
        return;
      }
      onKeyDown?.(event);
    },
    onBlur: (event: FocusEvent<NativeTextElement>) => {
      window.setTimeout(() => {
        setIsFocused(false);
        setTriggerState(null);
        setQuery("");
      }, 80);
      onBlur?.(event);
    },
  };

  let control: ReactNode;
  if (multiline) {
    control = (
      <InputMultiline
        {...commonProps}
        rows={rows}
      />
    );
  } else if (variant === "heading") {
    control = (
      <HeadingInput
        {...commonProps}
      />
    );
  } else {
    control = (
      <Input
        {...commonProps}
      />
    );
  }

  return (
    <div className="relative w-full">
      {control}
      {open ? (
        <AutocompleteListbox
          listboxId={listboxId}
          suggestionGroups={suggestionGroups}
          activeTarget={
            activeSuggestion
              ? {
                  kind: "item",
                  groupId: activeSuggestion.sourceNodeId,
                  path: activeSuggestion.path,
                }
              : null
          }
          emptyMessage={emptyMessage ?? "Geen variabelen gevonden."}
          lang={lang}
          queryActive={queryActive}
          expandedGroups={{}}
          expandedFieldTree={{}}
          onToggleGroup={() => undefined}
          onToggleFieldTreeNode={() => undefined}
          onSelectSuggestion={applyNativeSuggestion}
          onActivateSuggestion={(suggestion) =>
            setActiveIndex(
              visibleSuggestions.findIndex((entry) => entry.path === suggestion.path),
            )}
          alwaysExpanded
          showSourceLabel
        />
      ) : null}
    </div>
  );
}
