// SPDX-License-Identifier: BUSL-1.1
import type { Field, LocalizedText } from "@/generated/compiler/field-contract";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";

export type OptionVariablePickerOption = {
  value: string;
  label?: string | LocalizedText;
  description?: string;
  [key: string]: unknown;
};

export type OptionVariablePickerSelection =
  | {
      kind: "option";
      option: OptionVariablePickerOption;
    }
  | {
      kind: "variable";
      suggestion: VariableSuggestion;
    }
  | null;

export type OptionVariablePickerValueMode = "path" | "insertText";

export type OptionVariablePickerFieldProps = {
  id?: string;
  value: unknown;
  label: string;
  description?: string;
  helpText?: string;
  error?: string;
  required?: boolean;
  clearable?: boolean;
  field?: Field;
  options?: OptionVariablePickerOption[];
  suggestions?: VariableSuggestion[];
  lang?: "nl" | "en";
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  optionSectionLabel?: string;
  variableSectionLabel?: string;
  /** When true, the variable suggestions section is hidden. Only static/remote options are shown. */
  hideVariables?: boolean;
  valueMode?: OptionVariablePickerValueMode;
  onChange: (
    nextValue: string,
    selection: OptionVariablePickerSelection,
  ) => void;
};
