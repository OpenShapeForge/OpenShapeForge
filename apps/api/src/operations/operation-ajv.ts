// SPDX-License-Identifier: BUSL-1.1
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  valueInvariantKeywords,
  operationChoiceKeyword,
  operationExactNumericKeyword, operationFieldMetadataKeywords,
  operationI18nKeyword,
  operationInputFieldsKeyword,
  operationReferenceKeyword,
  operationTypeKeyword,
  operationVariablesKeyword,
} from "@openshapeforge/operations";

export type OperationAjv = InstanceType<typeof Ajv2020.default>;

/**
 * The one ajv configuration that understands a compiled Operation schema: the
 * strict 2020 dialect, the format vocabulary, and every `x-osf-*` annotation
 * the compiler emits. Plugin Operations, entity Operations and collection
 * mutations all validate through an instance built here, so a keyword the
 * compiler adds is recognized in every place a schema is enforced.
 */
export function createOperationAjv(coerceTypes = false): OperationAjv {
  // A numeric property publishes both of its forms — the JSON number and the
  // exact decimal text every transport projects it as — so a compiled schema
  // legitimately carries a union type.
  const instance = new Ajv2020.default({ strict: true, allErrors: true, allowUnionTypes: true, coerceTypes });
  // ajv-formats is CJS; under NodeNext the default import is typed as the
  // module namespace rather than the callable it is at runtime.
  (addFormats as unknown as (target: OperationAjv) => unknown)(instance);
  // Presentation-only bindings used by generated forms. They neither validate
  // nor authorize a value, but strict ajv must recognize each keyword.
  instance.addKeyword({ keyword: "x-osf-sourceField", schemaType: "string", valid: true });
  instance.addKeyword({ keyword: "x-osf-control", schemaType: "string", valid: true });
  instance.addKeyword({ keyword: "x-osf-default-template", schemaType: "string", valid: true });
  // The authoring editor's choice marker (which catalog a string is chosen from); presentation metadata as well.
  instance.addKeyword(operationChoiceKeyword);
  instance.addKeyword(operationReferenceKeyword);
  instance.addKeyword(operationI18nKeyword);
  instance.addKeyword(operationInputFieldsKeyword);
  instance.addKeyword(operationTypeKeyword);
  instance.addKeyword(operationVariablesKeyword);
  for (const keyword of operationFieldMetadataKeywords) instance.addKeyword(keyword);
  for (const keyword of valueInvariantKeywords) instance.addKeyword(keyword);
  // The one x-osf keyword that validates: the exact bounds of a numeric
  // value's text form, which the numeric keywords beside it do not see.
  instance.addKeyword(operationExactNumericKeyword);
  return instance;
}
