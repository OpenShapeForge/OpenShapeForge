// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import type { CompilerAuthorableFieldType } from "../compiler-field-types";

export type FieldAuthoringMetadata = {
  profile?: string;
  pinned?: boolean;
  locked?: boolean;
  singleton?: boolean;
  visibleProperties?: string[];
};

export type FieldWithAuthoringMetadata = Field & {
  shape?: Field[];
  authoring?: FieldAuthoringMetadata;
};

export type FieldAuthoringProfileId =
  | "fullFieldDefinition"
  | "workflowInputField"
  | "workflowStartVariable"
  | "workflowProcessVariable"
  | "runtimeNotificationParameter"
  | "templateParameter"
  | "workflowOutputField"
  | "formDefinitionField";

type FieldValueAuthoringConfig = {
  label: {
    en: string;
    nl: string;
  };
  description: {
    en: string;
    nl: string;
  };
};

export type FieldAuthoringProfileControls = {
  label?: boolean;
  description?: boolean;
  type?: "combined" | boolean;
  cardinality?: boolean;
  searchable?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  shape?: boolean;
  options?: boolean;
  render?: boolean;
  aiHint?: boolean;
  defaultValue?: boolean;
  value?: boolean;
  validation?: boolean;
  layout?: boolean;
  persistence?: boolean;
};

export type FieldAuthoringFieldRules = {
  pinned?: boolean;
  disableRemove?: boolean;
  disableDuplicate?: boolean;
  disableMove?: boolean;
  lockType?: boolean;
  lockLabel?: boolean;
  lockRequired?: boolean;
  lockOptions?: boolean;
  locked?: boolean;
  visibleProperties?: string[];
  note?: {
    en: string;
    nl: string;
  };
};

export type FieldAuthoringProfile = {
  id: FieldAuthoringProfileId;
  label: {
    en: string;
    nl: string;
  };
  keyBehavior?: "editable" | "generatedFromLabel";
  excludedFieldTypes: CompilerAuthorableFieldType[];
  typePickerUsage:
    | "requestInput"
    | "workflowConfig"
    | "entityMapping"
    | "internalSchema";
  controls: FieldAuthoringProfileControls;
  createEmptyField: () => Field;
  valueAuthoring?: FieldValueAuthoringConfig;
  normalizeItems?: (items: Field[]) => Field[];
  getFieldRules?: (
    field: Field,
    index: number,
    items: Field[],
  ) => FieldAuthoringFieldRules | undefined;
};
