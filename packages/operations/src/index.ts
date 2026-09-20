// SPDX-License-Identifier: BUSL-1.1
export { operationChoiceKeyword, operationReferenceKeyword, operationI18nKeyword, operationInputFieldsKeyword, operationTypeKeyword } from "./schema-annotations.js";

export type {
  OperationEnvelope,
  OperationConfirmation,
  OperationConfirmationBinding,
  OperationConcurrency,
  OperationError,
  OperationInteraction,
  OperationInteractionBinding,
  OperationInteractionChoice,
  OperationOffer,
  OperationPrerequisite,
  OperationTargetBinding,
  OperationReference,
  OperationResult,
  OperationViolation,
} from "./contract.js";
export {
  isOperationFailure,
  OperationFailure,
  operationErrorOf,
  operationFailure,
} from "./contract.js";
export type {
  DescribeFieldOptions,
  FieldEnumeration,
  OperationFieldBaseType,
  OperationFieldCardinality,
  OperationFieldDefinition,
  OperationFieldOptions,
  OperationFieldRelationship,
  OperationFieldSchemaOptions,
  OperationFieldSchemaRegistry,
  OperationFieldOsfType,
  OperationFieldValidation,
  OperationJsonSchema,
  OperationLocalizedText,
  OperationReferenceConstraints,
  ResolvedCardinality,
  ResolvedOperationField,
} from "./field-schema.js";
export {
  bundleDefinitions,
  cardinalityOf,
  collectionBounds,
  collectionShape,
  constrainedType,
  describeField,
  fieldEnumeration,
  fieldSchema,
  isBaseType,
  localizedText,
  numericRule,
  objectSchema,
  operationFieldObjectSchema,
  operationFieldSchema,
  resolveFieldBaseType,
  resolveFields,
  resolveOptions,
  ruleValue,
  stringRule,
  typedEnumValues,
} from "./field-schema.js";
export { renderTemplate, templatePaths, templateSelection } from "./display-template.js";
export { compareCodeUnits } from "./ordering.js";
export {
  GENERIC_DESCRIBE_TOOL_NAME,
  GENERIC_TOOL_NAME_PREFIX,
  GENERIC_TOOL_OPERATIONS,
  advertisedGenericTool,
  compactGenericInputSchema,
  describeToolDefinition,
  genericTextLanguage,
  genericToolText,
} from "./mcp-generic-projection.js";
export type { McpToolShape } from "./mcp-tool-shape.js";
export { ARTIFACT_UPLOAD_TOOL_NAME, uploadToolDefinition } from "./mcp-upload-tool.js";
export { EDIT_LEASE_TOOL_NAMES, editLeaseToolDefinitions } from "./mcp-edit-lease-tools.js";
export {
  DEFAULT_OPERATION_SEARCH_RESULTS,
  MAX_OPERATION_SEARCH_RESULTS,
  searchableOperationToolDefinitions,
} from "./mcp-search-tools.js";
export type { SearchableOperationToolNames } from "./mcp-search-tools.js";
export { connectHelperTool, dryRunHelperTool, personalizationHelperTool } from "./mcp-derived-helper-tools.js";
export { discoveryToolDefinition, guideToolDefinition, testToolDefinition } from "./mcp-entity-static-tools.js";
export { connectorMcpTools, connectorToolAnnotations } from "./mcp-connector-tools.js";
export type {
  ConnectorMcpContractShape,
  ConnectorMcpOperationShape,
  ConnectorMcpTool,
} from "./mcp-connector-tools.js";
export {
  DYNAMIC_TOOL_BYTES_ALLOWANCE,
  MAX_ADVERTISED_TOOL_BYTES,
  MAX_STATIC_TOOL_BYTES,
  PLATFORM_TOOL_BYTES_ALLOWANCE,
  advertisedToolBytes,
} from "./mcp-tool-budget.js";
export type { GenericToolAdvertisement, GenericToolBranch, GenericToolOperation } from "./mcp-generic-projection.js";
export {
  DATA_ACQUISITION_TOOL_FOOTER,
  ENTITY_CONFIGURATION_APP_URI,
  advertisedEntityTool,
  localizedEntityToolText,
  schemaInLanguage,
} from "./mcp-entity-tool-shape.js";
export type { EntityToolAdvertisement } from "./mcp-entity-tool-shape.js";
export type { ScalarJsonSchema, ScalarProjection, ScalarType } from "./scalar-projection.js";
export { isScalarType, SCALAR_PROJECTION, SCALAR_TYPES, scalarJsonSchema } from "./scalar-projection.js";
export type { EntityRuntimeError, EntityRuntimeErrorSituation } from "./entity-runtime-errors.js";
export { ENTITY_RUNTIME_ERRORS, ENTITY_RUNTIME_ERROR_STATUS } from "./entity-runtime-errors.js";
