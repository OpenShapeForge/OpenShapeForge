// SPDX-License-Identifier: BUSL-1.1
import type {
  CompilerConditionInput,
  CompilerConditionOperandInput,
} from "@/generated/compiler/canonical-condition";
import type { ConditionBuilderMode } from "@/features/renderer/runtime/conditions";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";

export type ConditionBuilderLang = "nl" | "en";

export type ConditionBuilderProps = {
  value?: CompilerConditionInput;
  onChange: (value: CompilerConditionInput) => void;
  mode?: ConditionBuilderMode;
  lang?: ConditionBuilderLang;
  variableSuggestions?: VariableSuggestion[];
  variableSuggestionHeaderLabel?: string;
  disabled?: boolean;
  readOnly?: boolean;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
};

export type ConditionOperandEditorProps = {
  value?: CompilerConditionOperandInput;
  onChange: (value: CompilerConditionOperandInput) => void;
  lang: ConditionBuilderLang;
  variableSuggestions?: VariableSuggestion[];
  variableSuggestionHeaderLabel?: string;
  disabled?: boolean;
  readOnly?: boolean;
  allowPath?: boolean;
  allowFunction?: boolean;
  label: string;
  literalOptions?: Array<{ value: string; label: string }>;
  leftFieldType?: string;
  operator?: import("@/generated/compiler/canonical-condition").CompilerConditionOperator;
};
