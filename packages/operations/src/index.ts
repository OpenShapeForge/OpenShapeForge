// SPDX-License-Identifier: BUSL-1.1
export { operationChoiceKeyword, operationReferenceKeyword, operationI18nKeyword, operationInputFieldsKeyword } from "./schema-annotations.js";

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
  GENERIC_TOOL_OPERATIONS,
  compactGenericInputSchema,
  describeToolDefinition,
  genericToolText,
} from "./mcp-generic-projection.js";
export type { GenericToolBranch, GenericToolOperation } from "./mcp-generic-projection.js";
