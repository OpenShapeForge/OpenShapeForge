// SPDX-License-Identifier: BUSL-1.1
import type {
  RendererFieldConfig,
  RendererFormField,
} from "@/features/renderer/form-definition";
import type {
  Field,
  LocalizedText,
  ValidationRule,
  FieldValidation,
} from "@/generated/compiler/field-contract";
import type {
  FieldAuthoringProfile,
  FieldAuthoringFieldRules,
  FieldAuthoringProfileId,
} from "@/lib/field-authoring/profiles";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import type { ReactNode } from "react";

export type FieldSchemaEditorLang = "nl" | "en" | "fr";
export type FieldSchemaEditorChromeLang = "nl" | "en";

export type FieldSchemaEditorProps = {
  items: unknown[] | string;
  onChange: (items: unknown[] | string) => void;
  profile: FieldAuthoringProfileId;
  mode?: "editor" | "workspace";
  collectionLabel?: string;
  collectionDescription?: string;
  collectionHelpText?: string;
  lang?: FieldSchemaEditorLang;
  reorderable?: boolean;
  variableSourceRows?: boolean;
  variableSuggestions?: VariableSuggestion[];
  singleItem?: boolean;
  suppressDefaultValueControl?: boolean;
  defaultExpandedItems?: "first" | "all" | "none";
};

export type FieldSchemaDefinitionFieldDraft = RendererFormField & {
  dataPath?: string;
  fieldMode?: RendererFieldConfig["displayMode"];
  masking?: RendererFieldConfig["masking"];
};

export type RecursiveFieldSchemaEditorComponent = (
  props: FieldSchemaEditorProps,
) => ReactNode;

/** Shared props for field sub-editors that edit one `Field` slice. */
export type FieldSectionProps = {
  field: Field;
  lang: FieldSchemaEditorChromeLang;
  onChange: (field: Field) => void;
};

export type LocalizedFieldProperty = "description" | "placeholder" | "help" | "label";
export type ValidationRuleKey = Exclude<keyof FieldValidation, "custom">;

export type LocalizedTextEditorProps = {
  label: string;
  value: LocalizedText | undefined;
  lang: FieldSchemaEditorChromeLang;
  onChange: (lang: FieldSchemaEditorChromeLang, nextText: string) => void;
  description?: string;
  multiline?: boolean;
  rows?: number;
};

export type StringListEditorProps = {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  lang: FieldSchemaEditorChromeLang;
  itemLabel: string;
  emptyText: string;
  addLabel: string;
  placeholder?: string;
};

export type ValidationRuleEditorProps = {
  label: string;
  description?: string;
  lang: FieldSchemaEditorChromeLang;
  valueType: "number" | "string";
  rule: number | string | ValidationRule | undefined;
  defaultValue: number | string;
  valueLabel: string;
  placeholder?: string;
  onChangeValue: (value: number | string | undefined) => void;
  onChangeMessage: (lang: FieldSchemaEditorChromeLang, nextText: string) => void;
};

export type FieldSchemaCardProps = {
  field: Field;
  lang: FieldSchemaEditorLang;
  profile: FieldAuthoringProfile;
  siblingKeyCounts: Record<string, number>;
  rules?: FieldAuthoringFieldRules;
  onChange: (field: Field) => void;
  onRemove?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDuplicate?: () => void;
  itemSurface?: "card" | "collection";
  showMoveUpControl?: boolean;
  showMoveDownControl?: boolean;
  moveUpDisabled?: boolean;
  moveDownDisabled?: boolean;
  isNested?: boolean;
  variableSuggestions?: VariableSuggestion[];
  suppressDefaultValueControl?: boolean;
  FieldSchemaEditorComponent: RecursiveFieldSchemaEditorComponent;
};
