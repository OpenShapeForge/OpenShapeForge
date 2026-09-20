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
  OperationFieldBaseType,
  OperationFieldDefinition,
  OperationFieldOptions,
  OperationFieldSchemaOptions,
  OperationFieldSchemaRegistry,
  OperationFieldOsfType,
  OperationFieldValidation,
  OperationJsonSchema,
  OperationLocalizedText,
} from "./field-schema.js";
export {
  typedEnumValues,
  operationFieldObjectSchema,
  operationFieldSchema,
} from "./field-schema.js";
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
export {
  ARTIFACT_UPLOAD_TOOL_NAME,
  DEFAULT_OPERATION_SEARCH_RESULTS,
  EDIT_LEASE_TOOL_NAMES,
  MAX_OPERATION_SEARCH_RESULTS,
  connectHelperTool,
  discoveryToolDefinition,
  dryRunHelperTool,
  editLeaseToolDefinitions,
  guideToolDefinition,
  personalizationHelperTool,
  searchableOperationToolDefinitions,
  testToolDefinition,
  uploadToolDefinition,
} from "./mcp-static-tools.js";
export type { McpToolShape, SearchableOperationToolNames } from "./mcp-static-tools.js";
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
} from "./mcp-entity-tool-shape.js";
export type { EntityToolAdvertisement } from "./mcp-entity-tool-shape.js";
