// SPDX-License-Identifier: BUSL-1.1
import type {
  FocusEventHandler,
  KeyboardEventHandler,
  MouseEventHandler,
  ReactNode,
} from "react";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";

export type TriggerMatch = {
  start: number;
  end: number;
  query: string;
  trigger: "$" | "@";
};

export type SharedInputProps = {
  id?: string;
  name?: string;
  className?: string;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  maxLength?: number;
  autoFocus?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  onBlur?: FocusEventHandler<HTMLElement>;
  onFocus?: FocusEventHandler<HTMLElement>;
  onClick?: MouseEventHandler<HTMLElement>;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  multiline?: boolean;
  rows?: number;
};

export type TextInputBehavior =
  | "plain"
  | "variable-token"
  | "variable-select";

export type TextInputVariant = "default" | "heading";

export type TextInputProps = SharedInputProps & {
  value: string;
  suggestions?: VariableSuggestion[];
  onValueChange: (value: string) => void;
  emptyMessage?: string;
  suggestionHeaderLabel?: string;
  behavior?: TextInputBehavior;
  variant?: TextInputVariant;
  lang?: "nl" | "en";
};

export type TextInputControlProps = Omit<TextInputProps, "behavior">;

export type TextInputExpressionDisplayProps = {
  value: string;
  suggestions?: VariableSuggestion[];
  className?: string;
  emptyState?: ReactNode;
};

export type NavigationTarget =
  | { kind: "group"; groupId: string }
  | { kind: "item"; groupId: string; path: string };

export type NavigationEntry =
  | { kind: "group"; groupId: string }
  | {
      kind: "item";
      groupId: string;
      path: string;
      suggestion: VariableSuggestion;
      depth: number;
      treeKey?: string;
      hasChildren?: boolean;
    };

export type TokenSegment =
  | { kind: "text"; text: string }
  | {
      kind: "token";
      raw: string;
      path: string;
      display: string;
      title: string;
      suggestion: VariableSuggestion | null;
      start: number;
      end: number;
    };

export type SelectionOffsets = {
  start: number;
  end: number;
};

export type NativeTextElement = HTMLInputElement | HTMLTextAreaElement;
