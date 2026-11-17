// SPDX-License-Identifier: BUSL-1.1
/**
 * Capturing a source into a host-owned copy.
 *
 * Ordinary text is resolved exactly once, here, under the capturing actor's
 * authorization: every variable whose inputs are concrete is read and written
 * as data. A variable that depends on an input the host has not supplied — an
 * inclusion parameter bound to a variable of a host template — is not read;
 * it is rewritten into the host's own scope and the block is recorded as
 * deferred, so the host binds it when it has the input. A document is a
 * concrete host: nothing may stay deferred there.
 *
 * A typed block keeps its definition and its concrete `{entity, id}`
 * references. It is executed when the content is read, under the reader.
 */
import { isColumns, mapColumns } from './columns.js';
import { variableTokens, wholeVariableExpression, type VariableCatalogue, type VariableReference } from "@openshapeforge/operations";
import { createContentEngine, holdsBraces, type CaptureState, type ContentEngine, type VariableScope } from "./engine.js";
import { contentError } from "./errors.js";
import { CONTENT_LIMITS, immutableContent, type JsonObject, type JsonValue } from "./json.js";
import { bindsField, copyBinding, inclusionCopyContent, isInclusionCopy, OBSOLETE_INCLUSION, readInclusionCopy, sourceRecord, type CopyBinding, type InclusionCopy } from "./inclusion-copy.js";
import type { CompiledContentBlockDefinition, CompiledContentBlockRegistry, ContentBlock, ContentResolvers, ContentTemplateVariant, ContentTemplateVersion, ContentValueShape } from "./types.js";
import { assertContentName, assertContentRecord, selectContentTemplateVariant, validateContentRegistry, validateContentValue, validateContentValues } from "./validation.js";
import { contentVariableCatalogue, contentVariableOffer, contentVariableReference } from "./variables.js";

/**
 * The scope content is captured into. A template host names its variables
 * without values (`parameters` absent): a binding to one of them stays
 * pending. A document host supplies values, and whatever is missing refuses
 * the capture.
 */
export type CaptureHost = {
  readonly catalogue: VariableCatalogue;
  readonly parameters?: JsonObject;
};

export type CaptureInclusionInput = {
  readonly tenantId: string;
  readonly channel: string;
  readonly locale: string;
  readonly templateVersionId: string;
  /** The inclusion's inputs as authored: values, or `{{…}}` tokens of the host. */
  readonly parameters: JsonObject;
  /** The variable mode the inclusion's parameter field authored; absent, an input is a literal. */
  readonly parameterVariables?: ContentValueShape["variables"];
  readonly host: CaptureHost;
};

export type CapturedInclusion = {
  /** The inputs to store: resolved where they were concrete, the host's token where they are pending. */
  readonly parameters: JsonObject;
  readonly copy: InclusionCopy;
  /** The source variant's blocks as authored, for a later three-way update. */
  readonly authored: readonly ContentBlock[];
};

const NO_CAPTURE = { defer: () => undefined, deferParameter: () => undefined };
function state(rules: Pick<CaptureState, "defer" | "deferParameter"> = NO_CAPTURE): CaptureState {
  return { ...rules, deferred: false, literalBraces: false };
}

/** The host's own scope: a variable without a value is kept as written, once it is known to exist. */
function hostScope(host: CaptureHost, capture: CaptureState): VariableScope {
  return { catalogue: host.catalogue, parameters: host.parameters ?? {}, capture };
}
function hostRules(host: CaptureHost): Pick<CaptureState, "defer" | "deferParameter"> {
  if (host.parameters) return NO_CAPTURE;
  const known = (name: string) => { contentVariableOffer(host.catalogue, contentVariableReference(`local.${name}`)); };
  return {
    defer: (reference) => { if (reference.namespace !== "local") return undefined; known(reference.key.split(".")[0]!); return `{{local.${reference.key}}}`; },
    deferParameter: (name) => { known(name); return name; },
  };
}

type Pending = { readonly kind: "alias"; readonly expression: string } | { readonly kind: "text"; readonly text: string };

/** How the blocks of the included template see an input the host left pending. */
function pendingRules(pending: ReadonlyMap<string, Pending>): Pick<CaptureState, "defer" | "deferParameter"> {
  const cannot = (name: string): never => contentError("INVALID_VALUE", `local.${name} is bound to text of the including template; only a whole variable can be followed or used as a record.`);
  return {
    defer(reference: VariableReference) {
      if (reference.namespace !== "local") return undefined;
      const [name, ...rest] = reference.key.split(".");
      const input = pending.get(name!);
      if (!input) return undefined;
      if (input.kind === "alias") return `{{${[input.expression, ...rest].join(".")}}}`;
      return rest.length ? cannot(name!) : input.text;
    },
    deferParameter(name: string) {
      const input = pending.get(name);
      if (!input) return undefined;
      const [namespace, key, ...rest] = input.kind === "alias" ? input.expression.split(".") : [];
      return namespace === "local" && key && !rest.length ? key : cannot(name);
    },
  };
}

type Capturer = {
  readonly engine: ContentEngine;
  readonly registry: CompiledContentBlockRegistry;
  readonly resolvers: ContentResolvers;
  readonly channel: string;
};

/**
 * One block in `scope`, with the rules of `rules` for what stays pending.
 * Returns the block to store and whether it still binds in the host.
 */
async function captureBlock(capturer: Capturer, source: ContentBlock, variant: Pick<ContentTemplateVariant, "allowedDefinitions">, scopeOf: (capture: CaptureState) => VariableScope, rules: Pick<CaptureState, "defer" | "deferParameter">, depth: number, binding: CopyBinding = "bind"): Promise<{ block: ContentBlock; deferred: boolean; literalBraces?: boolean }> {
  const { engine, registry, resolvers } = capturer;
  engine.countBlock();
  const definition: CompiledContentBlockDefinition | undefined = Object.hasOwn(registry, source.definitionKey) ? registry[source.definitionKey] : undefined;
  if (!definition) contentError("BLOCK_UNKNOWN", "Block definition is absent from the compiled entity metadata.");
  if (variant.allowedDefinitions && !variant.allowedDefinitions.includes(source.definitionKey)) contentError("BLOCK_NOT_ALLOWED", "Block definition is not allowed in this collection.");
  if (source.schemaVersion !== definition.schemaVersion) contentError("BLOCK_SCHEMA_UNSUPPORTED", "Block requires a different compiled definition version.");
  if (depth > CONTENT_LIMITS.templateDepth) contentError('CONTENT_LIMIT_EXCEEDED', 'Nested content exceeds the maximum depth.');
  if (isColumns(source.definitionKey)) {
    let deferred = false, literalBraces = false;
    const values = await mapColumns(source.values, async children => {
      const kept: ContentBlock[] = [];
      for (const child of children) {
        const result = await captureBlock(capturer, child, variant, scopeOf, rules, depth + 1, binding);
        kept.push(result.block); deferred ||= result.deferred; literalBraces ||= Boolean(result.literalBraces);
      }
      return kept;
    });
    validateContentValues(values, Object.fromEntries(Object.entries(definition.fields).filter(([, field]) => !field.relationship)), "column values");
    await resolvers.validateBlockValues?.(source.definitionKey, immutableContent(values));
    if (deferred && literalBraces) contentError("INVALID_VALUE", "A column cannot mix pending bindings with captured non-Markdown values that contain variable syntax.");
    return {block:{...source,values},deferred,literalBraces};
  }
  const capture = state(rules);
  const scope = scopeOf(capture);
  const bound = engine.bindReferences(source, definition, scope);
  const composition = definition.composition ?? resolvers.compositionContract?.(source.definitionKey);
  if (composition) {
    // An inclusion the source itself holds is already a copy: its captured
    // text is data, and only what the source template would bind when it
    // reads that copy (`copyBinding`) is settled now. Its own source template
    // is not read again.
    if (!isInclusionCopy(source.values.content)) contentError("DEPENDENCY_INVALID", OBSOLETE_INCLUSION);
    if (depth + 1 >= CONTENT_LIMITS.templateDepth) contentError("CONTENT_LIMIT_EXCEEDED", "Template inclusion exceeds the maximum depth.");
    const stored = readInclusionCopy(source.values.content);
    const bindingOf = copyBinding(stored, false);
    const blocks: ContentBlock[] = [];
    const deferred = new Set<string>();
    for (const inner of stored.blocks) {
      const settled = await captureBlock(capturer, inner, {}, scopeOf, rules, depth + 1, bindingOf(inner));
      blocks.push(inner.locked ? { ...settled.block, locked: true } : settled.block);
      if (settled.deferred) deferred.add(inner.id);
    }
    const parametersField = composition.parametersField;
    const inputs = parametersField && Object.hasOwn(source.values, parametersField) ? source.values[parametersField] : undefined;
    if (inputs !== undefined) assertContentRecord(inputs, "nested template parameters");
    const copy: InclusionCopy = { ...(stored.page ? { page: stored.page } : {}), source: await sourceRecord(blocks, deferred), blocks };
    const values = { ...source.values, ...(parametersField && inputs !== undefined ? { [parametersField]: await engine.rescope(inputs as JsonObject, scope) } : {}), content: inclusionCopyContent(copy) } as JsonObject;
    engine.accountExpandedContent(values);
    return { block: { ...bound, values }, deferred: capture.deferred || deferred.size > 0 };
  }
  const renderer = Object.hasOwn(definition.renderers, capturer.channel) ? definition.renderers[capturer.channel] : undefined;
  if (!renderer) contentError("UNSUPPORTED_CHANNEL", "Block has no renderer for the requested channel.");
  const values: Record<string, JsonValue> = Object.create(null);
  for (const key of Object.keys(source.values).sort()) {
    const field = Object.hasOwn(definition.fields, key) ? definition.fields[key] : undefined;
    const markdown = field?.osfType === "markdown";
    if (bindsField(binding, markdown)) values[key] = await engine.interpolate(source.values[key]!, field, `block values.${key}`, scope, markdown);
    else {
      // Data of an earlier capture. Should this block come out pending, the next host binds all of it, this field too.
      values[key] = source.values[key]!;
      if (field?.variables && field.variables !== "none" && holdsBraces(values[key])) capture.literalBraces = true;
    }
  }
  // Markdown has a spelling for a brace that is data (the escape every filled value gets), so a Markdown field can
  // hold resolved values next to a pending variable. A plain field has none: there the two cannot share a block.
  if (capture.deferred && capture.literalBraces)
    contentError("INVALID_VALUE", "Outside a Markdown field, a block cannot combine a variable that is still to be supplied with a value that contains `{{` or `}}`. Supply the value first, or keep the two in separate blocks.");
  if (!capture.deferred) {
    // What is resolved is checked now; what is pending is checked by the host when it binds it.
    validateContentValues(values, Object.fromEntries(Object.entries(definition.fields).filter(([, field]) => !field.relationship)), "block values");
    await resolvers.validateBlockValues?.(source.definitionKey, immutableContent(values));
  }
  engine.accountExpandedContent(values);
  const block: ContentBlock = { ...bound, values };
  // Every record a typed block names is read now, so a capture never stores a reference its actor could not open.
  await engine.resolveReferences(block);
  return { block, deferred: capture.deferred, literalBraces: capture.literalBraces };
}

function request(input: { tenantId: string; channel: string; locale: string }) {
  for (const key of ["tenantId", "channel", "locale"] as const) assertContentName(input[key], key);
}

/**
 * Capture one published template version as the content of an inclusion in
 * `host`. Refuses as a whole when an input, a record on a variable's path or
 * the source itself cannot be read: nothing partial is returned.
 */
export async function captureInclusionContent(input: CaptureInclusionInput, registryInput: CompiledContentBlockRegistry, resolvers: ContentResolvers): Promise<CapturedInclusion> {
  request(input);
  assertContentName(input.templateVersionId, "templateVersionId");
  const registry = validateContentRegistry(registryInput);
  const engine = createContentEngine(input, resolvers);
  const capturer: Capturer = { engine, registry, resolvers, channel: input.channel };
  const version = await engine.template(input.templateVersionId);
  const variant = selectContentTemplateVariant(version, input.channel, input.locale);
  const inputs = immutableContent(input.parameters);
  assertContentRecord(inputs, "parameters");
  for (const key of Object.keys(inputs)) if (!Object.hasOwn(version.parameters, key)) contentError("INVALID_VALUE", `parameters.${key} is not a variable of the included template.`);
  // Each input is settled in the host's scope first: read where the host has the value, kept where it does not.
  const host = hostRules(input.host);
  const stored: Record<string, JsonValue> = Object.create(null);
  const concrete: Record<string, JsonValue> = Object.create(null);
  const pending = new Map<string, Pending>();
  for (const [key, definition] of Object.entries(version.parameters)) {
    const authored = Object.hasOwn(inputs, key) ? inputs[key] : undefined;
    if (authored === undefined) { if (definition.defaultValue !== undefined) concrete[key] = definition.defaultValue; continue; }
    const capture = state(host);
    const value = await engine.interpolate(authored, { ...definition, ...(input.parameterVariables ? { variables: input.parameterVariables } : {}) }, `parameters.${key}`, hostScope(input.host, capture), false);
    stored[key] = value;
    if (!capture.deferred) { concrete[key] = value; continue; }
    if (typeof value !== "string") contentError("INVALID_VALUE", `parameters.${key} can only be left to the including template as one variable or as text.`);
    if (capture.literalBraces) contentError("INVALID_VALUE", `parameters.${key} cannot combine a variable that is still to be supplied with a value that contains \`{{\` or \`}}\`.`);
    const whole = wholeVariableExpression(value);
    pending.set(key, whole !== undefined && variableTokens(value).length === 1 ? { kind: "alias", expression: whole.trim() } : { kind: "text", text: value });
  }
  for (const [key, definition] of Object.entries(version.parameters)) {
    if (!pending.has(key)) validateContentValue(Object.hasOwn(concrete, key) ? concrete[key] : undefined, definition, `parameters.${key}`);
  }
  const parameters = immutableContent(concrete) as JsonObject;
  // The source's own validation needs every input; with one pending it runs when the host is bound.
  if (!pending.size) await resolvers.validateParameters?.(version, parameters);
  const catalogue = contentVariableCatalogue(version.parameters);
  const rules = pendingRules(pending);
  const blocks: ContentBlock[] = [];
  const deferred = new Set<string>();
  for (const source of variant.blocks) {
    const captured = await captureBlock(capturer, source, variant, (capture) => ({ catalogue, parameters, capture }), rules, 0);
    blocks.push(captured.block);
    if (captured.deferred) deferred.add(source.id);
  }
  const copy: InclusionCopy = { ...(variant.page ? { page: variant.page } : {}), source: await sourceRecord(blocks, deferred), blocks };
  return immutableContent({ parameters: stored as JsonObject, copy, authored: variant.blocks });
}

export type CaptureTemplateBlocksInput = {
  readonly tenantId: string;
  readonly channel: string;
  readonly locale: string;
  readonly version: ContentTemplateVersion;
  readonly variantId: string;
  /** The concrete values of the template's variables; a document supplies them all. */
  readonly parameters: JsonObject;
};

/**
 * The blocks of one template variant as a document receives them: every
 * variable resolved once with the document's values, every inclusion the
 * template holds settled into a complete literal copy. Nothing may stay
 * pending.
 */
export async function captureTemplateBlocks(input: CaptureTemplateBlocksInput, registryInput: CompiledContentBlockRegistry, resolvers: ContentResolvers): Promise<readonly ContentBlock[]> {
  request(input);
  const registry = validateContentRegistry(registryInput);
  const engine = createContentEngine(input, resolvers);
  const variant = input.version.variants.find((candidate) => candidate.id === input.variantId);
  if (!variant) contentError("DEPENDENCY_INVALID", "The template version has no such variant.");
  const catalogue = contentVariableCatalogue(input.version.parameters);
  const parameters = immutableContent(input.parameters) as JsonObject;
  const blocks: ContentBlock[] = [];
  for (const source of variant.blocks) {
    const captured = await captureBlock({ engine, registry, resolvers, channel: input.channel }, source, variant, (capture) => ({ catalogue, parameters, capture }), NO_CAPTURE, 0);
    blocks.push(captured.block);
  }
  return immutableContent(blocks);
}
