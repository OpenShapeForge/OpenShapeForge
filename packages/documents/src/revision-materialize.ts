// SPDX-License-Identifier: BUSL-1.1
/**
 * Feeds a DocumentRevision to the pure content engine. The revision is the
 * root "template version": one variant holding the revision's own blocks.
 * Nested TemplateBlock inclusions resolve real template versions from their
 * frozen snapshots, never from live template tables.
 */
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationContext, RuntimeEntityValueCarrier, RuntimeEntityValueDefinition } from "@openshapeforge/plugin-runtime";
import { findChild, rowId } from "@openshapeforge/versioning/snapshot";
import { contextServices, rows } from "./commands.js";
import { contentFieldProjection } from "./content-runtime.js";
import { TemplateContentError } from "./content/errors.js";
import { immutableContent, type JsonObject, type JsonValue } from "./content/json.js";
import { materializeTemplateContent } from "./content/materialize.js";
import type { CompiledContentBlockRegistry, ContentBlock, ContentBlockMaterialization, ContentTemplateVersion, ContentValueShape, MaterializedTemplateContent, TemplateParameter } from "./content/types.js";
import { listRevisionBlocks, readTemplateVersion, templateParameterFields, templateVariantBlocks } from "./revision-blocks.js";
import { fail, object, uuid, type RevisionRow } from "./revision-start.js";

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const VALUE_TYPES = ["string", "integer", "number", "boolean", "date", "datetime", "object"];
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) fail("VALIDATION", `${name} is required.`);
  return value as string;
}
function definition(carrier: RuntimeEntityValueCarrier, name: string): RuntimeEntityValueDefinition {
  const found = Object.hasOwn(carrier.definitions, name) ? carrier.definitions[name] : undefined;
  if (!found) fail("BLOCK_UNKNOWN", "The block definition is not available in this application.");
  return found!;
}

/** Same projection the template materializer uses for a canonical parameter schema. */
function parameterShape(schema: Record<string, unknown>, required: boolean): TemplateParameter {
  if (schema.type === "array") {
    const item = parameterShape(object(schema.items, "parameter items"), false);
    return { ...item, required, cardinality: { min: typeof schema.minItems === "number" ? schema.minItems : 0, max: typeof schema.maxItems === "number" ? schema.maxItems : "unbounded" },
      ...(schema.default !== undefined ? { defaultValue: schema.default as JsonValue } : {}) };
  }
  const valueType = schema.type === "string" && schema.format === "date" ? "date" : schema.type === "string" && schema.format === "date-time" ? "datetime" : schema.type;
  if (typeof valueType !== "string" || !VALUE_TYPES.includes(valueType)) fail("INVALID_DEFINITION", "The template parameter shape is unsupported.");
  const requiredKeys = Array.isArray(schema.required) ? schema.required : [];
  return {
    valueType: valueType as ContentValueShape["valueType"], required,
    ...(isObject(schema["x-osf-reference"]) && typeof schema["x-osf-reference"].entity === "string" ? { relationship: { target: schema["x-osf-reference"].entity } } : {}),
    ...(Array.isArray(schema.enum) ? { enum: schema.enum as JsonValue[] } : {}),
    ...(isObject(schema.properties) ? { fields: Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [name, parameterShape(object(child, "parameter"), requiredKeys.includes(name))])) } : {}),
    ...(schema.default !== undefined ? { defaultValue: schema.default as JsonValue } : {}),
  };
}

/** A physical block row (live or from a snapshot) as the engine's ContentBlock. */
export function blockFromRow(carrier: RuntimeEntityValueCarrier, row: Readonly<Record<string, unknown>>): ContentBlock {
  const name = text(row[carrier.definitionColumn], "definition key");
  const entry = definition(carrier, name);
  const logical = object(row[carrier.valuesColumn] ?? {}, "block values");
  const referenceKeys = new Set(entry.references.map((reference) => reference.fieldKey));
  const values = Object.fromEntries(Object.entries(logical).filter(([key]) => !referenceKeys.has(key)));
  const references = Object.fromEntries(entry.references.map((reference) => {
    const parameter = reference.parameterColumn ? row[reference.parameterColumn] : null;
    if (typeof parameter === "string") return [reference.fieldKey, { parameter }];
    const id = row[reference.column];
    return [reference.fieldKey, id == null ? null : { entity: reference.targetEntity, id: uuid(id, reference.fieldKey) }];
  }));
  return { id: uuid(row.id, "block id"), definitionKey: name, schemaVersion: Number(row.definition_version ?? 1), values: immutableContent(values) as JsonObject, references };
}

async function compiledRegistry(context: ModuleOperationContext, carrier: RuntimeEntityValueCarrier): Promise<CompiledContentBlockRegistry> {
  const { platform, session } = contextServices(context);
  return Object.fromEntries(await Promise.all(Object.entries(carrier.definitions).map(async ([key, entry]) => {
    const operation = entry.materializeOperationId ? await platform.operations.get(session, entry.materializeOperationId) : undefined;
    return [key, {
      entityName: entry.entityName, schemaVersion: 1, source: immutableContent(entry) as unknown as JsonObject,
      ...(operation?.output?.kind === "json-schema" ? { materializationSchema: immutableContent(operation.output.schema) as JsonObject } : {}),
      fields: Object.fromEntries(entry.fields.map((field) => [text(field.key, "field key"), contentFieldProjection(field)])),
      renderers: { document: "entityFields", email: "entityFields", whatsapp: "entityFields" },
    }];
  })));
}

/** Materializes a revision inside the caller's session transaction. */
export async function materializeRevision(context: ModuleOperationContext, trx: unknown, revision: RevisionRow): Promise<MaterializedTemplateContent> {
  const { platform, session } = contextServices(context);
  const tenantId = session.tenantId!;
  const carrier = platform.schemas.entityValues?.get("Block", "values");
  if (!carrier) fail("OPERATION_UNAVAILABLE", "Compiled block definitions are unavailable.");
  const allowed = (entity: string, field: string) => [...(platform.schemas.entityValues?.collection(entity, field)?.allowedDefinitions ?? [])];
  const registry = await compiledRegistry(context, carrier!);
  const operationDefinitions = await platform.operations.list(session);
  const parameterFields = new Map<string, readonly Record<string, unknown>[]>();
  const shapes = (fields: readonly Record<string, unknown>[]) => {
    const schema = platform.schemas.fields.object(fields);
    const properties = object(schema.properties ?? {}, "parameter properties");
    const required = Array.isArray(schema.required) ? schema.required : [];
    return Object.fromEntries(Object.entries(properties).map(([name, child]) => [name, parameterShape(object(child, "parameter schema"), required.includes(name))]));
  };
  const read = async (entityName: string, id: string) => {
    await platform.records.assertAccess(session, { entityName, id, intent: "get" });
    const matches = operationDefinitions.filter((operation) => operation.entityName === entityName && operation.intent === "get");
    if (matches.length !== 1 || matches[0]!.effects.data !== "read" || matches[0]!.effects.external !== "none") fail("OPERATION_UNAVAILABLE", "A source has no unambiguous canonical read Operation.");
    const result = await platform.operations.execute(session, { operation: matches[0]!, input: { id } });
    if ("error" in result) throw operationFailure(result.error);
    if (result.data == null) return null;
    const row = object(result.data, "source record");
    if (row.id !== id || row.tenantId !== tenantId) fail("DEPENDENCY_INVALID", "The source read returned a different record or tenant.");
    return row;
  };
  const tracked = revision.template_version_id ? await readTemplateVersion(trx, revision.template_version_id) : undefined;
  const trackedFields = tracked ? templateParameterFields(tracked.snapshot) : [];
  try {
    return await materializeTemplateContent({
      tenantId, templateVersionId: revision.id, channel: revision.channel, locale: revision.locale,
      parameters: immutableContent(revision.parameters ?? {}) as JsonObject,
    }, registry, {
      async resolveTemplateVersion(id): Promise<ContentTemplateVersion | null> {
        if (id === revision.id) {
          parameterFields.set(id, trackedFields);
          const blocks = (await listRevisionBlocks(trx, revision.id)).map((row) => blockFromRow(carrier!, row));
          return { id, tenantId, templateId: revision.document_id, versionNumber: 1, parameters: shapes(trackedFields),
            variants: [{ id, channel: revision.channel, locale: revision.locale, blocks, allowedDefinitions: allowed("DocumentRevision", "blocks") }] };
        }
        uuid(id, "template version");
        await platform.records.assertAccess(session, { entityName: "TemplateVersion", id, intent: "get" });
        const version = await readTemplateVersion(trx, id);
        if (!version) return null;
        const fields = templateParameterFields(version.snapshot);
        parameterFields.set(id, fields);
        const nodes = templateVariantBlocks(version.snapshot, revision.channel, revision.locale);
        const variant = findChild(version.snapshot.head, "template_variants", { channel: revision.channel, locale: revision.locale });
        return { id, tenantId, templateId: version.template_id, versionNumber: version.version_number, parameters: shapes(fields),
          variants: nodes && variant ? [{ id: rowId(variant), channel: revision.channel, locale: revision.locale, blocks: nodes.map((node) => blockFromRow(carrier!, node.row)), allowedDefinitions: allowed("TemplateVariant", "blocks") }] : [] };
      },
      async resolveGlobalVariable(key) {
        const found = (await rows<{ id: string }>(trx, "select id from erp.chips where tenant_id = $1 and key = $2 for share", [tenantId, key]))[0];
        if (!found) return null;
        const chip = await read("Chip", uuid(found.id, "chip id"));
        if (!chip || chip.key !== key || typeof chip.value !== "string") return null;
        return { tenantId, sourceId: found.id, sourceVersionId: `${found.id}@${text(chip.updatedAt, "chip version")}`, value: chip.value };
      },
      async resolveEntity(reference) {
        const row = await read(reference.entity, reference.id);
        if (!row) return null;
        return { tenantId, entity: reference.entity, id: uuid(row.id, "referenced record"), versionId: text(row.updatedAt, "referenced record version"), value: immutableContent(row) as JsonObject };
      },
      validateParameters(version, values) {
        const fields = parameterFields.get(version.id);
        if (!fields) fail("INVALID_DEFINITION", "Template parameter definitions are unavailable.");
        if (!fields!.length) return;
        const valid = platform.schemas.fields.validateObject(fields!, values);
        if (!valid.valid) throw operationFailure(valid.error);
      },
      validateBlockValues(name, values) {
        const result = platform.schemas.json.validate(definition(carrier!, name).valueSchema, values);
        if (!result.valid) throw operationFailure(result.error);
      },
      async materializeBlock(block): Promise<ContentBlockMaterialization> {
        const entry = definition(carrier!, block.definitionKey);
        if (!entry.materializeOperationId) fail("OPERATION_UNAVAILABLE", "The block has no authored materialization Operation.");
        const operation = await platform.operations.get(session, entry.materializeOperationId!);
        if (!operation || operation.effects.data !== "read" || operation.effects.external !== "none") fail("OPERATION_UNAVAILABLE", "The block materialization Operation is unavailable or has write effects.");
        if (operation!.input.kind !== "json-schema") fail("INVALID_DEFINITION", "Block materialization requires a canonical JSON-schema Operation input.");
        const propertySchemas = object(object(operation!.input.schema, "Operation input schema").properties ?? {}, "Operation input properties");
        const available: Record<string, unknown> = { definitionKey: block.definitionKey, values: block.values, references: block.references, channel: revision.channel, locale: revision.locale };
        const values = Object.fromEntries(Object.entries(propertySchemas).flatMap(([name, raw]) => {
          const property = object(raw, "Operation input property");
          if (Object.hasOwn(property, "const")) return [[name, property.const]];
          return Object.hasOwn(available, name) ? [[name, available[name]]] : [];
        }));
        const result = await platform.operations.execute(session, { operation: operation!, input: values });
        if ("error" in result) throw operationFailure(result.error);
        return { operationId: operation!.id, result: immutableContent(object(result.data, "materialization result")) as ContentBlockMaterialization["result"] };
      },
    });
  } catch (error) {
    if (error instanceof TemplateContentError) throw operationFailure({ code: error.code, message: error.message, retryable: false });
    throw error;
  }
}

