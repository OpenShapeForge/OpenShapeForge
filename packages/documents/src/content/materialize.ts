// SPDX-License-Identifier: BUSL-1.1
import {
  assertVariableCompatible,
  assertVariableSourceValue,
  assertVariableUsagePermitted,
  escapeMarkdownVariableText,
  isDeclaredVariableNamespace,
  permitsVariableUsage,
  variableText,
  variableTokens,
  wholeVariableExpression,
  type VariableCatalogue,
  type VariableOffer,
  type VariableSlot,
} from "@openshapeforge/operations";
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
  ContentBlock,
  ContentEntityReference,
  ContentResolvedEntity,
  ContentResolvedVariable,
  ContentResolvers,
  ContentTemplateVersion,
  MaterializeDocumentContentInput,
  MaterializedDocumentContent,
  ContentTemplateVariant,
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
  validateContentVariants,
  validateContentValues,
} from "./validation.js";
import {
  contentGlobalVariableOffer,
  contentItemShape,
  contentVariableCatalogue,
  contentVariableFailure,
  contentVariableOffer,
  contentVariableReference,
  contentVariableShape,
  contentVariableSlot,
} from "./variables.js";
import type { ContentValueShape } from "./types.js";

/**
 * Resolves a pinned template into data, not HTML. Renderers must escape/sanitize for their
 * output surface. Resolvers are authorized adapters, not a new persistence runtime.
 * Every call creates a fresh snapshot; no existing document or queued message is modified.
 */
async function materializeContent(
  input: MaterializeTemplateContentInput | MaterializeDocumentContentInput,
  registryInput: CompiledContentBlockRegistry,
  resolvers: ContentResolvers,
): Promise<MaterializedTemplateContent | MaterializedDocumentContent> {
  const request = immutableContent(input);
  for (const key of ["tenantId", "channel", "locale"] as const) assertContentName(request[key], key);
  if ("documentId" in request) { assertContentName(request.documentId, "documentId"); validateContentVariants(request.variants); }
  else assertContentName(request.templateVersionId, "templateVersionId");
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

  /**
   * One global, with the contract its own source declares for it. A Chip
   * stores the FieldDefinition that types its value, so the shape is not
   * known before the key is resolved: the authorized read happens first and
   * the declared shape it returns is what the destination is compared
   * against. The identity, version, tenant and shape are frozen into the
   * snapshot exactly as they were read.
   */
  async function global(key: string): Promise<ContentResolvedVariable> {
    if (Object.hasOwn(globals, key)) return globals[key]!;
    countDependency();
    const resolved = await resolvers.resolveGlobalVariable(key, context);
    if (!resolved)
      contentError("MISSING_VARIABLE", `Global variable ${key} could not be resolved.`);
    // Before the result is frozen: a source that does not state the contract
    // of its own value is a broken dependency, not an untyped value.
    if (!resolved.shape || typeof resolved.shape !== "object" || typeof resolved.shape.baseType !== "string")
      contentError("DEPENDENCY_INVALID", `Global variable ${key} declares no value type.`);
    const value = immutableContent({
      tenantId: resolved.tenantId,
      sourceId: resolved.sourceId,
      sourceVersionId: resolved.sourceVersionId,
      shape: resolved.shape,
      value: resolved.value,
    });
    if (value.tenantId !== request.tenantId)
      contentError("DEPENDENCY_INVALID", "Global variable resolved outside the template tenant.");
    assertContentName(value.sourceId, "global variable source id");
    assertContentName(value.sourceVersionId, "global variable source version");
    if (!Object.hasOwn(value, "value"))
      contentError("DEPENDENCY_INVALID", "Global variable has no snapshot value.");
    globals[key] = value;
    return value;
  }

  /** The variables and their values one template version's blocks may name. */
  type VariableScope = { readonly catalogue: VariableCatalogue; readonly parameters: JsonObject };

  /**
   * One binding, resolved through the shared typed-variable contract: the
   * reference is parsed, the namespace that owns it declares the variable's
   * type, that type must fit the destination in this shape, and only then is
   * a value read. A value that breaks its own source's contract is refused;
   * nothing falls back to a literal or an empty value.
   */
  async function bind(
    expression: string,
    slot: VariableSlot,
    usage: "whole" | "template",
    scope: VariableScope,
  ): Promise<{ readonly offer: VariableOffer; readonly value: JsonValue }> {
    const reference = contentVariableReference(expression);
    // A namespace whose keys declare their own contract is resolved before it
    // can be compared: the read is authorized either way, and the shape it
    // returns is the source's, never the caller's. The shape a template may
    // not bind at all — a mode the field does not author — is still refused
    // first, so an unbindable field reads no global.
    const declared = isDeclaredVariableNamespace(scope.catalogue, reference.namespace);
    if (declared) {
      try {
        assertVariableUsagePermitted(slot, usage);
      } catch (error) {
        contentVariableFailure(error);
      }
    }
    const resolved = declared ? await global(reference.key) : undefined;
    const offer = resolved
      ? contentGlobalVariableOffer(reference, resolved)
      : contentVariableOffer(scope.catalogue, reference);
    try {
      assertVariableCompatible(slot, offer, usage);
    } catch (error) {
      contentVariableFailure(error);
    }
    const value = resolved
      ? resolved.value
      : Object.hasOwn(scope.parameters, reference.key) ? scope.parameters[reference.key] : undefined;
    try {
      assertVariableSourceValue(offer, value);
    } catch (error) {
      contentVariableFailure(error);
    }
    return { offer, value: value as JsonValue };
  }

  /**
   * Fill the variables of one authored value, under the contract of the field
   * that holds it.
   *
   * A field that authors no mode takes literals only: its text is returned
   * untouched, so `{{` in ordinary content is content. A field that permits a
   * whole-value binding and holds exactly one token is bound to that
   * variable's typed value — resolved first, then validated by the field's
   * own canonical validator after substitution. A field that permits a
   * template has every token replaced by the variable's formatted text, and a
   * Markdown destination escapes each replacement so a value cannot become
   * syntax.
   */
  async function interpolate(
    value: JsonValue,
    shape: ContentValueShape | undefined,
    path: string,
    scope: VariableScope,
    markdown: boolean,
  ): Promise<JsonValue> {
    const slot = contentVariableSlot(path, shape);
    if (typeof value === "string") {
      if (slot.mode === "none") return value;
      // One unbounded run per `{{`, trimmed by the reference parser:
      // surrounding `\s*` around a lazy group backtracks cubically on an
      // unclosed `{{`.
      const whole = wholeVariableExpression(value);
      if (whole !== undefined && permitsVariableUsage(slot.mode, "whole")) {
        // The typed value of the variable is the value of the field; it is
        // data, not Markdown source, so it is not escaped here.
        return (await bind(whole, slot, "whole", scope)).value;
      }
      const matches = variableTokens(value);
      if (matches.length > 0) {
        try {
          assertVariableUsagePermitted(slot, "template");
        } catch (error) {
          contentVariableFailure(error);
        }
      }
      let result = "";
      let offset = 0;
      for (const match of matches) {
        const literal = value.slice(offset, match.index);
        if (/\{\{|\}\}/.test(literal))
          contentError("INVALID_VALUE", "Malformed variable expression.");
        const bound = await bind(match[1]!, slot, "template", scope);
        let text: string;
        try {
          text = variableText(bound.value);
        } catch (error) {
          contentVariableFailure(error);
        }
        if (markdown) text = escapeMarkdownVariableText(text);
        if (result.length + literal.length + text.length > CONTENT_LIMITS.stringCharacters)
          contentError("CONTENT_LIMIT_EXCEEDED", "Expanded text exceeds the size budget.");
        result += literal + text;
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
      // A collection's rows hold values of the same type, one at a time.
      const item = shape ? contentItemShape(shape) : undefined;
      const result: JsonValue[] = [];
      for (const child of value) result.push(await interpolate(child, item, path, scope, markdown));
      return result;
    }
    if (value && typeof value === "object") {
      const fields = shape?.fields;
      const result: Record<string, JsonValue> = Object.create(null);
      for (const key of Object.keys(value).sort()) {
        // Only a declared child has a contract to bind against. An object
        // whose entries are not declared holds literals.
        const child = fields && Object.hasOwn(fields, key) ? fields[key] : undefined;
        result[key] = await interpolate((value as JsonObject)[key]!, child, `${path}.${key}`, scope, markdown);
      }
      return result;
    }
    return value;
  }

  /**
   * The contract of the local values a composition block passes to the
   * template it includes: that template version's own typed parameters, each
   * one carrying the mode the including field authored. So a parameter of the
   * outer template may be bound through to the inner one, and the binding is
   * compared against the type the inner template declares rather than
   * against a free-form object.
   */
  async function compositionParameterShape(
    definition: CompiledContentBlockDefinition,
    references: ContentBlock["references"],
  ): Promise<ContentValueShape | undefined> {
    const composition = definition.composition;
    if (!composition?.parametersField) return undefined;
    const field = Object.hasOwn(definition.fields, composition.parametersField)
      ? definition.fields[composition.parametersField]
      : undefined;
    const variables = field?.variables;
    if (!field || !variables || variables === "none") return field;
    const reference = Object.hasOwn(references, composition.templateVersionField)
      ? references[composition.templateVersionField]
      : undefined;
    if (!reference || Array.isArray(reference) || !("id" in reference)) return field;
    // The same resolve `visit` performs for this inclusion, cached by id: one
    // authorized read of the version, whichever of the two needs it first.
    const nested = await template(reference.id);
    return {
      ...field,
      fields: Object.fromEntries(
        Object.entries(nested.parameters).map(([key, parameter]) => [key, { ...parameter, variables }]),
      ),
    };
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
    // The variables this version's blocks may name: its own typed parameters
    // as `local`, the tenant's Chip catalogue as `chips`. A nested template
    // gets its own scope, so an inclusion never reads the parameters of the
    // template that included it.
    const scope: VariableScope = { catalogue: contentVariableCatalogue(version.parameters), parameters };
    // Capture only the selected channel's source body; other channel variants are not output.
    templates.push({
      path,
      version: { ...version, variants: [variant] },
      variantId: variant.id,
      parameters,
    });
    return visitBlocks(variant, scope, parameters, path, [...ancestors, id]);
  }

  async function visitBlocks(variant: ContentTemplateVariant, scope: VariableScope, parameters: JsonObject, path: readonly string[], ancestors: readonly string[]) {
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
          // The stored spelling of a local binding on a typed reference: a
          // reference is never text, so the binding is its own structure
          // instead of a token inside a string. The name is bounded by the
          // column that holds it, and the binding itself goes through the
          // same compatibility comparison as `{{local.key}}`.
          if (Object.keys(reference).length !== 1 || !/^[a-z][A-Za-z0-9]{0,127}$/.test(name)) contentError("INVALID_VALUE", "Invalid local parameter binding.");
          const field = Object.hasOwn(definition.fields, key) ? definition.fields[key] : undefined;
          const slot = contentVariableSlot(`block references.${key}`, field);
          if (!slot.target) contentError("DEPENDENCY_INVALID", `${key} is not a typed reference, so it takes no parameter binding.`);
          const offer = contentVariableOffer(scope.catalogue, contentVariableReference(`local.${name}`));
          try {
            assertVariableCompatible(slot, offer, "whole");
            assertVariableSourceValue(offer, Object.hasOwn(parameters, name) ? parameters[name] : undefined);
          } catch (error) {
            contentVariableFailure(error);
          }
          return [key, { entity: slot.target, id: parameters[name] as string }];
        }
        return [key, reference];
      }));
      block = { ...block, references: boundReferences };
      validateContentBlockReferences(block, definition);
      const valueFields = Object.fromEntries(
        Object.entries(definition.fields).filter(([, field]) => !field.relationship),
      );
      // Markdown fields get their filled variables escaped; every other field keeps the raw value.
      const parametersShape = await compositionParameterShape(definition, block.references);
      const values: Record<string, JsonValue> = Object.create(null);
      for (const key of Object.keys(block.values).sort()) {
        const field = Object.hasOwn(definition.fields, key) ? definition.fields[key] : undefined;
        const shape = key === definition.composition?.parametersField ? parametersShape : field;
        values[key] = await interpolate(block.values[key]!, shape, `block values.${key}`, scope, field?.osfType === "markdown");
      }
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
        await visit(reference.id, nestedParameters as JsonObject, blockPath, ancestors);
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

  let identity: {templateVersionId:string;compositionHashVersion:"osf-template-content-v1"} | {documentId:string;documentVariantId:string;compositionHashVersion:"osf-document-content-v1"};
  if ("documentId" in request) {
    const variant=selectContentTemplateVariant({variants:request.variants},request.channel,request.locale);
    await visitBlocks(variant,{catalogue:contentVariableCatalogue({}),parameters:{}},{},[],[]);
    identity={documentId:request.documentId,documentVariantId:variant.id,compositionHashVersion:"osf-document-content-v1"};
  } else {
    await visit(request.templateVersionId, request.parameters ?? {}, [], []);
    identity={templateVersionId:request.templateVersionId,compositionHashVersion:"osf-template-content-v1"};
  }
  const snapshot = immutableContent({
    schemaVersion: 1 as const,
    tenantId: request.tenantId,
    ...identity,
    channel: request.channel,
    locale: request.locale,
    blocks,
    compositions,
    templates,
    definitions,
    globals,

  });
  return immutableContent({
    ...snapshot,
    compositionHash: await hashCanonicalJson(snapshot, snapshot.compositionHashVersion),
  });
}


export function materializeTemplateContent(input: MaterializeTemplateContentInput, registry: CompiledContentBlockRegistry, resolvers: ContentResolvers): Promise<MaterializedTemplateContent> {
  return materializeContent(input,registry,resolvers) as Promise<MaterializedTemplateContent>;
}
export function materializeDocumentContent(input: MaterializeDocumentContentInput, registry: CompiledContentBlockRegistry, resolvers: ContentResolvers): Promise<MaterializedDocumentContent> {
  return materializeContent(input,registry,resolvers) as Promise<MaterializedDocumentContent>;
}
