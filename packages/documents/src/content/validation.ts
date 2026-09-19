// SPDX-License-Identifier: BUSL-1.1
import { contentError } from "./errors.js";
import {
  canonicalJson,
  CONTENT_LIMITS,
  immutableContent,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import type {
  CompiledContentBlockDefinition,
  CompiledContentBlockRegistry,
  ContentBlock,
  ContentEntityReference,
  ContentField,
  ContentTemplateVersion,
  ContentValueShape,
  TemplateParameter,
} from "./types.js";

export function assertContentRecord(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    contentError("INVALID_VALUE", `${field} must be an object.`);
  }
}

export function assertContentName(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > 255
  ) {
    contentError(
      "INVALID_VALUE",
      `${field} must be a non-empty, bounded identifier without surrounding whitespace.`,
    );
  }
}

function exactKeys(record: object, allowed: readonly string[], field: string) {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    contentError("INVALID_VALUE", `${field} contains unsupported fields.`);
  }
}

export function contentCardinality(shape: ContentValueShape) {
  const bounds = shape.cardinality;
  if (bounds === "collection")
    return { collection: true, min: shape.required ? 1 : 0, max: Infinity };
  if (bounds === undefined || bounds === "single")
    return { collection: false, min: shape.required ? 1 : 0, max: 1 };
  if (!bounds || typeof bounds !== "object")
    contentError("INVALID_VALUE", "Invalid field cardinality.");
  const min = bounds.min ?? 0;
  const max = bounds.max ?? 1;
  if (
    !Number.isSafeInteger(min) ||
    min < 0 ||
    (max !== "unbounded" && (!Number.isSafeInteger(max) || max < Math.max(1, min)))
  ) {
    contentError("INVALID_VALUE", "Invalid field cardinality.");
  }
  return {
    collection: max === "unbounded" || max > 1,
    min: Math.max(min, shape.required ? 1 : 0),
    max: max === "unbounded" ? Infinity : max,
  };
}

function validateShape(shape: ContentValueShape) {
  assertContentRecord(shape, "field metadata");
  if (
    !["string", "integer", "number", "boolean", "date", "datetime", "object"].includes(
      shape.baseType,
    )
  ) {
    contentError("INVALID_VALUE", "Field metadata requires a resolved baseType.");
  }
  contentCardinality(shape);
  if (shape.fields) {
    if (shape.baseType !== "object")
      contentError("INVALID_VALUE", "Only object fields may declare nested fields.");
    assertContentRecord(shape.fields, "nested field metadata");
    for (const nested of Object.values(shape.fields)) validateShape(nested);
  }
  if (shape.enum !== undefined && (!Array.isArray(shape.enum) || shape.enum.length === 0)) {
    contentError("INVALID_VALUE", "Field enum must contain values.");
  }
}

function validateScalar(value: JsonValue, shape: ContentValueShape, field: string) {
  const validDate = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
  const valid =
    shape.baseType === "object"
      ? typeof value === "object" && value !== null && !Array.isArray(value)
      : shape.baseType === "integer"
        ? Number.isSafeInteger(value)
        : shape.baseType === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : shape.baseType === "date"
            ? typeof value === "string" && validDate(value)
            : shape.baseType === "datetime"
              ? typeof value === "string" &&
                validDate(value.slice(0, 10)) &&
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
                  value,
                ) &&
                Number.isFinite(Date.parse(value))
              : typeof value === shape.baseType;
  if (!valid) contentError("INVALID_VALUE", `${field} must have base type ${shape.baseType}.`);
  if (shape.enum && !shape.enum.some((item) => canonicalJson(item) === canonicalJson(value))) {
    contentError("INVALID_VALUE", `${field} is not an allowed value.`);
  }
  if (shape.fields) validateContentValues(value as JsonObject, shape.fields, field);
}

export function validateContentValue(
  value: JsonValue | undefined,
  shape: ContentValueShape,
  field: string,
): void {
  const cardinality = contentCardinality(shape);
  if (value === undefined) {
    if (cardinality.min > 0) contentError("MISSING_VARIABLE", `${field} is required.`);
    return;
  }
  if (value === null) {
    if (shape.nullable && cardinality.min === 0) return;
    contentError("INVALID_VALUE", `${field} does not accept null.`);
  }
  if (cardinality.collection) {
    if (!Array.isArray(value) || value.length < cardinality.min || value.length > cardinality.max) {
      contentError("INVALID_VALUE", `${field} violates collection cardinality.`);
    }
    for (const item of value) validateScalar(item, shape, field);
  } else validateScalar(value, shape, field);
}

export function validateContentValues(
  values: JsonObject,
  fields: Readonly<Record<string, ContentValueShape>>,
  label = "values",
) {
  assertContentRecord(values, label);
  exactKeys(values, Object.keys(fields), label);
  for (const [key, shape] of Object.entries(fields)) {
    validateContentValue(
      Object.hasOwn(values, key) ? values[key] : undefined,
      shape,
      `${label}.${key}`,
    );
  }
}

export function resolveTemplateParameters(
  definitions: Readonly<Record<string, TemplateParameter>>,
  input: JsonObject,
): JsonObject {
  assertContentRecord(input, "parameters");
  exactKeys(input, Object.keys(definitions), "parameters");
  const result: Record<string, JsonValue> = Object.create(null);
  for (const [key, definition] of Object.entries(definitions)) {
    const value = Object.hasOwn(input, key) ? input[key] : definition.defaultValue;
    validateContentValue(value, definition, `parameters.${key}`);
    if (value !== undefined) result[key] = value;
  }
  return immutableContent(result);
}

export function validateContentRegistry(
  input: CompiledContentBlockRegistry,
): CompiledContentBlockRegistry {
  const registry = immutableContent(input);
  assertContentRecord(registry, "compiled block metadata");
  for (const [key, definition] of Object.entries(registry)) {
    assertContentName(key, "definition key");
    assertContentRecord(definition, key);
    assertContentName(definition.entityName, "definition entity");
    if (!Number.isSafeInteger(definition.schemaVersion) || definition.schemaVersion < 1) {
      contentError("INVALID_VALUE", "Definition schemaVersion must be a positive integer.");
    }
    if (definition.definitionHash !== undefined && !/^[a-f0-9]{64}$/.test(definition.definitionHash)) {
      contentError("INVALID_VALUE", "Definition definitionHash must be a SHA-256 hex digest.");
    }
    assertContentRecord(definition.fields, "definition fields");
    for (const [name, shape] of Object.entries(definition.fields)) {
      assertContentName(name, "field name");
      validateShape(shape);
      if (shape.relationship) assertContentName(shape.relationship.target, "relationship target");
    }
    assertContentRecord(definition.renderers, "definition renderers");
    for (const [channel, renderer] of Object.entries(definition.renderers)) {
      assertContentName(channel, "renderer channel");
      assertContentName(renderer, "renderer identifier");
    }
    if (definition.composition) {
      const composition = definition.composition;
      const reference = definition.fields[composition.templateVersionField];
      if (!reference?.relationship || contentCardinality(reference).collection) {
        contentError(
          "INVALID_VALUE",
          "Template composition requires a single typed template-version relationship.",
        );
      }
      if (composition.parametersField !== undefined) {
        const parameters = definition.fields[composition.parametersField];
        if (
          !parameters ||
          parameters.relationship ||
          parameters.baseType !== "object" ||
          contentCardinality(parameters).collection
        ) {
          contentError("INVALID_VALUE", "Composition parameters must be an embedded object field.");
        }
      }
    }
  }
  return registry;
}

export function validateContentReference(
  value: unknown,
  field: ContentField,
): asserts value is ContentEntityReference {
  assertContentRecord(value, "entity reference");
  exactKeys(value, ["entity", "id", "versionId"], "entity reference");
  assertContentName(value.entity, "reference entity");
  assertContentName(value.id, "reference id");
  if (value.versionId !== undefined) assertContentName(value.versionId, "reference version");
  if (value.entity !== field.relationship?.target)
    contentError(
      "DEPENDENCY_INVALID",
      "Reference entity does not match its declared relationship.",
    );
}

export function validateContentBlockReferences(
  block: ContentBlock,
  definition: CompiledContentBlockDefinition,
) {
  assertContentRecord(block.references, "block references");
  const fields = Object.entries(definition.fields).filter(([, field]) => field.relationship);
  exactKeys(
    block.references,
    fields.map(([key]) => key),
    "block references",
  );
  for (const [key, field] of fields) {
    const value = Object.hasOwn(block.references, key) ? block.references[key] : undefined;
    const cardinality = contentCardinality(field);
    if (value === undefined || value === null) {
      if (cardinality.min > 0)
        contentError("DEPENDENCY_UNRESOLVED", `Required relationship ${key} is missing.`);
      continue;
    }
    if (cardinality.collection) {
      if (
        !Array.isArray(value) ||
        value.length < cardinality.min ||
        value.length > cardinality.max
      ) {
        contentError("INVALID_VALUE", `Relationship ${key} violates collection cardinality.`);
      }
      const identities = new Set<string>();
      for (const reference of value) {
        validateContentReference(reference, field);
        const identity = canonicalJson([reference.entity, reference.id]);
        if (identities.has(identity))
          contentError("DUPLICATE", `Relationship ${key} contains duplicate entities.`);
        identities.add(identity);
      }
    } else validateContentReference(value, field);
  }
}

export function defineContentTemplateVersion(
  input: ContentTemplateVersion,
): ContentTemplateVersion {
  const version = immutableContent(input);
  assertContentRecord(version, "template version");
  exactKeys(
    version,
    ["id", "tenantId", "templateId", "versionNumber", "parameters", "variants"],
    "template version",
  );
  for (const key of ["id", "tenantId", "templateId"] as const)
    assertContentName(version[key], `template version ${key}`);
  if (!Number.isSafeInteger(version.versionNumber) || version.versionNumber < 1)
    contentError("INVALID_VALUE", "Template versionNumber must be positive.");
  assertContentRecord(version.parameters, "template parameters");
  for (const [key, shape] of Object.entries(version.parameters)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key))
      contentError("INVALID_VALUE", "Parameter keys must be safe identifiers.");
    validateShape(shape);
    if (shape.defaultValue !== undefined)
      validateContentValue(shape.defaultValue, shape, `parameter default ${key}`);
  }
  if (!Array.isArray(version.variants) || version.variants.length === 0)
    contentError(
      "INVALID_VALUE",
      "A template version requires at least one channel/locale variant.",
    );
  const ids = new Set<string>();
  const keys = new Set<string>();
  const defaults = new Set<string>();
  for (const variant of version.variants) {
    assertContentRecord(variant, "variant");
    exactKeys(variant, ["id", "channel", "locale", "default", "blocks", "allowedDefinitions"], "variant");
    assertContentName(variant.id, "variant id");
    assertContentName(variant.channel, "variant channel");
    assertContentName(variant.locale, "variant locale");
    if (variant.default !== undefined && typeof variant.default !== "boolean")
      contentError("INVALID_VALUE", "Variant default must be a boolean.");
    const key = canonicalJson([variant.channel, variant.locale]);
    if (ids.has(variant.id) || keys.has(key))
      contentError(
        "DUPLICATE",
        "Variant ids and channel/locale pairs must be unique within a version.",
      );
    if (variant.default) {
      if (defaults.has(variant.channel))
        contentError("DUPLICATE", "A channel has at most one default variant.");
      defaults.add(variant.channel);
    }
    ids.add(variant.id);
    keys.add(key);
    if (!Array.isArray(variant.blocks) || variant.blocks.length > CONTENT_LIMITS.blocks)
      contentError("CONTENT_LIMIT_EXCEEDED", "Invalid block collection or block count.");
    if (
      variant.allowedDefinitions !== undefined &&
      (!Array.isArray(variant.allowedDefinitions) ||
        variant.allowedDefinitions.some((key) => typeof key !== "string"))
    ) {
      contentError("INVALID_VALUE", "Allowed definitions must be a list of definition keys.");
    }
    const blockIds = new Set<string>();
    for (const block of variant.blocks) {
      assertContentRecord(block, "block");
      exactKeys(block, ["id", "definitionKey", "schemaVersion", "values", "references"], "block");
      assertContentName(block.id, "block id");
      assertContentName(block.definitionKey, "block definition");
      if (
        typeof block.schemaVersion !== "number" ||
        !Number.isSafeInteger(block.schemaVersion) ||
        block.schemaVersion < 1
      )
        contentError("INVALID_VALUE", "Invalid block schemaVersion.");
      assertContentRecord(block.values, "block values");
      assertContentRecord(block.references, "block references");
      if (blockIds.has(block.id))
        contentError("DUPLICATE", "Block ids must be unique within their collection.");
      blockIds.add(block.id);
    }
  }
  return version;
}

/** The language subtag of a locale: `nl-NL` and `nl_NL` are both `nl`. */
export function contentLanguage(locale: string): string {
  return locale.trim().replace(/_/g, "-").split("-")[0]!.toLowerCase();
}

/**
 * The variant a channel serves for a locale: the exact locale, else a variant
 * of the same language (`nl` for `nl-NL`: the bare language first, then the
 * authored default if it is one of them, then the lowest locale), else the
 * channel's authored default. The choice depends on the variants alone, never
 * on the order they arrived in, so a frozen template and a live document
 * agree. A channel without any of those is an error, never a silent switch
 * to another language; another channel never is.
 */
export function selectContentTemplateVariant(
  version: ContentTemplateVersion,
  channel: string,
  locale: string,
) {
  const channels = version.variants.filter((variant) => variant.channel === channel);
  if (!channels.length) contentError("UNSUPPORTED_CHANNEL", `Template has no ${channel} variant.`);
  const language = contentLanguage(locale);
  const sameLanguage = channels
    .filter((variant) => contentLanguage(variant.locale) === language)
    .sort((left, right) => left.locale.localeCompare(right.locale, "en"));
  const variant =
    channels.find((variant) => variant.locale === locale) ??
    sameLanguage.find((variant) => variant.locale === language) ??
    sameLanguage.find((variant) => variant.default) ??
    sameLanguage[0] ??
    channels.find((variant) => variant.default);
  if (!variant) contentError("UNSUPPORTED_LOCALE", `Template has no ${channel}/${locale} variant and no default ${channel} variant.`);
  return variant;
}
