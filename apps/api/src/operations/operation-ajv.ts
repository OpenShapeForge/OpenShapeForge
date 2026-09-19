// SPDX-License-Identifier: BUSL-1.1
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  operationI18nKeyword,
  operationInputFieldsKeyword,
  operationReferenceKeyword,
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
  const instance = new Ajv2020.default({ strict: true, allErrors: true, coerceTypes });
  // ajv-formats is CJS; under NodeNext the default import is typed as the
  // module namespace rather than the callable it is at runtime.
  (addFormats as unknown as (target: OperationAjv) => unknown)(instance);
  // Presentation-only bindings used by generated forms. They neither validate
  // nor authorize a value, but strict ajv must recognize each keyword.
  instance.addKeyword({ keyword: "x-osf-sourceField", schemaType: "string", valid: true });
  instance.addKeyword({ keyword: "x-osf-control", schemaType: "string", valid: true });
  // The authoring editor's choice marker (which catalog a string is chosen from); presentation metadata as well.
  instance.addKeyword({ keyword: "x-osf-choice", schemaType: "string", valid: true });
  instance.addKeyword(operationReferenceKeyword);
  instance.addKeyword(operationI18nKeyword);
  instance.addKeyword(operationInputFieldsKeyword);
  return instance;
}
