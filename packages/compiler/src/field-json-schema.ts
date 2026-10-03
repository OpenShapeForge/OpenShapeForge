// SPDX-License-Identifier: BUSL-1.1
/**
 * The compiler's binding of the one FieldDefinition → JSON Schema projector,
 * which lives in `@openshapeforge/operations` because plugins and the runtime
 * host project stored definitions through it too. Nothing here maps a field
 * to a schema; this file only supplies what the compiler knows and the
 * runtime receives as a generated registry: the resolved catalogs and the
 * bundled definitions of the recursive fieldDefinition type.
 */

import type {
  CompiledField,
  ComponentCatalog,
  Field,
  FieldDefinition,
  OsfTypeDefinition,
} from "./authoring/types.js";
import type { CoreReferentiedataSnapshot } from "./core-referentiedata-artifacts.js";
import { resolveModelFields } from "./authoring/compiler/model.js";
import { osfTypeDefinitionOf } from "./authoring/entity-fields.js";
import fieldDefinitionAuthoringSchema from "../config/schemas/field-definition.schema.json" with {
  type: "json",
};
import workflowInspectorSchema from "../config/schemas/workflow-inspector.schema.json" with {
  type: "json",
};
import {
  bundleDefinitions,
  describeField,
  fieldSchema,
  objectSchema,
  operationFieldObjectSchema,
  operationFieldSchema,
  resolveFields,
  type DescribeFieldOptions,
  type OperationFieldDefinition,
  type OperationFieldSchemaOptions,
  type OperationFieldSchemaRegistry,
  type ResolvedOperationField,
} from "@openshapeforge/operations";

export {
  localizedText,
  numericRule,
  ruleValue,
  stringRule,
} from "@openshapeforge/operations";

export type JsonObject = Record<string, unknown>;

const WORKFLOW_INSPECTOR_SCHEMA_ID =
  "https://openshapeforge.example/schema-common/workflow-inspector.schema.json";

const {
  $schema: _workflowDialect,
  $id: _workflowId,
  title: _workflowTitle,
  ...workflowInspector
} = workflowInspectorSchema;
const fieldDefinitionDefinitions = {
  ...(rebaseJsonSchemaReferences(
    fieldDefinitionAuthoringSchema.$defs,
    WORKFLOW_INSPECTOR_SCHEMA_ID,
    "#/$defs/workflowInspector",
  ) as JsonObject),
  workflowInspector,
};

/** Registries emitted for the host-bound runtime FieldDefinition compiler. */
export function runtimeFieldSchemaRegistry(input: {
  osfTypes?: Record<string, OsfTypeDefinition>;
  referentiedata?: CoreReferentiedataSnapshot;
}): OperationFieldSchemaRegistry & {
  fieldDefinitionSchema: JsonObject;
} {
  return {
    osfTypes: (input.osfTypes ?? {}) as unknown as NonNullable<OperationFieldSchemaRegistry["osfTypes"]>,
    referentiedata: (input.referentiedata ?? {}) as unknown as NonNullable<OperationFieldSchemaRegistry["referentiedata"]>,
    fieldDefinitionDefinitions: structuredClone(fieldDefinitionDefinitions),
    fieldDefinitionSchema: {
      $ref: fieldDefinitionAuthoringSchema.$ref,
      $defs: structuredClone(fieldDefinitionDefinitions),
    },
  };
}

export function renderRuntimeFieldSchemaRegistry(input: {
  osfTypes?: Record<string, OsfTypeDefinition>;
  referentiedata?: CoreReferentiedataSnapshot;
}): string {
  return `${JSON.stringify({ version: 1, ...runtimeFieldSchemaRegistry(input) }, null, 2)}\n`;
}

export function bundleFieldDefinitionSchema(schema: JsonObject): JsonObject {
  return bundleDefinitions(schema, { fieldDefinitionDefinitions });
}

/** Rebase only JSON Schema references, leaving descriptions and values intact. */
export function rebaseJsonSchemaReferences(
  value: unknown,
  fromBase: string,
  toBase: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rebaseJsonSchemaReferences(entry, fromBase, toBase));
  }
  if (!value || typeof value !== "object") return value;

  const rebased: JsonObject = {};
  for (const [key, entry] of Object.entries(value as JsonObject)) {
    rebased[key] =
      key === "$ref" && typeof entry === "string" && entry.startsWith(fromBase)
        ? `${toBase}${entry.slice(fromBase.length)}`
        : rebaseJsonSchemaReferences(entry, fromBase, toBase);
  }
  return rebased;
}

/** Move reusable definitions when a complete schema is nested in another root. */
export function splitBundledDefinitions(schema: JsonObject): {
  schema: JsonObject;
  definitions: JsonObject;
} {
  const { $defs, ...unbundled } = schema;
  return {
    schema: unbundled,
    definitions:
      $defs && typeof $defs === "object" && !Array.isArray($defs)
        ? ($defs as JsonObject)
        : {},
  };
}

export type CompiledFieldDescriptionOptions = DescribeFieldOptions;

export function describeCompiledField(
  field: CompiledField,
  options: CompiledFieldDescriptionOptions = {},
): string | undefined {
  return describeField(field, options);
}

export type CompiledFieldDescription = (
  field: CompiledField,
) => string | undefined;

export type CompiledFieldSchemaOptions = Omit<OperationFieldSchemaOptions, "describeField"> & {
  describeField?: CompiledFieldDescription;
};

function compiledRegistry(referentiedata: CoreReferentiedataSnapshot): OperationFieldSchemaRegistry {
  return {
    referentiedata: referentiedata as unknown as NonNullable<OperationFieldSchemaRegistry["referentiedata"]>,
    fieldDefinitionDefinitions,
  };
}

function projectorOptions(options: CompiledFieldSchemaOptions): OperationFieldSchemaOptions {
  const { describeField: describe, ...rest } = options;
  return describe
    ? { ...rest, describeField: (field: ResolvedOperationField) => describe(field as CompiledField) }
    : rest;
}

/** Project one resolved entity field into deterministic JSON Schema. */
export function compiledFieldSchemaWithoutDefinitions(
  field: CompiledField,
  referentiedata: CoreReferentiedataSnapshot = {},
  options: CompiledFieldSchemaOptions = {},
): JsonObject {
  return fieldSchema(field, compiledRegistry(referentiedata), projectorOptions(options));
}

/** Project one resolved entity field and bundle reusable definitions at the schema root. */
export function compiledFieldSchema(
  field: CompiledField,
  referentiedata: CoreReferentiedataSnapshot = {},
  options: CompiledFieldSchemaOptions = {},
): JsonObject {
  return bundleFieldDefinitionSchema(
    compiledFieldSchemaWithoutDefinitions(field, referentiedata, options),
  );
}

/** Project a resolved field list into an object request/value schema. */
export function compiledObjectSchema(
  fields: CompiledField[],
  referentiedata: CoreReferentiedataSnapshot = {},
  options: { requireRequired: boolean } & CompiledFieldSchemaOptions,
): JsonObject {
  const { requireRequired, ...rest } = options;
  return bundleFieldDefinitionSchema(
    objectSchema(fields, compiledRegistry(referentiedata), { ...projectorOptions(rest), requireRequired }),
  );
}

export type FieldSchemaCompiler = {
  /** Resolve semantic defaults and nested fields exactly like entity compilation. */
  compile(fields: readonly FieldDefinition[]): CompiledField[];
  /** Compile and project one authored field to its complete value schema. */
  field(field: FieldDefinition, options?: CompiledFieldSchemaOptions): JsonObject;
  /** Compile and project an authored field list to a strict object schema. */
  object(
    fields: readonly FieldDefinition[],
    options?: CompiledFieldSchemaOptions & { requireRequired?: boolean },
  ): JsonObject;
};

/**
 * Bind the canonical field compiler to the resolved authoring catalogs once.
 * Compiler plugins use this build-time capability instead of implementing a
 * second FieldDefinition-to-JSON-Schema normalizer.
 */
export function createFieldSchemaCompiler(input: {
  componentCatalog: ComponentCatalog;
  osfTypes?: Record<string, OsfTypeDefinition>;
  referentiedata?: CoreReferentiedataSnapshot;
}): FieldSchemaCompiler {
  const registry = runtimeFieldSchemaRegistry(input);
  // Preserve compiler-only metadata while using the same type, cardinality
  // and validation normalization as field() and object(). Model resolution
  // needs these defaults before it chooses renderers, including nested ones.
  const normalizeModelFields = (
    fields: readonly FieldDefinition[],
    resolved: readonly ResolvedOperationField[],
  ): Field[] => fields.map((field, index) => {
    const normalized = resolved[index]!;
    const semantic = osfTypeDefinitionOf(field.osfType, input.osfTypes ?? {});
    const result: Field = {
      ...field,
      baseType: normalized.baseType,
      cardinality: normalized.cardinalityBounds ?? normalized.cardinality,
      required: normalized.required,
      ...(normalized.validation ? { validation: normalized.validation as NonNullable<Field["validation"]> } : {}),
    };
    const children = field.shape ?? field.children ?? semantic?.shape ?? semantic?.children;
    if (children && normalized.children) {
      result.children = normalizeModelFields(children, normalized.children);
      if (field.shape) result.shape = result.children;
    }
    const item = field.item ?? semantic?.item;
    if (item && normalized.item) {
      result.item = normalizeModelFields([item], [normalized.item])[0]!;
    }
    return result;
  });
  const compile = (fields: readonly FieldDefinition[]) =>
    resolveModelFields(
      normalizeModelFields(
        fields,
        resolveFields(fields as unknown as readonly OperationFieldDefinition[], registry),
      ),
      input.componentCatalog,
      input.osfTypes,
    );
  return {
    compile,
    field: (field, options = {}) =>
      operationFieldSchema(
        field as unknown as OperationFieldDefinition,
        registry,
        projectorOptions(options),
      ),
    object: (fields, options = {}) => {
      const { requireRequired, ...rest } = options;
      return operationFieldObjectSchema(
        fields as unknown as readonly OperationFieldDefinition[],
        registry,
        { ...projectorOptions(rest), ...(requireRequired !== undefined ? { requireRequired } : {}) },
      );
    },
  };
}
