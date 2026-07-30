// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import {
  getSelectionOffsets,
  serializeEditor,
  setSelectionOffsets,
} from "./editor-selection";
import type {
  NavigationTarget,
  SelectionOffsets,
  TokenSegment,
  TriggerMatch,
} from "./types";

function enforceMaxLength(nextValue: string, maxLength?: number) {
  if (typeof maxLength === "number" && nextValue.length > maxLength) {
    return null;
  }

  return nextValue;
}

export function useTokenizedEditorActions({
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
}: {
  isFocused: boolean;
  maxLength?: number;
  onValueChange: (value: string) => void;
  rootRef: RefObject<HTMLDivElement | null>;
  setActiveTarget: Dispatch<SetStateAction<NavigationTarget | null>>;
  setQuery: Dispatch<SetStateAction<string>>;
  setTriggerState: Dispatch<SetStateAction<TriggerMatch | null>>;
  tokenSegments: Extract<TokenSegment, { kind: "token" }>[];
  triggerState: TriggerMatch | null;
  value: string;
}) {
  const pendingSelectionRef = useRef<SelectionOffsets | null>(null);

  const syncAutocompleteFromEditor = useCallback(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }

    const offsets = getSelectionOffsets(root);
    if (!offsets) {
      setTriggerState((current) => current === null ? current : null);
      setQuery((current) => current.length === 0 ? current : "");
      return;
    }

    const serialized = serializeEditor(root);
    const beforeCursor = serialized.slice(0, offsets.start);
    const dollarStart = beforeCursor.lastIndexOf("$");
    const atStart = beforeCursor.lastIndexOf("@");
    const trigger = atStart > dollarStart ? "@" : "$";
    const triggerStart = Math.max(dollarStart, atStart);
    if (triggerStart === -1) {
      setTriggerState((current) => current === null ? current : null);
      setQuery((current) => current.length === 0 ? current : "");
      return;
    }

    const nextQuery = beforeCursor.slice(triggerStart + 1);
    if (/[\s\n\r{}]/.test(nextQuery)) {
      setTriggerState((current) => current === null ? current : null);
      setQuery((current) => current.length === 0 ? current : "");
      return;
    }

    const nextTriggerState = {
      start: triggerStart,
      end: offsets.start,
      query: nextQuery,
      trigger,
    } satisfies TriggerMatch;
    setTriggerState((current) =>
      current &&
      current.start === nextTriggerState.start &&
      current.end === nextTriggerState.end &&
      current.query === nextTriggerState.query &&
      current.trigger === nextTriggerState.trigger
        ? current
        : nextTriggerState,
    );
    setQuery((current) => current === nextQuery ? current : nextQuery);
  }, [rootRef, setQuery, setTriggerState]);

  const updateValueAndSelection = useCallback(
    (nextValue: string, nextSelection: SelectionOffsets) => {
      const allowedValue = enforceMaxLength(nextValue, maxLength);
      if (allowedValue === null) {
        return;
      }

      pendingSelectionRef.current = nextSelection;
      onValueChange(allowedValue);
      window.requestAnimationFrame(() => {
        rootRef.current?.focus();
        syncAutocompleteFromEditor();
      });
    },
    [maxLength, onValueChange, rootRef, syncAutocompleteFromEditor],
  );

  const removeRange = useCallback(
    (start: number, end: number) => {
      const nextValue = `${value.slice(0, start)}${value.slice(end)}`;
      setTriggerState(null);
      setQuery("");
      setActiveTarget(null);
      updateValueAndSelection(nextValue, { start, end: start });
    },
    [setActiveTarget, setQuery, setTriggerState, updateValueAndSelection, value],
  );

  const replaceSelection = useCallback(
    (insertedText: string) => {
      const root = rootRef.current;
      if (!root) {
        return;
      }

      const selection = getSelectionOffsets(root) ?? { start: value.length, end: value.length };
      const nextValue = `${value.slice(0, selection.start)}${insertedText}${value.slice(selection.end)}`;
      const nextCursor = selection.start + insertedText.length;
      updateValueAndSelection(nextValue, { start: nextCursor, end: nextCursor });
    },
    [rootRef, updateValueAndSelection, value],
  );

  const deleteAroundSelection = useCallback(
    (direction: "backward" | "forward") => {
      const root = rootRef.current;
      if (!root) {
        return;
      }

      const selection = getSelectionOffsets(root) ?? { start: value.length, end: value.length };
      let start = selection.start;
      let end = selection.end;

      if (start !== end) {
        for (const token of tokenSegments) {
          if (token.start < end && token.end > start) {
            start = Math.min(start, token.start);
            end = Math.max(end, token.end);
          }
        }
      } else {
        const adjacentToken = tokenSegments.find((token) =>
          direction === "backward"
            ? token.end === start || (token.start < start && token.end >= start)
            : token.start === end || (token.start <= end && token.end > end),
        );

        if (adjacentToken) {
          start = adjacentToken.start;
          end = adjacentToken.end;
        }
      }

      if (start === end) {
        if (direction === "backward") {
          if (start === 0) {
            return;
          }

          start -= 1;
        } else {
          if (end >= value.length) {
            return;
          }

          end += 1;
        }
      }

      removeRange(start, end);
    },
    [removeRange, rootRef, tokenSegments, value.length],
  );

  const applySuggestion = useCallback(
    (suggestion: VariableSuggestion) => {
      const root = rootRef.current;
      if (!root || !triggerState) {
        return;
      }

      const serialized = serializeEditor(root);
      const nextValue = `${serialized.slice(0, triggerState.start)}${suggestion.insertText}${serialized.slice(triggerState.end)}`;
      const nextCursor = triggerState.start + suggestion.insertText.length;
      const allowedValue = enforceMaxLength(nextValue, maxLength);
      if (allowedValue === null) {
        return;
      }

      pendingSelectionRef.current = { start: nextCursor, end: nextCursor };
      onValueChange(allowedValue);
      setTriggerState(null);
      setQuery("");
      setActiveTarget(null);
      window.requestAnimationFrame(() => {
        root.focus();
      });
    },
    [maxLength, onValueChange, rootRef, setActiveTarget, setQuery, setTriggerState, triggerState],
  );

  const commitValueFromEditor = useCallback(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }

    const nextValue = serializeEditor(root);
    const allowedValue = enforceMaxLength(nextValue, maxLength);
    if (allowedValue === null) {
      pendingSelectionRef.current = getSelectionOffsets(root);
      onValueChange(value);
      return;
    }

    pendingSelectionRef.current = getSelectionOffsets(root);
    onValueChange(allowedValue);
    window.requestAnimationFrame(() => syncAutocompleteFromEditor());
  }, [maxLength, onValueChange, rootRef, syncAutocompleteFromEditor, value]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !pendingSelectionRef.current) {
      return;
    }

    setSelectionOffsets(root, pendingSelectionRef.current);
    pendingSelectionRef.current = null;
  }, [rootRef, value]);

  useEffect(() => {
    if (!isFocused) {
      return;
    }

    const sync = () => window.requestAnimationFrame(() => syncAutocompleteFromEditor());
    document.addEventListener("selectionchange", sync);
    return () => document.removeEventListener("selectionchange", sync);
  }, [isFocused, syncAutocompleteFromEditor]);

  return {
    applySuggestion,
    commitValueFromEditor,
    deleteAroundSelection,
    removeRange,
    replaceSelection,
    syncAutocompleteFromEditor,
  };
}
