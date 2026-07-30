// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRemoteOptionSourceData } from "@/features/renderer/hooks/use-remote-options";
import { groupVariableSuggestionsBySourceNode } from "@/features/renderer/runtime/variable-suggestion-tree";
import {
  findSuggestionForStoredValue,
  getSelectedSuggestionLabel,
  getSuggestionStoredValue,
  normalizeInterpolation,
  normalizeRemoteOptions,
  optionMatchesQuery,
  readStringRenderProp,
  resolveHiddenOptionCopy,
  resolveOptionLabel,
  suggestionMatchesQuery,
} from "./helpers";
import type {
  OptionVariablePickerFieldProps,
  OptionVariablePickerSelection,
} from "./types";

export type OptionVariableSuggestionGroup = ReturnType<
  typeof groupVariableSuggestionsBySourceNode
>[number];

export function useOptionVariablePicker({
  value,
  field,
  options: providedOptions,
  suggestions = [],
  lang = "nl",
  placeholder,
  searchPlaceholder,
  emptyMessage,
  optionSectionLabel,
  variableSectionLabel,
  hideVariables = false,
  valueMode = "insertText",
  onChange,
}: Pick<
  OptionVariablePickerFieldProps,
  | "value"
  | "field"
  | "options"
  | "suggestions"
  | "lang"
  | "placeholder"
  | "searchPlaceholder"
  | "emptyMessage"
  | "optionSectionLabel"
  | "variableSectionLabel"
  | "hideVariables"
  | "valueMode"
  | "onChange"
>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [expandedFieldTree, setExpandedFieldTree] = useState<Record<string, boolean>>({});
  const [wasAutoSelected, setWasAutoSelected] = useState(false);
  const autoSelectAttemptedRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const remoteSearchParam = readStringRenderProp(field, "remoteSearchParam");
  const { data: remoteData, loading } = useRemoteOptionSourceData<unknown>(field, {
    params: remoteSearchParam
      ? {
          [remoteSearchParam]: query,
        }
      : undefined,
  });

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const stringValue = typeof value === "string" ? value : "";
  const normalizedValue = normalizeInterpolation(stringValue);

  const handleUserChange = useCallback(
    (nextValue: string, selection: OptionVariablePickerSelection) => {
      setWasAutoSelected(false);
      autoSelectAttemptedRef.current = true;
      onChange(nextValue, selection);
    },
    [onChange],
  );

  const fieldSemanticType = field?.semanticType;
  useEffect(() => {
    if (autoSelectAttemptedRef.current) return;
    if (!fieldSemanticType) return;
    if (stringValue.trim().length > 0) return;

    const matches = suggestions.filter(
      (suggestion) => suggestion.semanticType === fieldSemanticType,
    );
    if (matches.length !== 1) return;

    const match = matches[0];
    autoSelectAttemptedRef.current = true;
    setWasAutoSelected(true);
    onChange(getSuggestionStoredValue(match, valueMode), {
      kind: "variable",
      suggestion: match,
    });
  }, [fieldSemanticType, suggestions, stringValue, valueMode, onChange]);

  const options = providedOptions ?? normalizeRemoteOptions(remoteData);
  const selectedRemoteOption = useMemo(
    () => options.find((option) => option.value === normalizedValue) ?? null,
    [normalizedValue, options],
  );
  const selectedSuggestion = useMemo(
    () => findSuggestionForStoredValue(suggestions, stringValue),
    [stringValue, suggestions],
  );

  const filteredRemoteOptions = useMemo(
    () => options.filter((option) => optionMatchesQuery(option, query, lang)),
    [lang, options, query],
  );
  const filteredSuggestions = useMemo(
    () =>
      hideVariables
        ? []
        : suggestions.filter((suggestion) => suggestionMatchesQuery(suggestion, query)),
    [hideVariables, query, suggestions],
  );
  const suggestionGroups = useMemo(
    () => groupVariableSuggestionsBySourceNode(filteredSuggestions),
    [filteredSuggestions],
  );

  const buttonLabel = selectedSuggestion
    ? getSelectedSuggestionLabel(selectedSuggestion)
    : selectedRemoteOption
      ? resolveOptionLabel(selectedRemoteOption.label, lang, selectedRemoteOption.value)
      : stringValue;
  const hiddenOptionCopy = resolveHiddenOptionCopy(optionSectionLabel, lang);
  const resolvedPlaceholder =
    placeholder ??
    (hideVariables
      ? hiddenOptionCopy.placeholder
      : lang === "nl"
        ? "Kies een optie of variabele"
        : "Choose an option or variable");
  const resolvedSearchPlaceholder =
    searchPlaceholder ??
    (hideVariables
      ? hiddenOptionCopy.searchPlaceholder
      : lang === "nl"
        ? "Zoek optie of variabele"
        : "Search option or variable");
  const resolvedEmptyMessage =
    emptyMessage ??
    (hideVariables
      ? hiddenOptionCopy.emptyMessage
      : lang === "nl"
        ? "Geen opties of variabelen gevonden."
        : "No options or variables found.");
  const resolvedOptionSectionLabel =
    optionSectionLabel ??
    (lang === "nl" ? "Beschikbare opties" : "Available options");
  const resolvedVariableSectionLabel =
    variableSectionLabel ??
    (lang === "nl" ? "Dynamische variabelen" : "Dynamic variables");

  return {
    open,
    setOpen,
    query,
    setQuery,
    expandedGroups,
    setExpandedGroups,
    expandedFieldTree,
    setExpandedFieldTree,
    wasAutoSelected,
    searchInputRef,
    loading,
    stringValue,
    normalizedValue,
    selectedSuggestion,
    filteredRemoteOptions,
    suggestionGroups,
    buttonLabel,
    resolvedPlaceholder,
    resolvedSearchPlaceholder,
    resolvedEmptyMessage,
    resolvedOptionSectionLabel,
    resolvedVariableSectionLabel,
    handleUserChange,
  };
}
