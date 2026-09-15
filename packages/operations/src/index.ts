// SPDX-License-Identifier: BUSL-1.1
export { operationReferenceKeyword, operationI18nKeyword } from "./schema-annotations.js";

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
  OperationFieldDefinition,
  OperationFieldOptions,
  OperationFieldSchemaOptions,
  OperationFieldSchemaRegistry,
  OperationFieldSemanticType,
  OperationFieldValidation,
  OperationJsonSchema,
  OperationLocalizedText,
} from "./field-schema.js";
export {
  operationFieldObjectSchema,
  operationFieldSchema,
} from "./field-schema.js";
