// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationContext, ModuleOperationHandler, RuntimeEntityValueCarrier, RuntimeEntityValueDefinition, RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import { contextServices, rows } from "./commands.js";
import { materializeTemplateContent } from "./content/materialize.js";
import { templateSnapshotContent } from "./content-snapshot.js";
import { immutableContent, type JsonObject, type JsonValue } from "./content/json.js";
import { TemplateContentError } from "./content/errors.js";
import type { CompiledContentBlockRegistry, ContentBlockMaterialization, ContentField, ContentResolvers, ContentTemplateVersion, ContentValueShape, TemplateParameter } from "./content/types.js";
import { isObject, object, refuse, text, uuid } from "./validation.js";

/** Persisted column of the Block entity's `definitionVersion` field (entities/core/block.yaml). */
export const DEFINITION_VERSION_COLUMN = "definition_version";
const BASE_TYPES = ["string", "integer", "number", "boolean", "date", "datetime", "object"];

export function contentCarrier(context: ModuleOperationContext): RuntimeEntityValueCarrier {
  const { platform } = contextServices(context);
  const carrier = platform.schemas.entityValues?.get("Block", "values");
  if (!carrier) refuse("OPERATION_UNAVAILABLE", "Compiled block definitions are unavailable.");
  return carrier!;
}
export function blockDefinition(carrier: RuntimeEntityValueCarrier, name: string): RuntimeEntityValueDefinition {
  const found = Object.hasOwn(carrier.definitions, name) ? carrier.definitions[name] : undefined;
  if (!found) refuse("BLOCK_UNKNOWN", "The block definition is not available in this application.");
  return found!;
}

/** Canonical value constraints remain in valueSchema; this is only the snapshot DTO. */
export function contentFieldProjection(field: Readonly<Record<string, unknown>>): ContentField {
  const baseType = field.baseType;
  if (typeof baseType !== "string" || !BASE_TYPES.includes(baseType)) refuse("INVALID_DEFINITION", "A block field has no resolved base type.");
  const nested = Array.isArray(field.children) ? field.children : undefined;
  const relationship = isObject(field.relationship) && typeof field.relationship.target === "string" ? { target: field.relationship.target } : undefined;
  return {
    baseType: baseType as ContentField["baseType"],
    ...(typeof field.osfType === "string" ? { osfType: field.osfType } : {}),
    required: field.required === true,
    cardinality: (field.cardinalityBounds ?? field.cardinality ?? "single") as NonNullable<ContentField["cardinality"]>,
    ...(nested ? { fields: Object.fromEntries(nested.map((child) => { const shape = object(child, "field"); return [text(shape.key, "field key"), contentFieldProjection(shape)]; })) } : {}),
    ...(relationship ? { relationship } : {}),
  };
}

function validatedValues(context: ModuleOperationContext, name: string, value: unknown): JsonObject {
  const { platform } = contextServices(context);
  const entry = blockDefinition(contentCarrier(context), name);
  const values = object(value, "values");
  const result = platform.schemas.json.validate(entry.valueSchema, values);
  if (!result.valid) throw operationFailure(result.error);
  return immutableContent(values) as JsonObject;
}

/** One handler serves any value-only block entity; no entity-name switch or private registry. */
export const materializeFields: ModuleOperationHandler = async (input, context) => {
  const name = text(input.definitionKey, "definitionKey");
  const entry = blockDefinition(contentCarrier(context), name);
  if (entry.references.length) refuse("OPERATION_UNAVAILABLE", "A referenced block requires its authored materialization Operation.");
  return { value: { kind: "block", value: validatedValues(context, name, input.values) } };
};

/** Returns an inclusion directive. The shared engine owns recursion and cycle limits. */
export const composeTemplate: ModuleOperationHandler = async (input, context) => {
  const name = text(input.definitionKey, "definitionKey");
  const entry = blockDefinition(contentCarrier(context), name);
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
export function parameterShape(schema: Record<string, unknown>, required: boolean): TemplateParameter {
  if (schema.type === "array") {
    const item = parameterShape(object(schema.items, "parameter items"), false);
    return { ...item, required, cardinality: {
      min: typeof schema.minItems === "number" ? schema.minItems : 0,
      max: typeof schema.maxItems === "number" ? schema.maxItems : "unbounded",
    }, ...(schema.default !== undefined ? { defaultValue: schema.default as JsonValue } : {}) };
  }
  const baseType = schema.type === "string" && schema.format === "date" ? "date"
    : schema.type === "string" && schema.format === "date-time" ? "datetime" : schema.type;
  if (typeof baseType !== "string" || !BASE_TYPES.includes(baseType)) refuse("INVALID_DEFINITION", "The template parameter shape is unsupported.");
  const requiredKeys = Array.isArray(schema.required) ? schema.required : [];
  return {
    baseType: baseType as ContentValueShape["baseType"], required,
    ...(isObject(schema["x-osf-reference"]) && typeof schema["x-osf-reference"].entity === "string" ? { relationship: { target: schema["x-osf-reference"].entity } } : {}),
    ...(Array.isArray(schema.enum) ? { enum: schema.enum as JsonValue[] } : {}),
    ...(isObject(schema.properties) ? { fields: Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [name, parameterShape(object(child, "parameter"), requiredKeys.includes(name))])) } : {}),
    ...(schema.default !== undefined ? { defaultValue: schema.default as JsonValue } : {}),
  };
}

/** The engine's parameter shapes for frozen canonical FieldDefinition rows. */
export function parameterShapes(context: ModuleOperationContext, fields: readonly Record<string, unknown>[]): Record<string, TemplateParameter> {
  const { platform } = contextServices(context);
  let schema: Record<string, unknown>;
  try { schema = platform.schemas.fields.object(fields); }
  catch { refuse("DEPENDENCY_INVALID", "The frozen template parameter definitions are not valid field definitions."); }
  const properties = object(schema!.properties ?? {}, "parameter properties");
  const required = Array.isArray(schema!.required) ? schema!.required : [];
  return Object.fromEntries(Object.entries(properties).map(([name, child]) => [name, parameterShape(object(child, "parameter schema"), required.includes(name))]));
}

/** The compiled block registry the engine validates against, from the carrier's definitions. */
export async function compiledContentRegistry(context: ModuleOperationContext, carrier: RuntimeEntityValueCarrier): Promise<CompiledContentBlockRegistry> {
  const { platform, session } = contextServices(context);
  return Object.fromEntries(await Promise.all(Object.entries(carrier.definitions).map(async ([key, entry]) => {
    const operation = entry.materializeOperationId ? await platform.operations.get(session, entry.materializeOperationId) : undefined;
    return [key, {
      // The compiled contract's own version and fingerprint: a frozen block
      // names the version it was authored against, and the snapshot records
      // the exact definition it was computed with.
      entityName: entry.entityName, schemaVersion: entry.schemaVersion, definitionHash: entry.definitionHash,
      source: immutableContent(entry) as unknown as JsonObject,
      ...(operation?.output?.kind === "json-schema" ? { materializationSchema: immutableContent(operation.output.schema) as JsonObject } : {}),
      fields: Object.fromEntries(entry.fields.map((field) => [text(field.key, "field key"), contentFieldProjection(field)])),
      // Generic field output is available on these channels. A domain Operation
      // can refuse a channel; no renderer is allowed to silently drop a block.
      renderers: { document: "entityFields", email: "entityFields", whatsapp: "entityFields" },
    }];
  })));
}

export type CanonicalReader = (entityName: string, id: string) => Promise<Record<string, unknown> | null>;

/**
 * Record access alone does not redact classified fields. All content must come
 * from the canonical read result, including logical entity-value references.
 */
export function canonicalReader(context: ModuleOperationContext, operationDefinitions: readonly RuntimeOperationDefinition[]): CanonicalReader {
  const { platform, session } = contextServices(context);
  const tenantId = session.tenantId;
  return async (entityName, id) => {
    await platform.records.assertAccess(session, { entityName, id, intent: "get" });
    const matches = operationDefinitions.filter((operation) => operation.entityName === entityName && operation.intent === "get");
    if (matches.length !== 1 || matches[0]!.effects.data !== "read" || matches[0]!.effects.external !== "none") refuse("OPERATION_UNAVAILABLE", "A source has no unambiguous canonical read Operation.");
    const result = await platform.operations.execute(session, { operation: matches[0]!, input: { id } });
    if ("error" in result) throw operationFailure(result.error);
    if (result.data == null) return null;
    const row = object(result.data, "source record");
    if (row.id !== id || row.tenantId !== tenantId) refuse("DEPENDENCY_INVALID", "The source read returned a different record or tenant.");
    return row;
  };
}

/** Global variables use the existing Chip namespace, read through its canonical Operation. */
export function chipResolver(trx: unknown, tenantId: string, read: CanonicalReader): ContentResolvers["resolveGlobalVariable"] {
  return async (key) => {
    const found = (await rows<{ id: string }>(trx, "select id from erp.chips where tenant_id = $1 and key = $2 for share", [tenantId, key]))[0];
    if (!found) return null;
    const chip = await read("Chip", uuid(found.id, "chip id"));
    if (!chip || chip.key !== key || typeof chip.value !== "string") return null;
    return { tenantId, sourceId: found.id, sourceVersionId: `${found.id}@${text(chip.updatedAt, "chip version")}`, value: chip.value };
  };
}

export function entityResolver(tenantId: string, read: CanonicalReader): ContentResolvers["resolveEntity"] {
  return async (reference) => {
    const row = await read(reference.entity, reference.id);
    if (!row) return null;
    return { tenantId, entity: reference.entity, id: uuid(row.id, "referenced record"), versionId: text(row.updatedAt, "referenced record version"), value: immutableContent(row) as JsonObject };
  };
}

/** Dispatches a block to its authored read-only materialization Operation. */
export function blockMaterializer(context: ModuleOperationContext, carrier: RuntimeEntityValueCarrier, channel: string, locale: string): NonNullable<ContentResolvers["materializeBlock"]> {
  const { platform, session } = contextServices(context);
  return async (block): Promise<ContentBlockMaterialization> => {
    const entry = blockDefinition(carrier, block.definitionKey);
    if (!entry.materializeOperationId) refuse("OPERATION_UNAVAILABLE", "The block has no authored materialization Operation.");
    const operation = await platform.operations.get(session, entry.materializeOperationId!);
    if (!operation || operation.effects.data !== "read" || operation.effects.external !== "none") refuse("OPERATION_UNAVAILABLE", "The block materialization Operation is unavailable or has write effects.");
    if (operation!.input.kind !== "json-schema") refuse("INVALID_DEFINITION", "Block materialization requires a canonical JSON-schema Operation input.");
    const propertySchemas = object(object(operation!.input.schema, "Operation input schema").properties ?? {}, "Operation input properties");
    const available: Record<string, unknown> = { definitionKey: block.definitionKey, values: block.values, references: block.references, channel, locale };
    const values = Object.fromEntries(Object.entries(propertySchemas).flatMap(([name, raw]) => {
      const property = object(raw, "Operation input property");
      if (Object.hasOwn(property, "const")) return [[name, property.const]];
      return Object.hasOwn(available, name) ? [[name, available[name]]] : [];
    }));
    const result = await platform.operations.execute(session, { operation: operation!, input: values });
    if ("error" in result) throw operationFailure(result.error);
    return { operationId: operation!.id, result: immutableContent(object(result.data, "materialization result")) as ContentBlockMaterialization["result"] };
  };
}

export type ContentScope = {
  readonly tenantId: string;
  readonly channel: string;
  readonly locale: string;
  readonly carrier: RuntimeEntityValueCarrier;
  /** The template variant collection's allowlist, applied to every frozen template version. */
  readonly allowedDefinitions: readonly string[];
  readonly read: CanonicalReader;
  /**
   * Version ids the caller reaches through its own record's authority (a
   * document's pinned version, whose editor need hold no template role, as
   * for Document.linkTemplate). Every other version, an inclusion of another
   * template, still needs TemplateVersion and Template read.
   */
  readonly ownVersions?: ReadonlySet<string>;
};

/**
 * The resolvers one materialization runs with: frozen template versions,
 * chips, entity references, parameter and block validation, block
 * materialization. Another entry point (a document head) reuses the set and
 * replaces only what its root resolves to.
 */
export function contentResolvers(context: ModuleOperationContext, trx: unknown, scope: ContentScope): ContentResolvers {
  const { platform, session } = contextServices(context);
  const { tenantId, channel, locale, carrier, read } = scope;
  const parameterFields = new Map<string, readonly Record<string, unknown>[]>();
  return {
    async resolveTemplateVersion(id): Promise<ContentTemplateVersion | null> {
      uuid(id, "template version");
      // The version row is the only live read: it is immutable, so sharing
      // it pins nothing that can change. Variants and blocks come from the
      // frozen snapshot on that row, never from their live tables, which may
      // have been edited or deleted since publish.
      const locked = (await rows<{ id: string }>(trx,
        "select id from erp.template_versions where tenant_id = $1 and id = $2 for share", [tenantId, id]))[0];
      if (!locked) return null;
      let version: Record<string, unknown>;
      if (scope.ownVersions?.has(id)) {
        // The row the caller's own record pins, read as Document.linkTemplate reads it: the frozen snapshot, server-side.
        const own = (await rows<{ template_id: string; version_number: number; snapshot: unknown }>(trx,
          "select template_id, version_number, snapshot from erp.template_versions where tenant_id = $1 and id = $2", [tenantId, id]))[0];
        if (!own) return null;
        version = { template: own.template_id, versionNumber: own.version_number, snapshot: own.snapshot };
      } else {
        const found = await read("TemplateVersion", id);
        if (!found) return null;
        version = found;
        await platform.records.assertAccess(session, { entityName: "Template", id: uuid(version.template, "template"), intent: "get" });
      }
      const templateId = uuid(version.template, "template");
      const frozen = templateSnapshotContent(version.snapshot, {
        tenantId, templateId, channel, carrier, allowedDefinitions: scope.allowedDefinitions, definitionVersionColumn: DEFINITION_VERSION_COLUMN,
      });
      const projected = frozen.variants.map((variant) => ({
        ...variant,
        blocks: variant.blocks.map((block) => {
          const fields = platform.records.projectStoredFields(session, {
            entityName: carrier.entityName,
            fields: { [carrier.fieldKey]: block.values },
          });
          const values = fields[carrier.fieldKey];
          if (!isObject(values)) refuse("MISSING_VARIABLE", "Block values are not available under the current disclosure policy.");
          return { ...block, values: immutableContent(values) as JsonObject };
        }),
      }));
      parameterFields.set(id, frozen.parameterFields);
      return { id, tenantId, templateId, versionNumber: Number(version.versionNumber), parameters: parameterShapes(context, frozen.parameterFields), variants: projected };
    },
    resolveGlobalVariable: chipResolver(trx, tenantId, read),
    resolveEntity: entityResolver(tenantId, read),
    validateParameters(version, values) {
      const fields = parameterFields.get(version.id);
      if (!fields) refuse("INVALID_DEFINITION", "Template parameter definitions are unavailable.");
      const valid = platform.schemas.fields.validateObject(fields!, values);
      if (!valid.valid) throw operationFailure(valid.error);
    },
    validateBlockValues(name, values) { validatedValues(context, name, values); },
    materializeBlock: blockMaterializer(context, carrier, channel, locale),
  };
}

/** The compiled block collection of `entityName`, whose allowlist governs what a variant of it may hold. */
export function blockCollection(context: ModuleOperationContext, carrier: RuntimeEntityValueCarrier, entityName: "TemplateVariant" | "DocumentVariant"): { readonly allowedDefinitions: readonly string[] } {
  const { platform } = contextServices(context);
  const collection = platform.schemas.entityValues?.collection(entityName, "blocks");
  if (!collection || collection.targetEntity !== carrier.entityName) refuse("INVALID_DEFINITION", `The compiled ${entityName === "TemplateVariant" ? "template" : "document"} block collection is unavailable.`);
  return collection!;
}

/** Engine failures are Operation failures; anything else is a runtime fault and propagates as is. */
export function contentFailure(error: unknown): never {
  if (error instanceof TemplateContentError) throw operationFailure({ code: error.code, message: error.message, retryable: false });
  throw error;
}

export const materializeTemplate: ModuleOperationHandler = async (input, context) => {
  const { platform, session } = contextServices(context);
  if (!session.tenantId) refuse("UNAUTHENTICATED", "Template materialization requires a tenant session.");
  const tenantId = session.tenantId!;
  const templateVersionId = uuid(input.templateVersionId, "templateVersionId");
  const channel = text(input.channel, "channel");
  const locale = text(input.locale, "locale");
  const carrier = contentCarrier(context);
  const collection = blockCollection(context, carrier, "TemplateVariant");
  const registry = await compiledContentRegistry(context, carrier);
  const read = canonicalReader(context, await platform.operations.list(session));
  try {
    const snapshot = await platform.db.withSession(session, async (trx) => materializeTemplateContent({
      tenantId, templateVersionId, channel, locale,
      ...(input.parameters === undefined ? {} : { parameters: immutableContent(object(input.parameters, "parameters")) as JsonObject }),
    }, registry, contentResolvers(context, trx, { tenantId, channel, locale, carrier, allowedDefinitions: collection.allowedDefinitions, read })));
    return { value: snapshot };
  } catch (error) {
    contentFailure(error);
  }
};
