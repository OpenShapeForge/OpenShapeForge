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
export type { ScalarJsonSchema, ScalarProjection, ScalarType } from "./scalar-projection.js";
export { isScalarType, SCALAR_PROJECTION, SCALAR_TYPES, scalarJsonSchema } from "./scalar-projection.js";
