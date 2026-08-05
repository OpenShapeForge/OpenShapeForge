// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { TooltipProvider } from "@openshapeforge/ui";
import { Popover, PopoverAnchor } from "@/components/ui/overlay/popover";
import { groupVariableSuggestionsBySourceNode } from "@/features/renderer/runtime/variable-suggestion-tree";
import { buildNavigationEntries } from "./navigation";
import {
  filterSuggestions,
  mergeSuggestions,
} from "./suggestions";
import { TokenizedAutocompletePopover } from "./tokenized-autocomplete-popover";
import { TokenizedSegmentList } from "./token-presentation";
import { parseSegments } from "./tokens";
import type { TextInputControlProps, TokenSegment, TriggerMatch } from "./types";
import {
  getMultilineMinHeightStyle,
  getTokenizedContainerClassName,
  getTokenizedPlaceholderClassName,
  isPlaceholderVisible,
} from "./tokenized-styles";
import { useExpandedSuggestionGroups } from "./use-expanded-suggestion-groups";
import { useRemoteChipSuggestions } from "./use-remote-chip-suggestions";
import { useTokenizedEditorActions } from "./use-tokenized-editor-actions";
import { useTokenizedNavigation } from "./use-tokenized-navigation";

export function TokenizedTextInputControl({
  id,
  name,
  value,
  suggestions = [],
  onValueChange,
  emptyMessage,
  lang = "nl",
  className,
  placeholder,
  disabled,
  readOnly,
  required,
  maxLength,
  autoFocus,
  multiline = false,
  rows,
  onKeyDown,
  onBlur,
  onFocus,
  onClick,
  variant = "default",
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: TextInputControlProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();
  const [isFocused, setIsFocused] = useState(false);
  const [query, setQuery] = useState("");
  const [triggerState, setTriggerState] = useState<TriggerMatch | null>(null);
  const [expandedFieldTree, setExpandedFieldTree] = useState<Record<string, boolean>>({});

  const remoteChipSuggestions = useRemoteChipSuggestions({
    query,
    suggestions,
    triggerState,
  });
  const mergedSuggestions = useMemo(
    () => mergeSuggestions(suggestions, remoteChipSuggestions),
    [remoteChipSuggestions, suggestions],
  );
  const segments = useMemo(
    () => parseSegments(value, mergedSuggestions),
    [mergedSuggestions, value],
  );
  const tokenSegments = useMemo(
    () =>
      segments.filter((segment): segment is Extract<TokenSegment, { kind: "token" }> => segment.kind === "token"),
    [segments],
  );
  const filteredSuggestions = useMemo(
    () => filterSuggestions(mergedSuggestions, query),
    [mergedSuggestions, query],
  );
  const groupedSuggestions = useMemo(
    () => groupVariableSuggestionsBySourceNode(filteredSuggestions),
    [filteredSuggestions],
  );
  const queryActive = query.trim().length > 0;
  const { expandedGroups, toggleGroup } = useExpandedSuggestionGroups(
    groupedSuggestions,
    queryActive,
  );
  const navigationEntries = useMemo(
    () => buildNavigationEntries({
      groupedSuggestions,
      expandedGroups,
      expandedFieldTree,
      queryActive,
    }),
    [expandedFieldTree, expandedGroups, groupedSuggestions, queryActive],
  );
  const open =
    !disabled &&
    !readOnly &&
    isFocused &&
    triggerState !== null &&
    groupedSuggestions.length > 0;
  const multilineMinHeightStyle = getMultilineMinHeightStyle({ multiline, rows });
  const placeholderVisible = isPlaceholderVisible(segments);

  const {
    activeTarget,
    collapseActiveTargetLeft,
    commitActiveTarget,
    expandActiveTargetRight,
    moveActiveTarget,
    setActiveTarget,
  } = useTokenizedNavigation({
    expandedFieldTree,
    expandedGroups,
    listboxId,
    navigationEntries,
    open,
    queryActive,
    setExpandedFieldTree,
    toggleGroup,
  });
  const {
    applySuggestion,
    commitValueFromEditor,
    deleteAroundSelection,
    removeRange,
    replaceSelection,
    syncAutocompleteFromEditor,
  } = useTokenizedEditorActions({
    isFocused,
    maxLength,
    onValueChange,
    rootRef,
    setActiveTarget,
    setQuery,
    setTriggerState,
    tokenSegments,
    triggerState,
    value,
  });

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || readOnly) {
      onKeyDown?.(event);
      return;
    }

    if (open && event.key === "ArrowDown") {
      event.preventDefault();
      moveActiveTarget(1);
      return;
    }

    if (open && event.key === "ArrowUp") {
      event.preventDefault();
      moveActiveTarget(-1);
      return;
    }

    if (open && event.key === "ArrowRight") {
      event.preventDefault();
      expandActiveTargetRight();
      return;
    }

    if (open && event.key === "ArrowLeft") {
      event.preventDefault();
      collapseActiveTargetLeft();
      return;
    }

    if (open && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault();
      commitActiveTarget(applySuggestion);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setTriggerState(null);
      setQuery("");
      return;
    }

    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) {
      onKeyDown?.(event);
      return;
    }

    if (event.key === "Backspace") {
      event.preventDefault();
      deleteAroundSelection("backward");
      return;
    }

    if (event.key === "Delete") {
      event.preventDefault();
      deleteAroundSelection("forward");
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (multiline) {
        replaceSelection("\n");
      }
      return;
    }

    if (event.key.length === 1) {
      event.preventDefault();
      replaceSelection(event.key);
      return;
    }

    onKeyDown?.(event);
  };

  const handleBeforeInput = (event: FormEvent<HTMLDivElement>) => {
    if (disabled || readOnly) {
      return;
    }

    const nativeEvent = event.nativeEvent as InputEvent;
    if (nativeEvent.isComposing) {
      return;
    }

    switch (nativeEvent.inputType) {
      case "insertText":
        if (nativeEvent.data) {
          event.preventDefault();
          replaceSelection(nativeEvent.data);
        }
        return;
      case "deleteContentBackward":
        event.preventDefault();
        deleteAroundSelection("backward");
        return;
      case "deleteContentForward":
        event.preventDefault();
        deleteAroundSelection("forward");
        return;
      case "insertParagraph":
      case "insertLineBreak":
        if (multiline) {
          event.preventDefault();
          replaceSelection("\n");
          return;
        }
        event.preventDefault();
        return;
      default:
        return;
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (disabled || readOnly) {
      return;
    }

    event.preventDefault();
    replaceSelection(event.clipboardData.getData("text/plain"));
  };

  return (
    <Popover open={open}>
    <PopoverAnchor asChild>
    <div className="relative">
      <div
        data-variant={variant}
        className={getTokenizedContainerClassName({
          ariaInvalid,
          className,
          disabled,
          multiline,
          readOnly,
          variant,
        })}
      >
        {placeholderVisible && placeholder ? (
          <span
            className={getTokenizedPlaceholderClassName({ multiline, variant })}
          >
            {placeholder}
          </span>
        ) : null}

        <TooltipProvider delayDuration={100}>
          <div
            ref={rootRef}
            id={id}
            role="textbox"
            aria-activedescendant={
              open && activeTarget
                ? activeTarget.kind === "group"
                  ? `${listboxId}-group-${activeTarget.groupId}`
                  : `${listboxId}-option-${activeTarget.path}`
                : undefined
            }
            aria-autocomplete="list"
            aria-controls={open ? listboxId : undefined}
            aria-describedby={ariaDescribedBy}
            aria-invalid={ariaInvalid}
            aria-label={ariaLabelledBy ? undefined : ariaLabel ?? name}
            aria-labelledby={ariaLabelledBy}
            aria-disabled={disabled || undefined}
            aria-readonly={readOnly || undefined}
            aria-required={required || undefined}
            className="min-h-[1.5rem] whitespace-pre-wrap break-words outline-none"
            contentEditable={!disabled && !readOnly}
            suppressContentEditableWarning
            spellCheck={false}
            tabIndex={disabled ? -1 : 0}
            onBlur={(event) => {
              setIsFocused(false);
              window.setTimeout(() => {
                if (!rootRef.current?.contains(document.activeElement)) {
                  setTriggerState(null);
                  setQuery("");
                }
              }, 80);
              onBlur?.(event);
            }}
            onFocus={(event) => {
              setIsFocused(true);
              window.requestAnimationFrame(() => syncAutocompleteFromEditor());
              onFocus?.(event);
            }}
            onBeforeInput={handleBeforeInput}
            onInput={commitValueFromEditor}
            onKeyDown={handleKeyDown}
            onKeyUp={() => syncAutocompleteFromEditor()}
            onMouseUp={() => syncAutocompleteFromEditor()}
            onPaste={handlePaste}
            onClick={(event) => {
              syncAutocompleteFromEditor();
              onClick?.(event);
            }}
            onPointerUp={() => syncAutocompleteFromEditor()}
            autoFocus={autoFocus}
            style={multilineMinHeightStyle}
          >
            <TokenizedSegmentList
              disabled={disabled}
              readOnly={readOnly}
              rootRef={rootRef}
              segments={segments}
              onRemoveRange={removeRange}
            />
          </div>
        </TooltipProvider>
      </div>

    </div>
    </PopoverAnchor>
      <TokenizedAutocompletePopover
        activeTarget={activeTarget}
        applySuggestion={applySuggestion}
        emptyMessage={emptyMessage}
        lang={lang}
        expandedFieldTree={expandedFieldTree}
        expandedGroups={expandedGroups}
        groupedSuggestions={groupedSuggestions}
        listboxId={listboxId}
        queryActive={queryActive}
        setActiveTarget={setActiveTarget}
        setExpandedFieldTree={setExpandedFieldTree}
        toggleGroup={toggleGroup}
      />
    </Popover>
  );
}
