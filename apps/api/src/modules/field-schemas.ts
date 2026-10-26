// SPDX-License-Identifier: BUSL-1.1
/** Host-bound runtime FieldDefinition schema projection. */
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  valueInvariantKeywords,
  operationChoiceKeyword,
  operationExactNumericKeyword, operationFieldMetadataKeywords,
  operationFieldObjectSchema,
  operationI18nKeyword,
  operationInputFieldsKeyword,
  operationReferenceKeyword,
  resolveFieldBaseType,
  type OperationFieldBaseType,
  operationTypeKeyword,
  operationVariablesKeyword,
  type OperationFieldDefinition,
  type OperationFieldSchemaRegistry,
} from "@openshapeforge/operations";
import type { RuntimeFieldSchemaCompiler, RuntimeJsonSchemaValidator, RuntimeSchemaValidationResult } from "@openshapeforge/plugin-runtime";

function invalidDefinition(): RuntimeSchemaValidationResult {
  return { valid: false, error: { code: "INVALID_DEFINITION", message: "De invoerbeschrijving is ongeldig.",
    detail: "De gegevens zijn niet verwerkt. Laat de formulierinstellingen controleren.", retryable: false } };
}

function createJsonSchemaCompiler() {
  const ajv = new Ajv2020.default({ allErrors: true, strict: false, strictSchema: true, allowUnionTypes: true });
  addFormats.default(ajv);
  ajv.addKeyword(operationExactNumericKeyword);
  ajv.addKeyword(operationI18nKeyword);
  ajv.addKeyword(operationInputFieldsKeyword);
  ajv.addKeyword(operationReferenceKeyword);
  // Match canonical Operation validation: this is presentation metadata,
  // never an alternative to the artifact object's actual value constraints.
  ajv.addKeyword({ keyword: "x-osf-control", schemaType: "string", valid: true });
  ajv.addKeyword({ keyword: "x-osf-default-template", schemaType: "string", valid: true });
  ajv.addKeyword(operationChoiceKeyword);
  ajv.addKeyword(operationTypeKeyword);
  ajv.addKeyword(operationVariablesKeyword);
  for (const keyword of operationFieldMetadataKeywords) ajv.addKeyword(keyword);
  for (const keyword of valueInvariantKeywords) ajv.addKeyword(keyword);
  // Prepare the fixed meta-schemas before readiness. Dynamic schemas are
  // removed below; only the engine and its standard vocabulary are reused.
  ajv.compile({});
  ajv.removeSchema();
  return ajv;
}

const JSON_COMPILER_VALIDATION_LIMIT = 16;
const JSON_COMPILER_IDLE_MS = 1_000;
let compilerGeneration = 0;
const newJsonCompiler = () => ({ ajv: createJsonSchemaCompiler(), validations: 0, generation: ++compilerGeneration });
let idleJsonSchemaCompiler: ReturnType<typeof newJsonCompiler> | undefined = newJsonCompiler();
let compilerExpiry: ReturnType<typeof setTimeout> | undefined;

/** Numeric lifecycle evidence only; never schemas or values. */
export function __runtimeJsonSchemaCompilerStateForTests() {
  return { generation: idleJsonSchemaCompiler?.generation, validations: idleJsonSchemaCompiler?.validations ?? 0,
    validationLimit: JSON_COMPILER_VALIDATION_LIMIT, idleMs: JSON_COMPILER_IDLE_MS };
}
export const runtimeJsonSchemas: RuntimeJsonSchemaValidator = Object.freeze({
  validate(schema, values) {
    const leased = idleJsonSchemaCompiler ?? newJsonCompiler();
    const { ajv } = leased;
    // A synchronous validation owns this compiler until finally. A reentrant
    // call obtains a separate compiler, never another call's schema registry.
    idleJsonSchemaCompiler = undefined;
    clearTimeout(compilerExpiry);
    compilerExpiry = undefined;
    try {
      if (schema.$async === true) return invalidDefinition();
      const validate = ajv.compile(schema);
      if (validate(values)) return { valid: true };
      return { valid: false, error: {
        code: "VALIDATION_FAILED", message: "Controleer de ingevulde gegevens.", retryable: false,
        violations: (validate.errors ?? []).map((error) => ({
          field: error.instancePath || "/", code: error.keyword.toUpperCase(),
          message: error.keyword === "required" ? "Vul de verplichte gegevens in." : "Vul een geldige waarde in.",
          // Only schema paths/rules, never raw values or validator exception text.
          detail: `${error.instancePath || "/"}: ${error.keyword}`,
        })),
      } };
    } catch { return invalidDefinition(); }
    finally {
      // Clear the lookup registry, including partially registered definitions.
      // Ajv's code-generation scope still retains references after removeSchema,
      // so retire the whole engine after a bounded number of validations or
      // one idle second. No compiled schema, input or result is reused.
      ajv.removeSchema();
      ajv.errors = null;
      if (++leased.validations < JSON_COMPILER_VALIDATION_LIMIT) {
        idleJsonSchemaCompiler = leased;
        clearTimeout(compilerExpiry);
        compilerExpiry = setTimeout(() => {
          idleJsonSchemaCompiler = undefined;
          compilerExpiry = undefined;
        }, JSON_COMPILER_IDLE_MS);
        compilerExpiry.unref();
      }
    }
  },
});

export type GeneratedRuntimeFieldSchemaRegistry = OperationFieldSchemaRegistry & {
  version: 1;
  fieldDefinitionSchema: Record<string, unknown>;
};

const LEGACY_FIELD_DEFINITION_KEYS = ["valueType", "semanticType"] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Stored FieldDefinitions have no compatibility reader: the old two-axis
 * `valueType`/`semanticType` shape must be reset instead of being silently
 * reinterpreted as a canonical `osfType` field. Walk only recursive
 * FieldDefinition positions; similarly named properties inside unrelated
 * metadata remain outside this contract.
 */
function assertCanonicalStoredFieldDefinition(value: unknown, path: string): void {
  if (!isRecord(value)) return;
  for (const key of LEGACY_FIELD_DEFINITION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(
        `${path} uses removed legacy key "${key}"; reset the stored definition and use canonical "osfType".`,
      );
    }
  }
  for (const key of ["shape", "children"] as const) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      nested.forEach((child, index) =>
        assertCanonicalStoredFieldDefinition(child, `${path}.${key}[${index}]`));
    }
  }
  if (value.item !== undefined) {
    assertCanonicalStoredFieldDefinition(value.item, `${path}.item`);
  }
}

function assertRegistry(value: unknown): asserts value is GeneratedRuntimeFieldSchemaRegistry {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    !(value as { fieldDefinitionSchema?: unknown }).fieldDefinitionSchema ||
    typeof (value as { fieldDefinitionSchema?: unknown }).fieldDefinitionSchema !== "object"
  ) {
    throw new Error("The generated runtime FieldDefinition registry is not valid.");
  }
}

export function createRuntimeFieldSchemaCompiler(
  registry: GeneratedRuntimeFieldSchemaRegistry,
): RuntimeFieldSchemaCompiler {
  assertRegistry(registry);
  const ajv = new Ajv2020.default({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats.default(ajv);
  const validate = ajv.compile(registry.fieldDefinitionSchema);
  const compiler: RuntimeFieldSchemaCompiler = {
    object(fields: readonly Readonly<Record<string, unknown>>[]) {
      if (!Array.isArray(fields)) {
        throw new Error("FieldDefinitions must be an array.");
      }
      for (let index = 0; index < fields.length; index += 1) {
        assertCanonicalStoredFieldDefinition(fields[index], `FieldDefinition at index ${index}`);
        if (!validate(fields[index])) {
          const paths = [...new Set((validate.errors ?? []).map((error: { instancePath: string }) =>
            error.instancePath || "/"
          ))].sort();
          throw new Error(
            `FieldDefinition at index ${index} does not match the active authoring schema` +
              `${paths.length > 0 ? ` at ${paths.join(", ")}` : ""}.`,
          );
        }
      }
      return operationFieldObjectSchema(
        fields as readonly OperationFieldDefinition[],
        registry,
      );
    },
    validateObject(fields, values) {
      try { return runtimeJsonSchemas.validate(compiler.object(fields), values); }
      catch { return invalidDefinition(); }
    },
  };
  return Object.freeze(compiler);
}

let generatedRegistry: GeneratedRuntimeFieldSchemaRegistry | undefined;
let generatedCompiler: RuntimeFieldSchemaCompiler | undefined;

function loadGeneratedRegistry(): GeneratedRuntimeFieldSchemaRegistry {
  if (!generatedRegistry) {
    const path = new URL("../generated/operations/field-schema-registry.json", import.meta.url);
    const registry: unknown = JSON.parse(readFileSync(path, "utf8"));
    assertRegistry(registry);
    generatedRegistry = registry;
  }
  return generatedRegistry;
}

/**
 * The base type of a stored field definition, resolved through the generated
 * osf-type registry the way the compiler resolves an authored field. An
 * unknown osfType is refused, never projected as a string.
 */
export function storedFieldBaseType(
  definition: { key?: unknown; osfType?: unknown; valueType?: unknown; semanticType?: unknown },
): OperationFieldBaseType {
  assertCanonicalStoredFieldDefinition(definition, `FieldDefinition "${typeof definition.key === "string" ? definition.key : "(field)"}"`);
  return resolveFieldBaseType({
    key: typeof definition.key === "string" ? definition.key : "(field)",
    osfType: typeof definition.osfType === "string" ? definition.osfType : "(none)",
  }, loadGeneratedRegistry().osfTypes);
}

export const generatedRuntimeFieldSchemas: RuntimeFieldSchemaCompiler = Object.freeze({
  object(fields) {
    generatedCompiler ??= createRuntimeFieldSchemaCompiler(loadGeneratedRegistry());
    return generatedCompiler.object(fields);
  },
  validateObject(fields, values) {
    try { return runtimeJsonSchemas.validate(generatedRuntimeFieldSchemas.object(fields), values); }
    catch { return invalidDefinition(); }
  },
});
