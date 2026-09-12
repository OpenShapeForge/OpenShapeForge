// SPDX-License-Identifier: BUSL-1.1
/** Host-bound runtime FieldDefinition schema projection. */
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  operationFieldObjectSchema,
  type OperationFieldDefinition,
  type OperationFieldSchemaRegistry,
} from "@openshapeforge/operations";
import type { RuntimeFieldSchemaCompiler, RuntimeJsonSchemaValidator, RuntimeSchemaValidationResult } from "@openshapeforge/plugin-runtime";

function invalidDefinition(): RuntimeSchemaValidationResult {
  return { valid: false, error: { code: "INVALID_DEFINITION", message: "De invoerbeschrijving is ongeldig.",
    detail: "De gegevens zijn niet verwerkt. Laat de formulierinstellingen controleren.", retryable: false } };
}

export const runtimeJsonSchemas: RuntimeJsonSchemaValidator = Object.freeze({
  validate(schema, values) {
    // A short-lived compiler avoids retaining every stored/dynamic form forever.
    // No async loader, coercion, removal or defaults: validation never rewrites input.
    const ajv = new Ajv2020.default({ allErrors: true, strict: false });
    addFormats.default(ajv);
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
  },
});

export type GeneratedRuntimeFieldSchemaRegistry = OperationFieldSchemaRegistry & {
  version: 1;
  fieldDefinitionSchema: Record<string, unknown>;
};

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
  const ajv = new Ajv2020.default({ allErrors: true, strict: false });
  addFormats.default(ajv);
  const validate = ajv.compile(registry.fieldDefinitionSchema);
  const compiler: RuntimeFieldSchemaCompiler = {
    object(fields: readonly Readonly<Record<string, unknown>>[]) {
      if (!Array.isArray(fields)) {
        throw new Error("FieldDefinitions must be an array.");
      }
      for (let index = 0; index < fields.length; index += 1) {
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

let generatedCompiler: RuntimeFieldSchemaCompiler | undefined;

export const generatedRuntimeFieldSchemas: RuntimeFieldSchemaCompiler = Object.freeze({
  object(fields) {
    if (!generatedCompiler) {
      const path = new URL(
        "../generated/operations/field-schema-registry.json",
        import.meta.url,
      );
      const registry: unknown = JSON.parse(readFileSync(path, "utf8"));
      assertRegistry(registry);
      generatedCompiler = createRuntimeFieldSchemaCompiler(registry);
    }
    return generatedCompiler.object(fields);
  },
  validateObject(fields, values) {
    try { return runtimeJsonSchemas.validate(generatedRuntimeFieldSchemas.object(fields), values); }
    catch { return invalidDefinition(); }
  },
});
