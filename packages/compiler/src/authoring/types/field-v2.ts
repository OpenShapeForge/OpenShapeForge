// SPDX-License-Identifier: BUSL-1.1
/**
 * Compatibility names for consumers that adopted the transitional FieldV2
 * contract. New code should import the canonical names from
 * `field-definition.ts`.
 */
export type {
  FieldDefinition as FieldV2,
  FieldDefinitionAuthoringMetadata as FieldV2AuthoringMetadata,
  FieldDefinitionCardinality as FieldV2Cardinality,
  FieldDefinitionRelationship as FieldV2Relationship,
  FieldDefinitionRuntimeMetadata as FieldV2RuntimeMetadata,
  FieldDefinitionSemanticType as SemanticTypeDefinitionV2,
  FieldDefinitionSemanticTypeKind as FieldV2SemanticTypeKind,
  FieldDefinitionSuggestions as FieldV2Suggestions,
  FieldDefinitionValidation as FieldV2Validation,
  FieldDefinitionValueType as FieldV2ValueType,
  FieldDefinitionVariableMode as FieldV2VariableMode,
  FieldDefinitionWorkflowInspector as FieldV2WorkflowInspector,
} from "./field-definition.js";
