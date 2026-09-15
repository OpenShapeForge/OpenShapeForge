// SPDX-License-Identifier: BUSL-1.1
import { contentError } from "./errors.js";
import {
  canonicalJson,
  CONTENT_LIMITS,
  hashCanonicalJson,
  immutableContent,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import type {
  CompiledContentBlockDefinition,
  CompiledContentBlockRegistry,
  ContentEntityReference,
  ContentResolvedEntity,
  ContentResolvedVariable,
  ContentResolvers,
  ContentTemplateVersion,
  MaterializedContentBlock,
  MaterializedTemplateContent,
  MaterializeTemplateContentInput,
} from "./types.js";
import {
  assertContentName,
  assertContentRecord,
  defineContentTemplateVersion,
  resolveTemplateParameters,
  selectContentTemplateVariant,
  validateContentBlockReferences,
  validateContentRegistry,
  validateContentValues,
} from "./validation.js";

/**
 * Resolves a pinned template into data, not HTML. Renderers must escape/sanitize for their
 * output surface. Resolvers are authorized adapters, not a new persistence runtime.
 * Every call creates a fresh snapshot; no existing document or queued message is modified.
 */
export async function materializeTemplateContent(
  input: MaterializeTemplateContentInput,
  registryInput: CompiledContentBlockRegistry,
  resolvers: ContentResolvers,
): Promise<MaterializedTemplateContent> {
  const request = immutableContent(input);
  for (const key of ["tenantId", "templateVersionId", "channel", "locale"] as const)
    assertContentName(request[key], key);
  const registry = validateContentRegistry(registryInput);
  const context = Object.freeze({ tenantId: request.tenantId });
  const versions = new Map<string, ContentTemplateVersion>();
  const entities = new Map<string, ContentResolvedEntity>();
  const globals: Record<string, ContentResolvedVariable> = Object.create(null);
  const definitions: Record<string, CompiledContentBlockDefinition> = Object.create(null);
  const templates: MaterializedTemplateContent["templates"][number][] = [];
  const compositions: MaterializedTemplateContent["compositions"][number][] = [];
  const blocks: MaterializedContentBlock[] = [];
  let dependencyCount = 0;
  let visitedBlocks = 0;
  let expandedCharacters = 0;
  function accountExpandedContent(value: unknown) {
    expandedCharacters += canonicalJson(value).length;
    if (expandedCharacters > CONTENT_LIMITS.stringCharacters)
      contentError("CONTENT_LIMIT_EXCEEDED", "Expanded content exceeds the aggregate size budget.");
  }
  function countDependency() {
    if (++dependencyCount > CONTENT_LIMITS.dependencies)
      contentError("CONTENT_LIMIT_EXCEEDED", "Too many content dependencies.");
  }

  async function template(id: string) {
    const previous = versions.get(id);
    if (previous) return previous;
    countDependency();
    const resolved = await resolvers.resolveTemplateVersion(id, context);
    if (!resolved)
      contentError("DEPENDENCY_UNRESOLVED", "Required template version could not be resolved.");
    const version = defineContentTemplateVersion(resolved);
    if (version.tenantId !== request.tenantId || version.id !== id)
      contentError(
        "DEPENDENCY_INVALID",
        "Template version resolved to a different tenant or identity.",
      );
    versions.set(id, version);
    return version;
  }

  async function global(key: string): Promise<JsonValue> {
    if (Object.hasOwn(globals, key)) return globals[key]!.value;
    countDependency();
    const resolved = await resolvers.resolveGlobalVariable(key, context);
    if (!resolved)
      contentError("MISSING_VARIABLE", `Global variable ${key} could not be resolved.`);
    const value = immutableContent({
      tenantId: resolved.tenantId,
      sourceId: resolved.sourceId,
      sourceVersionId: resolved.sourceVersionId,
      value: resolved.value,
    });
    if (value.tenantId !== request.tenantId)
      contentError("DEPENDENCY_INVALID", "Global variable resolved outside the template tenant.");
    assertContentName(value.sourceId, "global variable source id");
    assertContentName(value.sourceVersionId, "global variable source version");
    if (!Object.hasOwn(value, "value"))
      contentError("DEPENDENCY_INVALID", "Global variable has no snapshot value.");
    globals[key] = value;
    return value.value;
  }

  async function variable(expression: string, parameters: JsonObject): Promise<JsonValue> {
    // Use the existing Chip authoring namespace; do not introduce a second
    // spelling for the same platform variable in document templates.
    const match = /^(local|chips)\.([A-Za-z][A-Za-z0-9_.-]*)$/.exec(expression.trim());
    if (!match)
      contentError("INVALID_VALUE", "Variables must use {{local.key}} or {{chips.key}}.");
    const key = match[2]!;
    if (match[1] === "chips") return global(key);
    if (!Object.hasOwn(parameters, key))
      contentError("MISSING_VARIABLE", `Local variable ${key} is missing.`);
    return parameters[key]!;
  }

  async function interpolate(value: JsonValue, parameters: JsonObject): Promise<JsonValue> {
    if (typeof value === "string") {
      const matches = [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)];
      if (matches.length === 1 && matches[0]![0] === value)
        return variable(matches[0]![1]!, parameters);
      let result = "";
      let offset = 0;
      for (const match of matches) {
        const literal = value.slice(offset, match.index);
        if (/\{\{|\}\}/.test(literal))
          contentError("INVALID_VALUE", "Malformed variable expression.");
        const replacement = await variable(match[1]!, parameters);
        if (!["string", "number", "boolean"].includes(typeof replacement))
          contentError("INVALID_VALUE", "Inline text variables must resolve to scalar values.");
        if (
          result.length + literal.length + String(replacement).length >
          CONTENT_LIMITS.stringCharacters
        )
          contentError("CONTENT_LIMIT_EXCEEDED", "Expanded text exceeds the size budget.");
        result += literal + String(replacement);
        offset = match.index + match[0].length;
      }
      const remaining = value.slice(offset);
      if (/\{\{|\}\}/.test(remaining))
        contentError("INVALID_VALUE", "Malformed variable expression.");
      if (result.length + remaining.length > CONTENT_LIMITS.stringCharacters)
        contentError("CONTENT_LIMIT_EXCEEDED", "Expanded text exceeds the size budget.");
      return result + remaining;
    }
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (const child of value) result.push(await interpolate(child, parameters));
      return result;
    }
    if (value && typeof value === "object") {
      const result: Record<string, JsonValue> = Object.create(null);
      for (const key of Object.keys(value).sort())
        result[key] = await interpolate((value as JsonObject)[key]!, parameters);
      return result;
    }
    return value;
  }

  async function entity(reference: ContentEntityReference) {
    const identity = canonicalJson([reference.entity, reference.id, reference.versionId ?? null]);
    const previous = entities.get(identity);
    if (previous) return previous;
    countDependency();
    const resolved = await resolvers.resolveEntity(reference, context);
    if (!resolved)
      contentError("DEPENDENCY_UNRESOLVED", "Required entity reference could not be resolved.");
    const value = immutableContent({
      tenantId: resolved.tenantId,
      entity: resolved.entity,
      id: resolved.id,
      versionId: resolved.versionId,
      value: resolved.value,
    });
    if (
      value.tenantId !== request.tenantId ||
      value.entity !== reference.entity ||
      value.id !== reference.id ||
      (reference.versionId !== undefined && value.versionId !== reference.versionId)
    ) {
      contentError(
        "DEPENDENCY_INVALID",
        "Entity reference resolved to a different tenant, type, identity, or pinned version.",
      );
    }
    assertContentName(value.versionId, "entity source version");
    assertContentRecord(value.value, "entity snapshot values");
    entities.set(identity, value);
    return value;
  }

  async function visit(
    id: string,
    parameterInput: JsonObject,
    path: readonly string[],
    ancestors: readonly string[],
  ) {
    if (ancestors.includes(id))
      contentError("TEMPLATE_CYCLE", "Template inclusion contains a cycle.");
    if (ancestors.length >= CONTENT_LIMITS.templateDepth)
      contentError("CONTENT_LIMIT_EXCEEDED", "Template inclusion exceeds the maximum depth.");
    const version = await template(id);
    const variant = selectContentTemplateVariant(version, request.channel, request.locale);
    const parameters = resolveTemplateParameters(version.parameters, parameterInput);
    await resolvers.validateParameters?.(version, parameters);
    // Capture only the selected channel's source body; other channel variants are not output.
    templates.push({
      path,
      version: { ...version, variants: [variant] },
      variantId: variant.id,
      parameters,
    });
    for (const sourceBlock of variant.blocks) {
      let block = sourceBlock;
      if (++visitedBlocks > CONTENT_LIMITS.blocks)
        contentError("CONTENT_LIMIT_EXCEEDED", "Expanded template contains too many blocks.");
      const definition = Object.hasOwn(registry, block.definitionKey)
        ? registry[block.definitionKey]
        : undefined;
      if (!definition)
        contentError(
          "BLOCK_UNKNOWN",
          "Block definition is absent from the compiled entity metadata.",
        );
      if (variant.allowedDefinitions && !variant.allowedDefinitions.includes(block.definitionKey))
        contentError("BLOCK_NOT_ALLOWED", "Block definition is not allowed in this collection.");
      if (block.schemaVersion !== definition.schemaVersion)
        contentError(
          "BLOCK_SCHEMA_UNSUPPORTED",
          "Block requires a different compiled definition version.",
        );
      const renderer = Object.hasOwn(definition.renderers, request.channel)
        ? definition.renderers[request.channel]
        : undefined;
      if (!renderer && (!definition.composition || Object.keys(definition.renderers).length > 0))
        contentError("UNSUPPORTED_CHANNEL", "Block has no renderer for the requested channel.");
      definitions[block.definitionKey] = definition;
      const boundReferences = Object.fromEntries(Object.entries(block.references).map(([key, reference]) => {
        if (reference && !Array.isArray(reference) && "parameter" in reference) {
          const name = reference.parameter;
          if (Object.keys(reference).length !== 1 || !/^[a-z][A-Za-z0-9]{0,127}$/.test(name)) contentError("INVALID_VALUE", "Invalid local parameter binding.");
          const parameter = Object.hasOwn(version.parameters, name) ? version.parameters[name] : undefined;
          const target = definition.fields[key]?.relationship?.target;
          if (!target || parameter?.relationship?.target !== target || parameter.cardinality && parameter.cardinality !== "single") contentError("DEPENDENCY_INVALID", `Parameter ${name} does not match relationship ${key}.`);
          if (!Object.hasOwn(parameters, name) || typeof parameters[name] !== "string") contentError("MISSING_VARIABLE", `Entity parameter ${name} is missing.`);
          return [key, { entity: target, id: parameters[name] as string }];
        }
        return [key, reference];
      }));
      block = { ...block, references: boundReferences };
      validateContentBlockReferences(block, definition);
      const valueFields = Object.fromEntries(
        Object.entries(definition.fields).filter(([, field]) => !field.relationship),
      );
      const values = (await interpolate(block.values, parameters)) as JsonObject;
      validateContentValues(values, valueFields, "block values");
      accountExpandedContent(values);
      await resolvers.validateBlockValues?.(block.definitionKey, immutableContent(values));
      const blockPath = [...path, block.id];
      const references: Record<
        string,
        ContentResolvedEntity | readonly ContentResolvedEntity[] | null
      > = Object.create(null);
      for (const key of Object.keys(block.references).sort()) {
        if (key === definition.composition?.templateVersionField) continue;
        const reference = block.references[key];
        if (reference == null) references[key] = null;
        else if (Array.isArray(reference)) {
          const resolved: ContentResolvedEntity[] = [];
          for (const item of reference) resolved.push(await entity(item));
          references[key] = resolved;
        } else references[key] = await entity(reference as ContentEntityReference);
      }
      accountExpandedContent(references);
      const materialization = resolvers.materializeBlock
        ? immutableContent(await resolvers.materializeBlock({
            definitionKey: block.definitionKey, values: immutableContent(values),
            references: immutableContent(references), channel: request.channel, locale: request.locale,
          }))
        : undefined;
      if (materialization) {
        assertContentName(materialization.operationId, "materialization Operation");
        assertContentRecord(materialization.result, "materialization result");
        accountExpandedContent(materialization);
        if (materialization.result.kind !== "block" && materialization.result.kind !== "template")
          contentError("INVALID_VALUE", "Materialization must return block values or a template inclusion.");
        if (materialization.result.kind === "block") assertContentRecord(materialization.result.value, "materialized block values");
      }
      const inclusion = materialization?.result.kind === "template" ? materialization.result : undefined;
      if (inclusion) assertContentName(inclusion.referenceField, "template reference field");
      const templateReferenceField = inclusion?.referenceField ?? definition.composition?.templateVersionField;
      if (templateReferenceField) {
        if (!Object.hasOwn(definition.fields, templateReferenceField) ||
            definition.fields[templateReferenceField]?.relationship?.target !== "TemplateVersion")
          contentError("DEPENDENCY_INVALID", "Template inclusion must select a declared template-version relationship.");
        const reference = block.references[templateReferenceField] as
          | ContentEntityReference
          | undefined;
        if (!reference || reference.versionId !== undefined)
          contentError(
            "DEPENDENCY_INVALID",
            "Template inclusion must reference an exact template-version entity id, without a second version pointer.",
          );
        const nestedParameters = inclusion ? inclusion.parameters : definition.composition?.parametersField
          ? (values[definition.composition.parametersField] ?? {})
          : {};
        assertContentRecord(nestedParameters, "nested template parameters");
        compositions.push({
          path: blockPath,
          definitionKey: block.definitionKey,
          schemaVersion: block.schemaVersion,
          values,
          templateReference: reference,
          references,
          ...(materialization ? { materialization } : {}),
        });
        await visit(reference.id, nestedParameters as JsonObject, blockPath, [...ancestors, id]);
      } else {
        blocks.push({
          path: blockPath,
          id: block.id,
          definitionKey: block.definitionKey,
          schemaVersion: block.schemaVersion,
          renderer: renderer!,
          values,
          references,
          ...(materialization ? { materialization } : {}),
        });
      }
    }
  }

  await visit(request.templateVersionId, request.parameters ?? {}, [], []);
  const snapshot = immutableContent({
    schemaVersion: 1 as const,
    tenantId: request.tenantId,
    templateVersionId: request.templateVersionId,
    channel: request.channel,
    locale: request.locale,
    blocks,
    compositions,
    templates,
    definitions,
    globals,
    compositionHashVersion: "osf-template-content-v1" as const,
  });
  return immutableContent({
    ...snapshot,
    compositionHash: await hashCanonicalJson(snapshot, snapshot.compositionHashVersion),
  });
}
