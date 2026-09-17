// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationContext, ModuleOperationHandler, RuntimeEntityValueCarrier, RuntimeEntityValueDefinition } from "@openshapeforge/plugin-runtime";
import { contextServices, rows } from "./commands.js";
import { materializeTemplateContent } from "./content/materialize.js";
import { templateSnapshotContent } from "./content-snapshot.js";
import { immutableContent, type JsonObject, type JsonValue } from "./content/json.js";
import { TemplateContentError } from "./content/errors.js";
import type { ContentBlockMaterialization, ContentField, ContentTemplateVersion, ContentValueShape, TemplateParameter } from "./content/types.js";

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function refuse(code: string, message: string): never { throw operationFailure({ code, message, retryable: false }); }
function object(value: unknown, name: string): Record<string, unknown> {
  if (!isObject(value)) refuse("VALIDATION", `${name} must be an object.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) refuse("VALIDATION", `${name} is required.`);
  return value as string;
}
function uuid(value: unknown, name: string): string {
  const id = text(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) refuse("VALIDATION", `${name} must be a UUID.`);
  return id;
}
/** Persisted column of the Block entity's `definitionVersion` field (entities/core/block.yaml). */
const DEFINITION_VERSION_COLUMN = "definition_version";

function contentCarrier(context: ModuleOperationContext): RuntimeEntityValueCarrier {
  const { platform } = contextServices(context);
  const carrier = platform.schemas.entityValues?.get("Block", "values");
  if (!carrier) refuse("OPERATION_UNAVAILABLE", "Compiled block definitions are unavailable.");
  return carrier!;
}
function definition(carrier: RuntimeEntityValueCarrier, name: string): RuntimeEntityValueDefinition {
  const found = Object.hasOwn(carrier.definitions, name) ? carrier.definitions[name] : undefined;
  if (!found) refuse("BLOCK_UNKNOWN", "The block definition is not available in this application.");
  return found!;
}

/** Canonical value constraints remain in valueSchema; this is only the snapshot DTO. */
export function contentFieldProjection(field: Readonly<Record<string, unknown>>): ContentField {
  const valueType = field.valueType;
  if (typeof valueType !== "string" || !["string", "integer", "number", "boolean", "date", "datetime", "object"].includes(valueType)) refuse("INVALID_DEFINITION", "A block field has no resolved base type.");
  const nested = Array.isArray(field.children) ? field.children : undefined;
  const relationship = isObject(field.relationship) && typeof field.relationship.target === "string" ? { target: field.relationship.target } : undefined;
  return {
    valueType: valueType as ContentField["valueType"],
    ...(typeof field.semanticType === "string" ? { semanticType: field.semanticType } : {}),
    required: field.required === true,
    cardinality: (field.cardinalityBounds ?? field.cardinality ?? "single") as NonNullable<ContentField["cardinality"]>,
    ...(nested ? { fields: Object.fromEntries(nested.map((child) => { const shape = object(child, "field"); return [text(shape.key, "field key"), contentFieldProjection(shape)]; })) } : {}),
    ...(relationship ? { relationship } : {}),
  };
}

function validatedValues(context: ModuleOperationContext, name: string, value: unknown): JsonObject {
  const { platform } = contextServices(context);
  const entry = definition(contentCarrier(context), name);
  const values = object(value, "values");
  const result = platform.schemas.json.validate(entry.valueSchema, values);
  if (!result.valid) throw operationFailure(result.error);
  return immutableContent(values) as JsonObject;
}

/** One handler serves any value-only block entity; no entity-name switch or private registry. */
export const materializeFields: ModuleOperationHandler = async (input, context) => {
  const name = text(input.definitionKey, "definitionKey");
  const entry = definition(contentCarrier(context), name);
  if (entry.references.length) refuse("OPERATION_UNAVAILABLE", "A referenced block requires its authored materialization Operation.");
  return { value: { kind: "block", value: validatedValues(context, name, input.values) } };
};

/** Returns an inclusion directive. The shared engine owns recursion and cycle limits. */
export const composeTemplate: ModuleOperationHandler = async (input, context) => {
  const name = text(input.definitionKey, "definitionKey");
  const entry = definition(contentCarrier(context), name);
  const referenceField = text(input.referenceField, "referenceField");
  const parametersField = text(input.parametersField, "parametersField");
  const slot = entry.references.find((reference) => reference.fieldKey === referenceField);
  if (!slot || slot.targetEntity !== "TemplateVersion") refuse("INVALID_DEFINITION", "Template inclusion requires a typed template-version reference.");
  const references = object(input.references, "references");
  const reference = object(references[referenceField], "template reference");
  uuid(reference.id, "template reference");
  if (reference.entity !== "TemplateVersion") refuse("DEPENDENCY_INVALID", "Template inclusion refers to another entity type.");
  const values = validatedValues(context, name, input.values);
  const parameters = object(values[parametersField] ?? {}, "parameters");
  return { value: { kind: "template", referenceField, parameters } };
};

/** Convert a canonical parameter schema to the engine's structural projection. */
function parameterShape(schema: Record<string, unknown>, required: boolean): TemplateParameter {
  if (schema.type === "array") {
    const item = parameterShape(object(schema.items, "parameter items"), false);
    return { ...item, required, cardinality: {
      min: typeof schema.minItems === "number" ? schema.minItems : 0,
      max: typeof schema.maxItems === "number" ? schema.maxItems : "unbounded",
    }, ...(schema.default !== undefined ? { defaultValue: schema.default as JsonValue } : {}) };
  }
  const valueType = schema.type === "string" && schema.format === "date" ? "date"
    : schema.type === "string" && schema.format === "date-time" ? "datetime" : schema.type;
  if (typeof valueType !== "string" || !["string", "integer", "number", "boolean", "date", "datetime", "object"].includes(valueType)) refuse("INVALID_DEFINITION", "The template parameter shape is unsupported.");
  const requiredKeys = Array.isArray(schema.required) ? schema.required : [];
  return {
    valueType: valueType as ContentValueShape["valueType"], required,
    ...(isObject(schema["x-osf-reference"]) && typeof schema["x-osf-reference"].entity === "string" ? { relationship: { target: schema["x-osf-reference"].entity } } : {}),
    ...(Array.isArray(schema.enum) ? { enum: schema.enum as JsonValue[] } : {}),
    ...(isObject(schema.properties) ? { fields: Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [name, parameterShape(object(child, "parameter"), requiredKeys.includes(name))])) } : {}),
    ...(schema.default !== undefined ? { defaultValue: schema.default as JsonValue } : {}),
  };
}

export const materializeTemplate: ModuleOperationHandler = async (input, context) => {
  const { platform, session } = contextServices(context);
  if (!session.tenantId) refuse("UNAUTHENTICATED", "Template materialization requires a tenant session.");
  const tenantId = session.tenantId!;
  const templateVersionId = uuid(input.templateVersionId, "templateVersionId");
  const channel = text(input.channel, "channel");
  const locale = text(input.locale, "locale");
  const carrier = contentCarrier(context);
  const collection = platform.schemas.entityValues?.collection("TemplateVariant", "blocks");
  if (!collection || collection.targetEntity !== carrier.entityName) refuse("INVALID_DEFINITION", "The compiled template block collection is unavailable.");
  const operationDefinitions = await platform.operations.list(session);
  const registry = Object.fromEntries(await Promise.all(Object.entries(carrier.definitions).map(async ([key, entry]) => {
    const operation = entry.materializeOperationId ? await platform.operations.get(session, entry.materializeOperationId) : undefined;
    return [key, {
    entityName: entry.entityName, schemaVersion: 1,
    source: immutableContent(entry) as unknown as JsonObject,
    ...(operation?.output?.kind === "json-schema"
      ? { materializationSchema: immutableContent(operation.output.schema) as JsonObject }
      : {}),
    fields: Object.fromEntries(entry.fields.map((field) => [text(field.key, "field key"), contentFieldProjection(field)])),
    // Generic field output is available on these channels. A domain Operation
    // can refuse a channel; no renderer is allowed to silently drop a block.
    renderers: { document: "entityFields", email: "entityFields", whatsapp: "entityFields" },
    }];
  })));
  const parameterFields = new Map<string, readonly Record<string, unknown>[]>();
  const authorized = (entityName: string, id: string) => platform.records.assertAccess(session, { entityName, id, intent: "get" });
  // Record access alone does not redact classified fields. All content must
  // come from the canonical read result, including logical entity-value refs.
  const read = async (entityName: string, id: string) => {
    await authorized(entityName, id);
    const matches = operationDefinitions.filter((operation) => operation.entityName === entityName && operation.intent === "get");
    if (matches.length !== 1 || matches[0]!.effects.data !== "read" || matches[0]!.effects.external !== "none") refuse("OPERATION_UNAVAILABLE", "A source has no unambiguous canonical read Operation.");
    const result = await platform.operations.execute(session, { operation: matches[0]!, input: { id } });
    if ("error" in result) throw operationFailure(result.error);
    if (result.data == null) return null;
    const row = object(result.data, "source record");
    if (row.id !== id || row.tenantId !== tenantId) refuse("DEPENDENCY_INVALID", "The source read returned a different record or tenant.");
    return row;
  };
  try {
    const snapshot = await platform.db.withSession(session, async (trx) => materializeTemplateContent({
      tenantId, templateVersionId, channel, locale,
      ...(input.parameters === undefined ? {} : { parameters: immutableContent(object(input.parameters, "parameters")) as JsonObject }),
    }, registry, {
      async resolveTemplateVersion(id): Promise<ContentTemplateVersion | null> {
        uuid(id, "template version");
        // The version row is the only live read: it is immutable, so sharing
        // it pins nothing that can change. Variants and blocks come from the
        // frozen snapshot on that row, never from their live tables, which may
        // have been edited or deleted since publish.
        const locked = (await rows<{ id: string }>(trx,
          "select id from erp.template_versions where tenant_id = $1 and id = $2 for share", [tenantId, id]))[0];
        if (!locked) return null;
        const version = await read("TemplateVersion", id);
        if (!version) return null;
        const templateId = uuid(version.template, "template");
        await authorized("Template", templateId);
        const frozen = templateSnapshotContent(version.snapshot, {
          tenantId, templateId, channel, locale, carrier, allowedDefinitions: collection!.allowedDefinitions, definitionVersionColumn: DEFINITION_VERSION_COLUMN,
        });
        parameterFields.set(id, frozen.parameterFields);
        const parameterSchema = platform.schemas.fields.object(frozen.parameterFields);
        const properties = object(parameterSchema.properties ?? {}, "parameter properties");
        const required = Array.isArray(parameterSchema.required) ? parameterSchema.required : [];
        const parameters = Object.fromEntries(Object.entries(properties).map(([name, schema]) => [name, parameterShape(object(schema, "parameter schema"), required.includes(name))]));
        return { id, tenantId, templateId, versionNumber: Number(version.versionNumber), parameters, variants: frozen.variants };
      },
      async resolveGlobalVariable(key) {
        const found = (await rows<{ id: string }>(trx,
          "select id from erp.chips where tenant_id = $1 and key = $2 for share", [tenantId, key]))[0];
        if (!found) return null;
        const chip = await read("Chip", uuid(found.id, "chip id"));
        if (!chip || chip.key !== key || typeof chip.value !== "string") return null;
        return { tenantId, sourceId: found.id, sourceVersionId: `${found.id}@${text(chip.updatedAt, "chip version")}`, value: chip.value };
      },
      async resolveEntity(reference) {
        const row = await read(reference.entity, reference.id);
        if (!row) return null;
        const version = text(row.updatedAt, "referenced record version");
        return { tenantId, entity: reference.entity, id: uuid(row.id, "referenced record"), versionId: version, value: immutableContent(row) as JsonObject };
      },
      validateParameters(version, values) {
        const fields = parameterFields.get(version.id);
        if (!fields) refuse("INVALID_DEFINITION", "Template parameter definitions are unavailable.");
        const valid = platform.schemas.fields.validateObject(fields!, values);
        if (!valid.valid) throw operationFailure(valid.error);
      },
      validateBlockValues(name, values) { validatedValues(context, name, values); },
      async materializeBlock(block): Promise<ContentBlockMaterialization> {
        const entry = definition(carrier, block.definitionKey);
        if (!entry.materializeOperationId) refuse("OPERATION_UNAVAILABLE", "The block has no authored materialization Operation.");
        const operation = await platform.operations.get(session, entry.materializeOperationId!);
        if (!operation || operation.effects.data !== "read" || operation.effects.external !== "none") refuse("OPERATION_UNAVAILABLE", "The block materialization Operation is unavailable or has write effects.");
        if (operation!.input.kind !== "json-schema") refuse("INVALID_DEFINITION", "Block materialization requires a canonical JSON-schema Operation input.");
        const schema = object(operation!.input.schema, "Operation input schema");
        const propertySchemas = object(schema.properties ?? {}, "Operation input properties");
        const available: Record<string, unknown> = { definitionKey: block.definitionKey, values: block.values, references: block.references, channel, locale };
        const values = Object.fromEntries(Object.entries(propertySchemas).flatMap(([name, raw]) => {
          const property = object(raw, "Operation input property");
          if (Object.hasOwn(property, "const")) return [[name, property.const]];
          return Object.hasOwn(available, name) ? [[name, available[name]]] : [];
        }));
        const result = await platform.operations.execute(session, { operation: operation!, input: values });
        if ("error" in result) throw operationFailure(result.error);
        return { operationId: operation!.id, result: immutableContent(object(result.data, "materialization result")) as ContentBlockMaterialization["result"] };
      },
    }));
    return { value: snapshot };
  } catch (error) {
    if (error instanceof TemplateContentError) throw operationFailure({ code: error.code, message: error.message, retryable: false });
    throw error;
  }
};
