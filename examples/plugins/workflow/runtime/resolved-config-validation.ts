// SPDX-License-Identifier: BUSL-1.1
import { z, type ZodType } from "zod";
import { getCatalogEntry } from "./node-catalog-store.js";
import {
  canonicalizeFieldAliases as canonicalizeAliasesOnRecord,
  readFieldAliasSources,
} from "./field-aliases.js";

type JsonRecord = Record<string, unknown>;

type RuntimeField = {
  key: string;
  valueType: string;
  cardinality?: RuntimeCardinality;
  required?: boolean;
  readOnly?: boolean;
  defaultValue?: unknown;
  validation?: JsonRecord;
  variables?: string;
  runtime?: {
    aliases?: string[];
    required?: boolean;
  };
  children?: unknown;
  shape?: unknown;
  item?: unknown;
};

type RuntimeCardinality =
  | string
  | {
      min?: number;
      max?: number | "unbounded";
    };

export type ResolvedConfigValidationIssue = {
  path: string;
  code: string;
  message: string;
};

export type ResolvedConfigValidationResult =
  | { ok: true; value: JsonRecord }
  | {
      ok: false;
      value: JsonRecord;
      issues: ResolvedConfigValidationIssue[];
    };

const schemaCache = new Map<string, ZodType<JsonRecord>>();

export function validateResolvedWorkflowNodeConfig(
  nodeType: string,
  resolvedConfig: JsonRecord,
): ResolvedConfigValidationResult {
  const schema = getResolvedConfigSchema(nodeType);
  if (!schema) return { ok: true, value: resolvedConfig };

  const fields = getConfigFields(nodeType);
  const canonicalConfig = canonicalizeFieldAliases(resolvedConfig, fields);
  const defaultedConfig = applyFieldDefaults(canonicalConfig, fields);
  const result = schema.safeParse(defaultedConfig);
  if (result.success) {
    return { ok: true, value: result.data };
  }

  return {
    ok: false,
    value: defaultedConfig,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "$",
      code: issue.code,
      message: issue.message,
    })),
  };
}

/**
 * A stored config with its aliased keys moved onto the canonical ones, using
 * the catalog's own `runtime.aliases`.
 *
 * Exported because definition validation has to read a node's config the way
 * the bridge will eventually see it, and the two see different documents: a
 * bridge is handed the config that came back from
 * {@link validateResolvedWorkflowNodeConfig}, which has been through the alias
 * map above, while validation reads the raw stored graph. A decision authored
 * with `conditions` therefore looked empty to the validator and full to the
 * bridge — so an unwired branch raised nothing and a correctly wired one was
 * reported as an edge to a handle the node never emits.
 *
 * Reusing the same function rather than restating the alias list is the point:
 * a node type that gains an alias in its YAML must not need a second edit here
 * to stay checkable.
 *
 * This closes the alias half of the gap and not the rest of it. Validation
 * reads a STORED config and the bridge reads a RESOLVED one, so anything the
 * process runtime substitutes still diverges — a `{{ template }}` in
 * `defaultEdgeId` or in a branch's handle resolves to a value only the run
 * knows, and no amount of reading the document will predict it.
 */
export function canonicalizeWorkflowNodeConfigAliases(
  nodeType: string,
  config: unknown,
): JsonRecord {
  return canonicalizeFieldAliases(asRecord(config), getConfigFields(nodeType));
}

/**
 * The same mapping, over config fields the caller already holds.
 *
 * The function above resolves a node type through the catalog store, which is
 * hydrated from Postgres and THROWS when it is not — see
 * `node-catalog-store.ts` on why an unhydrated read must not degrade quietly.
 * That makes it unusable anywhere outside the API process, and the designer is
 * outside it: a canvas has to derive a decision node's ports from the same
 * canonical config the bridge will be handed, in a browser, with no store to
 * read.
 *
 * So the catalog's own records are the input instead. They are the same records
 * `WorkflowNodeType.configFields` puts on the wire, which is where a client
 * gets them. Sharing this rather than restating the alias rule is the point:
 * a node type that gains an alias in its YAML must not need a second edit
 * anywhere to keep the two sides agreeing.
 */
export function canonicalizeWorkflowNodeConfigAliasesFromFields(
  config: unknown,
  configFields: unknown,
): JsonRecord {
  return canonicalizeAliasesOnRecord(asRecord(config), readFieldAliasSources(configFields));
}

export function formatResolvedConfigValidationIssues(
  issues: ResolvedConfigValidationIssue[],
): string {
  if (issues.length === 0) return "Workflow node config is invalid.";
  return issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ");
}

export function getResolvedConfigSchema(nodeType: string): ZodType<JsonRecord> | null {
  const fields = getConfigFields(nodeType);
  if (!fields) return null;

  const cached = schemaCache.get(nodeType);
  if (cached) return cached;

  const schema = z.object(fieldShape(fields)).passthrough() as ZodType<JsonRecord>;
  schemaCache.set(nodeType, schema);
  return schema;
}

function getConfigFields(nodeType: string): RuntimeField[] | null {
  const entry = getCatalogEntry(nodeType);
  if (!entry || !Array.isArray(entry.configFields)) return null;
  return normalizeFields(entry.configFields);
}

function fieldShape(fields: RuntimeField[]): Record<string, ZodType<unknown>> {
  const shape: Record<string, ZodType<unknown>> = {};
  for (const field of fields) {
    shape[field.key] = fieldSchema(field);
  }
  return shape;
}

function fieldSchema(field: RuntimeField): ZodType<unknown> {
  const schema = isCollectionField(field)
    ? collectionSchema(field)
    : singleValueSchema(field);

  return isRuntimeRequired(field) ? schema : schema.nullish();
}

function collectionSchema(field: RuntimeField): ZodType<unknown> {
  const itemField = normalizeField(field.item) ?? {
    ...field,
    cardinality: "single",
    key: "item",
  };
  let schema = z.array(singleValueSchema(itemField));
  const { min, max } = structuredCardinalityBounds(field.cardinality);
  if (min !== null) schema = schema.min(min);
  if (max !== null) schema = schema.max(max);
  const valueSchema = allowsWholeValueBinding(field)
    ? z.union([schema, z.string()])
    : schema;
  return z.preprocess(blankStringToUndefined, valueSchema.optional());
}

function singleValueSchema(field: RuntimeField): ZodType<unknown> {
  const validation = asRecord(field.validation);
  switch (field.valueType) {
    case "string":
    case "date":
    case "datetime":
      return stringSchema(validation, field);
    case "number":
      return numberSchema(validation, false);
    case "integer":
      return numberSchema(validation, true);
    case "boolean":
      return booleanSchema();
    case "object":
      return objectSchema(field);
    default:
      return z.unknown();
  }
}

function stringSchema(validation: JsonRecord, field: RuntimeField): ZodType<unknown> {
  let schema = z.string();

  const minLength = asNumber(validation.minLength ?? validation.min);
  if (minLength !== null) schema = schema.min(minLength);

  const maxLength = asNumber(validation.maxLength ?? validation.max);
  if (maxLength !== null) schema = schema.max(maxLength);

  const format = asString(validation.format);
  if (format === "uuid") schema = schema.uuid();
  if (format === "email") schema = schema.email();

  const pattern = asString(validation.pattern);
  if (pattern) {
    schema = schema.regex(new RegExp(pattern));
  }

  if (!field.readOnly) return schema;

  return z.preprocess((value) => {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return value;
  }, schema);
}

function numberSchema(validation: JsonRecord, integer: boolean): ZodType<unknown> {
  let schema = z.number().finite();
  if (integer) schema = schema.int();

  const min = asNumber(validation.min ?? validation.minimum);
  if (min !== null) schema = schema.min(min);

  const max = asNumber(validation.max ?? validation.maximum);
  if (max !== null) schema = schema.max(max);

  return z.preprocess((value) => {
    if (typeof value === "string" && value.trim() === "") {
      return undefined;
    }
    if (typeof value === "string" && value.trim() !== "") {
      return Number(value);
    }
    return value;
  }, schema.optional());
}

function booleanSchema(): ZodType<unknown> {
  return z.preprocess((value) => {
    if (typeof value === "string" && value.trim() === "") return undefined;
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }, z.boolean().optional());
}

function objectSchema(field: RuntimeField): ZodType<unknown> {
  const children = nestedFields(field);
  const schema = children.length > 0
    ? z.object(fieldShape(children)).passthrough()
    : z.record(z.string(), z.unknown());
  const valueSchema = allowsWholeValueBinding(field)
    ? z.union([schema, z.string()])
    : schema;
  return z.preprocess(blankStringToUndefined, valueSchema.optional());
}

function blankStringToUndefined(value: unknown): unknown {
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}

function allowsWholeValueBinding(field: RuntimeField): boolean {
  return field.variables === "whole" || field.variables === "both";
}

function applyFieldDefaults(config: JsonRecord, fields: RuntimeField[] | null): JsonRecord {
  if (!fields) return config;
  const next: JsonRecord = { ...config };

  for (const field of fields) {
    if (next[field.key] === undefined && field.defaultValue !== undefined) {
      next[field.key] = cloneDefault(field.defaultValue);
    }

    if (isCollectionField(field) && Array.isArray(next[field.key])) {
      const itemField = normalizeField(field.item) ?? field;
      next[field.key] = (next[field.key] as unknown[]).map((item) => {
        if (!isRecord(item)) return item;
        return applyFieldDefaults(item, nestedFields(itemField));
      });
      continue;
    }

    const objectValue = next[field.key];
    if (field.valueType === "object" && isRecord(objectValue)) {
      next[field.key] = applyFieldDefaults(
        objectValue,
        nestedFields(field),
      );
    }
  }

  return next;
}

function isRuntimeRequired(field: RuntimeField): boolean {
  return field.runtime?.required === true;
}

/**
 * Delegates to `field-aliases.ts`, which has no imports and is therefore safe
 * to bundle for a browser. The designer shares that module, so a config reads
 * the same here and on a canvas rather than through two derivations that can
 * drift — which is the failure this rewriting exists to prevent in the first
 * place.
 */
function canonicalizeFieldAliases(config: JsonRecord, fields: RuntimeField[] | null): JsonRecord {
  if (!fields) return config;
  return canonicalizeAliasesOnRecord(
    config,
    fields.flatMap((field) =>
      field.runtime?.aliases?.length
        ? [{ key: field.key, aliases: field.runtime.aliases }]
        : [],
    ),
  );
}

function normalizeFields(value: unknown): RuntimeField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const field = normalizeField(entry);
    return field ? [field] : [];
  });
}

function normalizeField(value: unknown): RuntimeField | null {
  if (!isRecord(value)) return null;
  const key = asString(value.key);
  const valueType = asString(value.valueType);
  if (!key || !valueType) return null;
  const field: RuntimeField = {
    key,
    valueType,
    defaultValue: value.defaultValue,
    validation: asRecord(value.validation),
    shape: value.shape,
    children: value.children,
    item: value.item,
  };
  if (typeof value.readOnly === "boolean") field.readOnly = value.readOnly;
  const runtime = normalizeRuntimeMetadata(value.runtime);
  if (runtime) field.runtime = runtime;
  const variables = asString(value.variables);
  if (variables) field.variables = variables;
  const cardinality = normalizeCardinality(value.cardinality);
  if (cardinality) field.cardinality = cardinality;
  if (typeof value.required === "boolean") field.required = value.required;
  return field;
}

function nestedFields(field: RuntimeField): RuntimeField[] {
  const shape = normalizeFields(field.shape);
  return shape.length > 0 ? shape : normalizeFields(field.children);
}

function isCollectionField(field: RuntimeField): boolean {
  if (field.cardinality === "collection") return true;
  if (!isRecord(field.cardinality)) return false;
  if (field.cardinality.max === "unbounded") return true;
  return typeof field.cardinality.max === "number" && field.cardinality.max > 1;
}

function structuredCardinalityBounds(
  cardinality: RuntimeCardinality | undefined,
): { min: number | null; max: number | null } {
  if (!isRecord(cardinality)) return { min: null, max: null };
  return {
    min: typeof cardinality.min === "number" && Number.isInteger(cardinality.min)
      ? cardinality.min
      : null,
    max: typeof cardinality.max === "number" && Number.isInteger(cardinality.max)
      ? cardinality.max
      : null,
  };
}

function normalizeCardinality(value: unknown): RuntimeCardinality | undefined {
  const legacy = asString(value);
  if (legacy) return legacy;
  if (!isRecord(value)) return undefined;
  const cardinality: Exclude<RuntimeCardinality, string> = {};
  if (typeof value.min === "number" && Number.isInteger(value.min) && value.min >= 0) {
    cardinality.min = value.min;
  }
  if (value.max === "unbounded") {
    cardinality.max = "unbounded";
  } else if (typeof value.max === "number" && Number.isInteger(value.max) && value.max >= 0) {
    cardinality.max = value.max;
  }
  return Object.keys(cardinality).length > 0 ? cardinality : undefined;
}

function normalizeRuntimeMetadata(value: unknown): RuntimeField["runtime"] | undefined {
  if (!isRecord(value)) return undefined;
  const aliases = Array.isArray(value.aliases)
    ? value.aliases.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : undefined;
  const runtime: NonNullable<RuntimeField["runtime"]> = {};
  if (aliases && aliases.length > 0) runtime.aliases = aliases;
  if (typeof value.required === "boolean") runtime.required = value.required;
  return Object.keys(runtime).length > 0 ? runtime : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  if (isRecord(value) && "value" in value) {
    return asNumber(value.value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function cloneDefault(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  return structuredClone(value);
}
