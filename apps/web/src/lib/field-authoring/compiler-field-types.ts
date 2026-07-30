// SPDX-License-Identifier: BUSL-1.1
import {
  COMPILER_FIELD_COMPONENT_DEFAULTS,
  type CompilerFieldTypeKey,
} from "@/generated/compiler/component-defaults";
import type { LocalizedText } from "@/generated/compiler/field-contract";

export const FIELD_DEFINITION_SEMANTIC_COLLECTION_TYPE = "fieldDefinition";
// Compatibility alias for generated authoring profile config that predates
// semantic collection selection. Do not use as a renderer/default field key.
export const FIELD_DEFINITION_COLLECTION_COMPAT_TYPE = "fieldDefinitionCollection";

export type CompilerAuthorableSemanticCollectionType =
  typeof FIELD_DEFINITION_SEMANTIC_COLLECTION_TYPE;

export type CompilerAuthorableFieldType =
  | CompilerFieldTypeKey
  | CompilerAuthorableSemanticCollectionType;

type CompilerFieldTypeOption = {
  value: CompilerAuthorableFieldType;
  label: LocalizedText;
};

const FIELD_DEFINITION_TYPE_OPTION = {
  value: FIELD_DEFINITION_SEMANTIC_COLLECTION_TYPE,
  label: {
    nl: "Velddefinities",
    en: "Field definitions",
  },
} satisfies CompilerFieldTypeOption;

export const COMPILER_FIELD_TYPE_OPTIONS = (
  [
    ...(Object.keys(COMPILER_FIELD_COMPONENT_DEFAULTS) as CompilerFieldTypeKey[]).map(
      (value): CompilerFieldTypeOption => ({
        value,
        label: COMPILER_FIELD_COMPONENT_DEFAULTS[value].label,
      }),
    ),
    FIELD_DEFINITION_TYPE_OPTION,
  ]
    .filter((option, index, options) =>
      options.findIndex((candidate) => candidate.value === option.value) === index
    ) satisfies CompilerFieldTypeOption[]
);
