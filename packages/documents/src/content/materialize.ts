// SPDX-License-Identifier: BUSL-1.1
import { createContentEngine, type VariableScope } from "./engine.js";
import { contentError } from "./errors.js";
import { CONTENT_LIMITS, hashCanonicalJson, immutableContent, type JsonObject, type JsonValue } from "./json.js";
import { readInclusionCopy } from "./inclusion-copy.js";
import type {
  CompiledContentBlockDefinition,
  CompiledContentBlockRegistry,
  ContentBlock,
  ContentEntityReference,
  ContentResolvers,
  ContentTemplateVariant,
  MaterializeDocumentContentInput,
  MaterializedContentBlock,
  MaterializedDocumentContent,
  MaterializedTemplateContent,
  MaterializeTemplateContentInput,
} from "./types.js";
import {
  assertContentName,
  assertContentRecord,
  resolveTemplateParameters,
  selectContentTemplateVariant,
  validateContentRegistry,
  validateContentVariants,
  validateContentValues,
} from "./validation.js";
import { contentVariableCatalogue } from "./variables.js";

/**
 * Resolves content into data, not HTML. Renderers must escape/sanitize for their
 * output surface. Resolvers are authorized adapters, not a new persistence runtime.
 * Every call creates a fresh snapshot; no existing document or queued message is modified.
 *
 * An inclusion is read from the complete copy it stores (./inclusion-copy.ts):
 * its source template is never traversed here, so reading it needs no access
 * to that template. Content the server captured is data and is not bound
 * again; only a block the host authored itself, or one whose capture left a
 * binding pending for the host, is bound in the host's scope. A typed block
 * is executed on every read, under the reader, wherever it stands.
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
  const engine = createContentEngine(request, resolvers);
  const definitions: Record<string, CompiledContentBlockDefinition> = Object.create(null);
  const templates: MaterializedTemplateContent["templates"][number][] = [];
  const compositions: MaterializedTemplateContent["compositions"][number][] = [];
  const blocks: MaterializedContentBlock[] = [];

  async function visitBlocks(
    source: Pick<ContentTemplateVariant, "blocks" | "allowedDefinitions">,
    scope: VariableScope,
    path: readonly string[],
    literal: (block: ContentBlock) => boolean,
  ) {
    for (const sourceBlock of source.blocks) {
      engine.countBlock();
      const definition = Object.hasOwn(registry, sourceBlock.definitionKey)
        ? registry[sourceBlock.definitionKey]
        : undefined;
      if (!definition)
        contentError(
          "BLOCK_UNKNOWN",
          "Block definition is absent from the compiled entity metadata.",
        );
      if (source.allowedDefinitions && !source.allowedDefinitions.includes(sourceBlock.definitionKey))
        contentError("BLOCK_NOT_ALLOWED", "Block definition is not allowed in this collection.");
      if (sourceBlock.schemaVersion !== definition.schemaVersion)
        contentError(
          "BLOCK_SCHEMA_UNSUPPORTED",
          "Block requires a different compiled definition version.",
        );
      // Static metadata where a definition carries it, else what the host knows about the definition's inclusion fields.
      const composition = definition.composition ?? resolvers.compositionContract?.(sourceBlock.definitionKey);
      const renderer = Object.hasOwn(definition.renderers, request.channel)
        ? definition.renderers[request.channel]
        : undefined;
      if (!renderer && !composition)
        contentError("UNSUPPORTED_CHANNEL", "Block has no renderer for the requested channel.");
      definitions[sourceBlock.definitionKey] = definition;
      const block = engine.bindReferences(sourceBlock, definition, scope);
      const valueFields = Object.fromEntries(
        Object.entries(definition.fields).filter(([, field]) => !field.relationship),
      );
      const blockPath = [...path, block.id];
      if (composition) {
        // The inclusion's inputs are a record of what it was captured with, not text to bind.
        validateContentValues(block.values, valueFields, "block values");
        // An inclusion lays its copy out in the body; as a header or footer its own pages and frames would be lost.
        if ((block.region ?? "body") !== "body" || block.layoutKey)
          contentError("DEPENDENCY_INVALID", "A template inclusion must be a body block; header and footer inclusions are not supported.");
        if (!Object.hasOwn(definition.fields, composition.templateVersionField) ||
            definition.fields[composition.templateVersionField]?.relationship?.target !== "TemplateVersion")
          contentError("DEPENDENCY_INVALID", "Template inclusion must select a declared template-version relationship.");
        const reference = block.references[composition.templateVersionField] as ContentEntityReference | undefined;
        if (!reference || reference.versionId !== undefined)
          contentError(
            "DEPENDENCY_INVALID",
            "Template inclusion must reference an exact template-version entity id, without a second version pointer.",
          );
        if (blockPath.length >= CONTENT_LIMITS.templateDepth)
          contentError("CONTENT_LIMIT_EXCEEDED", "Template inclusion exceeds the maximum depth.");
        const copy = readInclusionCopy(block.values.content);
        const { content: _content, ...own } = block.values;
        engine.accountExpandedContent(own);
        compositions.push({
          path: blockPath,
          definitionKey: block.definitionKey,
          schemaVersion: block.schemaVersion,
          values: own,
          templateReference: reference,
          references: await engine.resolveReferences(block, composition.templateVersionField),
          ...(copy.page ? { page: copy.page } : {}),
        });
        const captured = new Set(copy.source.filter((entry) => !entry.deferred).map((entry) => entry.id));
        await visitBlocks({ blocks: copy.blocks }, scope, blockPath, (inner) => captured.has(inner.id));
        continue;
      }
      let values: JsonObject;
      if (literal(block)) values = block.values;
      else {
        // Markdown fields get their filled variables escaped; every other field keeps the raw value.
        const bound: Record<string, JsonValue> = Object.create(null);
        for (const key of Object.keys(block.values).sort()) {
          const field = Object.hasOwn(definition.fields, key) ? definition.fields[key] : undefined;
          bound[key] = await engine.interpolate(block.values[key]!, field, `block values.${key}`, scope, field?.osfType === "markdown");
        }
        values = bound;
      }
      validateContentValues(values, valueFields, "block values");
      engine.accountExpandedContent(values);
      await resolvers.validateBlockValues?.(block.definitionKey, immutableContent(values));
      const references = await engine.resolveReferences(block);
      engine.accountExpandedContent(references);
      const materialization = resolvers.materializeBlock
        ? immutableContent(await resolvers.materializeBlock({
            definitionKey: block.definitionKey, values: immutableContent(values),
            references: immutableContent(references), channel: request.channel, locale: request.locale,
          }))
        : undefined;
      if (materialization) {
        assertContentName(materialization.operationId, "materialization Operation");
        assertContentRecord(materialization.result, "materialization result");
        engine.accountExpandedContent(materialization);
        if (materialization.result.kind !== "block")
          contentError("INVALID_VALUE", "Materialization must return block values.");
        assertContentRecord(materialization.result.value, "materialized block values");
      }
      blocks.push({
        path: blockPath,
        id: block.id,
        definitionKey: block.definitionKey,
        schemaVersion: block.schemaVersion,
        renderer: renderer!,
        authoredValues: block.values,
        values,
        references,
        ...(materialization ? { materialization } : {}),
        ...(block.region ? { region: block.region } : {}),
        ...(block.layoutKey ? { layoutKey: block.layoutKey } : {}),
      });
    }
  }

  const captured = (block: ContentBlock) => block.captured === true;
  let ownPage: JsonObject | undefined;
  let identity: {templateVersionId:string;compositionHashVersion:"osf-template-content-v1"} | {documentId:string;documentVariantId:string;compositionHashVersion:"osf-document-content-v1"};
  if ("documentId" in request) {
    const variant=selectContentTemplateVariant({variants:request.variants},request.channel,request.locale);
    await visitBlocks(variant,{catalogue:contentVariableCatalogue({}),parameters:{}},[],captured);
    identity={documentId:request.documentId,documentVariantId:variant.id,compositionHashVersion:"osf-document-content-v1"};
    // A document that follows no template is its own root: its variant's page settings travel with its content.
    ownPage=variant.page;
  } else {
    const version = await engine.template(request.templateVersionId);
    const variant = selectContentTemplateVariant(version, request.channel, request.locale);
    const parameters = resolveTemplateParameters(version.parameters, request.parameters ?? {});
    await resolvers.validateParameters?.(version, parameters);
    // The variables this version's blocks may name: its own typed parameters
    // as `local`, the tenant's Chip catalogue as `chips`.
    const scope: VariableScope = { catalogue: contentVariableCatalogue(version.parameters), parameters };
    // Capture only the selected channel's source body; other channel variants are not output.
    templates.push({ path: [], version: { ...version, variants: [variant] }, variantId: variant.id, parameters });
    await visitBlocks(variant, scope, [], captured);
    identity={templateVersionId:request.templateVersionId,compositionHashVersion:"osf-template-content-v1"};
  }
  const snapshot = immutableContent({
    schemaVersion: 1 as const,
    tenantId: request.tenantId,
    ...identity,
    channel: request.channel,
    locale: request.locale,
    ...(ownPage ? { page: ownPage } : {}),
    blocks,
    compositions,
    templates,
    definitions,
    globals: engine.globals,
    ...(Object.keys(engine.paths).length ? { paths: engine.paths } : {}),
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
