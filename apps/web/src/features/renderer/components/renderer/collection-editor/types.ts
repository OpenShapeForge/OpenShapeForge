// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";

import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import type { Field } from "@/generated/compiler/field-contract";

export type CollectionEditorLang = "nl" | "en" | "fr";

export type CollectionEditorProps = {
  id?: string;
  field: Field;
  value: unknown;
  lang?: CollectionEditorLang;
  label: string;
  description?: string;
  helpText?: string;
  error?: string;
  required?: boolean;
  readOnly?: boolean;
  reorderable?: boolean;
  /** Override the items.length-based default-expansion heuristic on mount. */
  defaultExpanded?: boolean;
  defaultExpandedItems?: "first" | "all" | "none";
  surfaceMode?: "editor" | "workspace";
  variableSuggestions?: VariableSuggestion[];
  variableSourceSuggestions?: VariableSuggestion[];
  createItem?: () => unknown;
  createManualRow?: () => unknown;
  createManualItem?: () => unknown;
  canRemoveItem?: (item: unknown, index: number) => boolean;
  canReorderItem?: (item: unknown, index: number) => boolean;
  canDuplicateItem?: (item: unknown, index: number) => boolean;
  onDuplicateItem?: (index: number) => void;
  resolveItemLabel?: (
    item: unknown,
    index: number,
    lang: CollectionEditorLang,
  ) => string | null | undefined;
  onChange: (nextValue: unknown[] | string) => void;
  renderItem: (index: number) => ReactNode;
};
