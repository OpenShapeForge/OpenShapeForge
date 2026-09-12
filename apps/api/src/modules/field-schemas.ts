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
import type { RuntimeFieldSchemaCompiler } from "@openshapeforge/plugin-runtime";

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
  return Object.freeze({
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
  });
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
});
