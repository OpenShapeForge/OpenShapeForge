// SPDX-License-Identifier: BUSL-1.1
/**
 * The canonical write boundary of a template inclusion (docs/document-content.md,
 * "Inclusions are host-owned copies").
 *
 * Every write of a Block row passes here inside the transaction that stores
 * it. An inclusion's `content` is settled by the server: captured from its
 * source when the block is inserted, merged three ways when its version or
 * inputs change, and checked against the stored source record on every other
 * edit. The caller's `source` and `page` are never adopted. Capturing reads
 * the source and every record a variable names as the acting session; no
 * other identity is ever used.
 */
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationContext, RuntimeEntityValueCarrier } from "@openshapeforge/plugin-runtime";
import { parseSnapshot } from "@openshapeforge/versioning/snapshot";
import { contextServices, rows } from "./commands.js";
import { blockCollection, canonicalReader, compiledContentRegistry, contentResolvers, parameterShapes, pathResolver } from "./content-runtime.js";
import { captureInclusionContent, type CaptureHost, type CapturedInclusion } from "./content/capture.js";
import { contentError, TemplateContentError } from "./content/errors.js";
import { canonicalJson, CONTENT_LIMITS, type JsonObject } from "./content/json.js";
import {
  assertProtectedContentKept, holdsProtectedContent, inclusionCopyContent, isInclusionCopy, mergeInclusionCopy, nestedCopy, normalizeLocalDraft, protectedPaths, readInclusionCopy, templateComposition,
  type CompositionOf, type InclusionCopy,
} from "./content/inclusion-copy.js";
import type { ContentBlock, ContentResolvers } from "./content/types.js";
import { selectContentTemplateVariant } from "./content/validation.js";
import { contentVariableCatalogue } from "./content/variables.js";
import { templateParameterFields, withDocumentCommand } from "./document-blocks.js";
import { isObject, refuse } from "./validation.js";

type Row = Readonly<Record<string, unknown>>;

/**
 * Runs work as the session that is writing, with the platform services of
 * that session. The host supplies it; this module never builds a session.
 */
export type InclusionActor = <T>(work: (context: ModuleOperationContext) => Promise<T>) => Promise<T>;
export type InclusionWriteOptions = { readonly actor?: InclusionActor };

type Identity = { readonly versionId: string; readonly parameters: JsonObject };
type Stored = Identity & { readonly copy: InclusionCopy | undefined };
type Next = Identity & { readonly draft: unknown };
type Settled = { readonly parameters: JsonObject; readonly copy: InclusionCopy };
/** What an earlier prepare read captured, as the caller holds it: the copy its current draft was made of. */
type Baseline = Identity & { readonly content: unknown };
/** A prepared copy and, apart from the local content merged into it, the capture it was prepared from. */
type Prepared = Settled & { readonly baseline: InclusionCopy };

type Environment = {
  readonly compositionOf: CompositionOf;
  capture(identity: Identity): Promise<CapturedInclusion>;
  /** The source variant's own blocks at `versionId`, or undefined when the acting session can no longer read it. */
  authored(versionId: string): Promise<readonly ContentBlock[] | undefined>;
};

const compositionFor = (carrier: RuntimeEntityValueCarrier): CompositionOf => (definitionKey) => {
  const entry = Object.hasOwn(carrier.definitions, definitionKey) ? carrier.definitions[definitionKey] : undefined;
  return entry ? templateComposition(entry.fields) : undefined;
};
const record = (value: unknown): JsonObject => (isObject(value) ? value : {}) as JsonObject;

function countBlocks(copy: InclusionCopy, compositionOf: CompositionOf, depth = 0): number {
  if (depth >= CONTENT_LIMITS.templateDepth) refuse("CONTENT_LIMIT_EXCEEDED", "Included content exceeds the maximum depth.");
  return copy.blocks.reduce((total, block) => { const nested = nestedCopy(block, compositionOf); return total + 1 + (nested ? countBlocks(nested, compositionOf, depth + 1) : 0); }, 0);
}

const sameIdentity = (stored: Stored | undefined, next: Identity): boolean =>
  stored !== undefined && stored.versionId === next.versionId && canonicalJson(stored.parameters) === canonicalJson(next.parameters);
/** A draft whose source record differs from the stored one: what the prepare read returned, to be captured again. */
const isPreparedDraft = (stored: Stored | undefined, draft: unknown): boolean =>
  stored?.copy !== undefined && isObject(draft) && draft.source !== undefined
    && canonicalJson(draft.source) !== canonicalJson(inclusionCopyContent(stored.copy).source);

/**
 * One inclusion, at any depth: unchanged, edited, captured or updated.
 *
 * What the draft is, is read from the server's own record, never from a
 * claim of the caller:
 *
 * - same version and inputs, and a draft that carries the stored source
 *   record (or none): an ordinary edit. Nothing is captured; the stored
 *   record stays.
 * - a draft whose source record differs from the stored one: a prepared
 *   update — what the prepare read returned, possibly edited since. The
 *   source is captured again as the acting session and the draft's record
 *   and page settings must equal that capture exactly; a hash or lock is
 *   never adopted from the draft. Its blocks are then checked against the
 *   new record, and against what the stored copy protects. With the same
 *   version and inputs this is the deliberate refresh.
 * - another version or input with the stored record (or no content): the
 *   update is merged here from the stored baseline.
 *
 * `explicit` is the prepare read: it always captures and merges, also for an
 * unchanged version and inputs, and takes only a draft of the stored baseline.
 * A draft of an earlier preparation goes through `settlePrepared` instead.
 */
async function settle(environment: Environment, stored: Stored | undefined, next: Next, explicit = false): Promise<Settled & { readonly baseline?: InclusionCopy }> {
  const { compositionOf } = environment;
  const settleNested = (input: { stored: ContentBlock | undefined; draft: ContentBlock }) => settleBlock(environment, input.stored, input.draft);
  const prepared = isPreparedDraft(stored, next.draft);
  if (stored?.copy && sameIdentity(stored, next) && !prepared && !explicit) {
    // An ordinary edit: the stored source record and page settings stay, the draft is checked against them.
    if (next.draft === undefined) return { parameters: stored.parameters, copy: stored.copy };
    return { parameters: stored.parameters, copy: { ...stored.copy, blocks: await normalizeLocalDraft(stored.copy, next.draft, { compositionOf, settleNested }) } };
  }
  if (prepared && explicit)
    contentError("INVALID_VALUE", "This draft was already prepared from another source record than the saved one. Send the baseline that preparation returned to prepare it again; the existing inclusion has been kept.");
  const captured = await environment.capture(next);
  if (!stored?.copy) {
    // Nothing was captured before. A draft that arrives with the insertion is local content over the baseline captured now.
    const drafted = isObject(next.draft) && Array.isArray(next.draft.blocks) && next.draft.blocks.length > 0;
    if (!drafted) return { parameters: captured.parameters, copy: captured.copy, baseline: captured.copy };
    return { parameters: captured.parameters, baseline: captured.copy, copy: { ...captured.copy, blocks: await normalizeLocalDraft(captured.copy, next.draft, { compositionOf, settleNested, freshBaseline: true }) } };
  }
  if (prepared) {
    const draft = next.draft as Record<string, unknown>;
    const fresh = inclusionCopyContent(captured.copy);
    if (canonicalJson(draft.source) !== canonicalJson(fresh.source) || canonicalJson(draft.page ?? null) !== canonicalJson(fresh.page ?? null))
      contentError("INVALID_VALUE", "The prepared update no longer matches its source or the records it names. Prepare it again; the existing inclusion has been kept.");
    const blocks = await normalizeLocalDraft(captured.copy, draft, { compositionOf, settleNested });
    assertProtectedContentKept(protectedPaths(stored.copy.source, stored.copy.blocks, compositionOf), blocks, compositionOf,
      "The update no longer holds content that is protected here. The existing inclusion has been kept.");
    return { parameters: captured.parameters, copy: { ...captured.copy, blocks } };
  }
  // The version or an input changed: the current local content, the stored baseline and the new capture are merged, or the write is refused whole.
  const current = next.draft === undefined ? stored.copy.blocks : await normalizeLocalDraft(stored.copy, next.draft, { compositionOf, settleNested });
  const authoredOld = await environment.authored(stored.versionId);
  const copy = await mergeInclusionCopy({ baseline: stored.copy.source, current, ...(authoredOld ? { authoredOld } : {}), authoredNew: captured.authored, captured: captured.copy, compositionOf });
  return { parameters: captured.parameters, copy, baseline: captured.copy };
}

/**
 * The prepare read for a draft that was prepared before: the caller sends the
 * baseline that earlier read returned, and the draft it has made of it since.
 *
 * Nothing of that baseline is taken on the caller's word. Its version is
 * captured again with its inputs as the acting session — which is also what
 * authorizes reading that source — and the baseline must be exactly that
 * capture: content, source record, locks and page settings. A baseline the
 * server would not capture now, because it was altered or because a record it
 * names changed since, refuses the read. The capture, not the claim, is then
 * the baseline the draft is checked against and merged from.
 *
 * What the saved copy protects, when there is one, still decides: it must be
 * held by that baseline and by the copy this read answers with.
 */
async function settlePrepared(environment: Environment, stored: Stored | undefined, baseline: Baseline, next: Next): Promise<Prepared> {
  const { compositionOf } = environment;
  const settleNested = (input: { stored: ContentBlock | undefined; draft: ContentBlock }) => settleBlock(environment, input.stored, input.draft);
  const kept = "The update no longer holds content that is protected here. The existing inclusion has been kept.";
  const base = await environment.capture(baseline);
  if (!isObject(baseline.content) || canonicalJson(baseline.parameters) !== canonicalJson(base.parameters)
    || canonicalJson(baseline.content as JsonObject) !== canonicalJson(inclusionCopyContent(base.copy)))
    contentError("INVALID_VALUE", "The earlier preparation no longer matches its source or the records it names, so the draft made of it cannot be carried to another source. Nothing has been changed; the existing inclusion has been kept.");
  const required = stored?.copy ? protectedPaths(stored.copy.source, stored.copy.blocks, compositionOf) : [];
  assertProtectedContentKept(required, base.copy.blocks, compositionOf, kept);
  const current = next.draft === undefined ? base.copy.blocks : await normalizeLocalDraft(base.copy, next.draft, { compositionOf, settleNested });
  const captured = await environment.capture(next);
  const authoredOld = await environment.authored(baseline.versionId);
  const copy = await mergeInclusionCopy({ baseline: base.copy.source, current, ...(authoredOld ? { authoredOld } : {}), authoredNew: captured.authored, captured: captured.copy, compositionOf });
  assertProtectedContentKept(required, copy.blocks, compositionOf, kept);
  return { parameters: captured.parameters, copy, baseline: captured.copy };
}

function identityOf(block: ContentBlock, compositionOf: CompositionOf): Identity {
  const composition = compositionOf(block.definitionKey)!;
  const reference = block.references[composition.templateVersionField];
  if (!reference || Array.isArray(reference) || !("id" in reference) || reference.entity !== "TemplateVersion" || typeof reference.id !== "string")
    refuse("DEPENDENCY_INVALID", "A nested inclusion names one published template version.");
  return { versionId: (reference as { id: string }).id, parameters: record(composition.parametersField ? block.values[composition.parametersField] : undefined) };
}

async function settleBlock(environment: Environment, previous: ContentBlock | undefined, draft: ContentBlock): Promise<ContentBlock> {
  const { compositionOf } = environment;
  const composition = compositionOf(draft.definitionKey)!;
  const stored = previous ? { ...identityOf(previous, compositionOf), copy: nestedCopy(previous, compositionOf) } : undefined;
  const settled = await settle(environment, stored, { ...identityOf(draft, compositionOf), draft: draft.values.content });
  return { ...draft, values: { ...draft.values, ...(composition.parametersField ? { [composition.parametersField]: settled.parameters } : {}), content: inclusionCopyContent(settled.copy) } };
}

/** The scope the block's owner offers: a template's variables without values, a document's with the values it holds. */
async function loadHost(context: ModuleOperationContext, trx: unknown, tenantId: string, row: Row): Promise<{ channel: string; locale: string; host: CaptureHost }> {
  if (row.document_variant_id) {
    const found = (await rows<{ channel: string; locale: string; template_version_id: string | null; parameters: unknown }>(trx,
      `select v.channel, v.locale, d.template_version_id, d.parameters from erp.document_variants v
        join erp.documents d on d.tenant_id = v.tenant_id and d.id = v.document_id
        where v.tenant_id = $1 and v.id = $2 for share of v`, [tenantId, row.document_variant_id]))[0];
    if (!found) refuse("NOT_FOUND", "The owning document variant is not available.");
    let fields: readonly Record<string, unknown>[] = [];
    if (found!.template_version_id) {
      const version = (await rows<{ snapshot: unknown }>(trx, "select snapshot from erp.template_versions where tenant_id = $1 and id = $2 for share", [tenantId, found!.template_version_id]))[0];
      if (version) fields = templateParameterFields(parseSnapshot(version.snapshot));
    }
    return { channel: found!.channel, locale: found!.locale, host: { catalogue: contentVariableCatalogue(parameterShapes(context, fields)), parameters: record(found!.parameters) } };
  }
  const found = (await rows<{ channel: string; locale: string; parameters: unknown }>(trx,
    `select v.channel, v.locale, t.parameters from erp.template_variants v
      join erp.templates t on t.tenant_id = v.tenant_id and t.id = v.template_id
      where v.tenant_id = $1 and v.id = $2 for share of v`, [tenantId, row.variant_id]))[0];
  if (!found) refuse("NOT_FOUND", "The owning template variant is not available.");
  const fields = Array.isArray(found!.parameters) ? found!.parameters.filter(isObject) : [];
  return { channel: found!.channel, locale: found!.locale, host: { catalogue: contentVariableCatalogue(parameterShapes(context, fields)) } };
}

function environment(trx: unknown, tenantId: string, carrier: RuntimeEntityValueCarrier, row: Row, parameterVariables: unknown, actor: InclusionActor | undefined): Environment {
  const acting = <T>(work: (context: ModuleOperationContext, host: Awaited<ReturnType<typeof loadHost>>, resolvers: ContentResolvers) => Promise<T>): Promise<T> => {
    if (!actor) refuse("OPERATION_UNAVAILABLE", "Capturing a template inclusion requires the session that inserts or updates it.");
    return actor!(async (context) => {
      const { platform, session } = contextServices(context);
      if (session.tenantId !== tenantId) refuse("FORBIDDEN", "The inclusion belongs to another tenant.");
      const host = await loadHost(context, trx, tenantId, row);
      const operations = await platform.operations.list(session);
      const read = canonicalReader(context, operations);
      const resolveVariablePath = pathResolver(context, operations, read);
      const resolvers = contentResolvers(context, trx, {
        tenantId, channel: host.channel, locale: host.locale, carrier, read,
        allowedDefinitions: blockCollection(context, carrier, "TemplateVariant").allowedDefinitions,
        ...(resolveVariablePath ? { resolveVariablePath } : {}),
      });
      return work(context, host, resolvers);
    });
  };
  return {
    compositionOf: compositionFor(carrier),
    capture: (identity) => acting(async (context, host, resolvers) => captureInclusionContent({
      tenantId, channel: host.channel, locale: host.locale, templateVersionId: identity.versionId, parameters: identity.parameters, host: host.host,
      ...(typeof parameterVariables === "string" ? { parameterVariables: parameterVariables as "whole" | "template" | "both" } : {}),
    }, await compiledContentRegistry(context, carrier), resolvers)),
    authored: (versionId) => acting(async (_context, host, resolvers) => {
      try {
        const version = await resolvers.resolveTemplateVersion(versionId, { tenantId });
        return version ? selectContentTemplateVariant(version, host.channel, host.locale).blocks : undefined;
      } catch {
        // Without the earlier source there is no authored comparison; the merge then keeps every local change.
        return undefined;
      }
    }),
  };
}

function inclusionOf(carrier: RuntimeEntityValueCarrier, row: Row | undefined) {
  if (!row) return undefined;
  const definition = carrier.definitions[String(row[carrier.definitionColumn])];
  const composition = definition ? templateComposition(definition.fields) : undefined;
  if (!definition || !composition) return undefined;
  const reference = definition.references.find((candidate) => candidate.fieldKey === composition.templateVersionField);
  if (!reference) refuse("DEPENDENCY_INVALID", "The inclusion has no typed source reference.");
  const values = record(row[carrier.valuesColumn]);
  const parametersDefinition = definition.fields.find((field) => field.key === composition.parametersField);
  return {
    definition, composition, reference: reference!, values, parameterVariables: parametersDefinition?.variables,
    versionId: typeof row[reference!.column] === "string" ? row[reference!.column] as string : undefined,
    bound: reference!.parameterColumn ? row[reference!.parameterColumn] != null : false,
    copy: isInclusionCopy(values.content) ? readInclusionCopy(values.content) : undefined,
  };
}

/** A document block the document received from its template is marked once a canonical write changes it, so a later link keeps the change. */
async function markLocalChange(trx: unknown, tenantId: string, carrier: RuntimeEntityValueCarrier, before: Row | undefined, after: Row, values: unknown): Promise<void> {
  if (!before?.document_variant_id || before.origin !== "template" || before.diverged === true) return;
  const definition = carrier.definitions[String(before[carrier.definitionColumn])];
  const columns = ["region", "layout_key", ...(definition?.references.flatMap((reference) => [reference.column, ...(reference.parameterColumn ? [reference.parameterColumn] : [])]) ?? [])];
  const changed = canonicalJson(before[carrier.valuesColumn] ?? null) !== canonicalJson(values ?? null)
    || columns.some((key) => canonicalJson(before[key] ?? null) !== canonicalJson(after[key] ?? null));
  if (!changed) return;
  await withDocumentCommand(trx, "link", () => rows(trx, "update erp.blocks set diverged = true where tenant_id = $1 and id = $2", [tenantId, before.id]));
}

function lockedRow(carrier: RuntimeEntityValueCarrier, before: Row | undefined, after: Row | undefined): void {
  if (!before?.document_variant_id || before.locked !== true) return;
  const definition = carrier.definitions[String(before[carrier.definitionColumn])];
  const columns = [carrier.definitionColumn, carrier.valuesColumn, "locked", "definition_version", "document_variant_id", "document_variant_id_position", "region", "layout_key", ...(definition?.references.flatMap((reference) => [reference.column, ...(reference.parameterColumn ? [reference.parameterColumn] : [])]) ?? [])];
  if (!after || columns.some((key) => canonicalJson(before[key] ?? null) !== canonicalJson(after[key] ?? null))) refuse("INVALID_STATE", "This document block is locked by its source and cannot be changed, moved or removed.");
}

async function prepare(trx: unknown, tenantId: string, carrier: RuntimeEntityValueCarrier, before: Row | undefined, after: Row, options: InclusionWriteOptions): Promise<JsonObject | undefined> {
  if (carrier.entityName !== "Block") return undefined;
  lockedRow(carrier, before, after);
  const next = inclusionOf(carrier, after);
  const previous = inclusionOf(carrier, before);
  const compositionOf = compositionFor(carrier);
  // What the stored row protects is checked before anything else: a row cannot stop being an inclusion, or become
  // an inclusion of another kind, while its copy holds protected content there would be no place left for.
  if (previous?.copy && holdsProtectedContent(previous.copy, compositionOf) && (!next || before![carrier.definitionColumn] !== after[carrier.definitionColumn]))
    refuse("INVALID_STATE", "Protected template content cannot be removed or replaced through its enclosing block.");
  if (!next) return undefined;
  if (next.bound || !next.versionId) refuse("INVALID_STATE", "An inclusion captures one published template version; choose the version instead of leaving it to a variable.");
  if (before && previous?.copy && holdsProtectedContent(previous.copy, compositionOf)
    && ["document_variant_id", "document_variant_id_position", "variant_id", "variant_id_position"].some((key) => canonicalJson(before[key] ?? null) !== canonicalJson(after[key] ?? null)))
    refuse("INVALID_STATE", "A block containing protected template content cannot be moved out of its placement.");
  const parametersField = next.composition.parametersField;
  const stored = previous?.versionId ? { versionId: previous.versionId, parameters: record(previous.values[parametersField]), copy: previous.copy } : undefined;
  const settled = await settle(environment(trx, tenantId, carrier, after, next.parameterVariables, options.actor), stored,
    { versionId: next.versionId!, parameters: record(next.values[parametersField]), draft: next.values.content });
  if (countBlocks(settled.copy, compositionOf) > CONTENT_LIMITS.blocks) refuse("CONTENT_LIMIT_EXCEEDED", "Included content contains too many blocks.");
  const values = { ...next.values, [parametersField]: settled.parameters, content: inclusionCopyContent(settled.copy) } as JsonObject;
  // Also the size budget of what is stored.
  canonicalJson(values);
  return values;
}

/** The fields of an inclusion that only record where its stored copy came from. */
export type RetainedInclusionProvenance = { readonly referenceField: string; readonly parametersField: string };

/**
 * Whether an update keeps the source of a stored inclusion as it is: the row
 * the server holds (`before`) already carries a complete copy, and the row as
 * it would be written (`after`) names the same version with the same inputs
 * and does not offer a prepared source record. That is exactly the ordinary
 * edit `settle` decides on, for which nothing is captured and the source is
 * not read: its version reference and inputs are then provenance of the
 * stored copy, not a live dependency of this write. The answer comes from the
 * stored row alone; nothing the caller sends can label a write as retained
 * other than repeating what is stored. Every other write — an insertion,
 * another version or input, a prepared copy or refresh, a row stored before
 * copies existed — returns undefined and reads its source as the caller.
 */
export function retainedInclusionProvenance(carrier: RuntimeEntityValueCarrier, before: Row | undefined, after: Row): RetainedInclusionProvenance | undefined {
  if (carrier.entityName !== "Block" || !before || before[carrier.definitionColumn] !== after[carrier.definitionColumn]) return undefined;
  try {
    const previous = inclusionOf(carrier, before);
    if (!previous?.copy || !previous.versionId || previous.bound) return undefined;
    const { composition, reference } = previous;
    if (after[reference.column] !== previous.versionId || (reference.parameterColumn && after[reference.parameterColumn] != null)) return undefined;
    const values = record(after[carrier.valuesColumn]);
    const stored = { versionId: previous.versionId, parameters: record(previous.values[composition.parametersField]), copy: previous.copy };
    if (!sameIdentity(stored, { versionId: previous.versionId, parameters: record(values[composition.parametersField]) }) || isPreparedDraft(stored, values.content)) return undefined;
    return { referenceField: composition.templateVersionField, parametersField: composition.parametersField };
  } catch (error) { contentRefusal(error); }
}

function contentRefusal(error: unknown): never {
  if (error instanceof TemplateContentError) throw operationFailure({ code: error.code === "INVALID_VALUE" ? "INVALID_STATE" : error.code, message: error.message, retryable: false });
  throw error;
}

/**
 * Called for every insert and update of a Block row, before it is stored,
 * with the row as it is (`before`, absent on insert) and as it would be
 * written (`after`). Returns the values to store for an inclusion — its
 * inputs as resolved and its complete server-settled content — and undefined
 * for every other block. Any refusal leaves the transaction to roll back as a
 * whole: no copy is ever partly written.
 */
export async function prepareBlockInclusionWrite(trx: unknown, tenantId: string, carrier: RuntimeEntityValueCarrier, before: Row | undefined, after: Row, options: InclusionWriteOptions = {}): Promise<JsonObject | undefined> {
  try {
    const values = await prepare(trx, tenantId, carrier, before, after, options);
    // The one statement this boundary issues itself, and only on the write path: the prepare read shares `settle` and never reaches it.
    await markLocalChange(trx, tenantId, carrier, before, after, values ?? after[carrier.valuesColumn]);
    return values;
  } catch (error) { contentRefusal(error); }
}

export type InclusionPreparation = {
  readonly tenantId: string;
  readonly carrier: RuntimeEntityValueCarrier;
  /** The collection the inclusion is, or will be, a block of. The caller has verified update access to it. */
  readonly host: { readonly entity: "TemplateVariant" | "DocumentVariant"; readonly id: string };
  /** The saved root block of the inclusion; absent for one that is not stored yet. */
  readonly blockId?: string;
  /** Block ids from that root down to an inclusion nested in its copy. */
  readonly path: readonly string[];
  readonly definitionKey: string;
  readonly versionId: string;
  readonly parameters: JsonObject;
  /** The local draft: of the saved inclusion and its stored source record, or of `baseline` when that is given. Absent to use that copy as it is. */
  readonly draft: unknown;
  /** The baseline an earlier preparation returned, when the draft was made of it. It is captured again, never trusted. */
  readonly baseline?: { readonly versionId: string; readonly parameters: JsonObject; readonly content: unknown };
};

/**
 * The read behind an insertion or update dialog: what the inclusion would
 * hold if it were saved with this version, these inputs and this draft. The
 * source is captured as the acting session and merged with the stored copy
 * by the same `settle` a write runs. Nothing is written, marked, staged or
 * bound here; a refusal changes nothing, so the caller keeps its draft.
 *
 * The answer also carries `baseline`: the capture alone, without the local
 * content merged into `copy`. A caller that prepares again sends it back with
 * the draft it has made since, so that draft is merged instead of lost.
 */
export async function prepareInclusionCopy(context: ModuleOperationContext, trx: unknown, request: InclusionPreparation): Promise<Prepared> {
  const { tenantId, carrier, host } = request;
  const compositionOf = compositionFor(carrier);
  const definition = Object.hasOwn(carrier.definitions, request.definitionKey) ? carrier.definitions[request.definitionKey] : undefined;
  const composition = definition ? templateComposition(definition.fields) : undefined;
  if (!definition || !composition) refuse("INVALID_DEFINITION", "Only a template inclusion is prepared.");
  const ownerColumn = host.entity === "DocumentVariant" ? "document_variant_id" : "variant_id";
  let stored: Stored | undefined;
  try {
    if (request.blockId) {
      const row = (await rows<{ row: Record<string, unknown> }>(trx, "select to_jsonb(b.*) as row from erp.blocks b where b.tenant_id = $1 and b.id = $2", [tenantId, request.blockId]))[0]?.row;
      // A block of another host, or of another tenant, is not found: nothing about it is confirmed.
      if (!row || row[ownerColumn] !== host.id) refuse("NOT_FOUND", "The inclusion is not a block of this host.");
      const root = inclusionOf(carrier, row);
      if (!root?.versionId) refuse("INVALID_STATE", "The block is not a template inclusion.");
      let found: Stored | undefined = { versionId: root!.versionId!, parameters: record(root!.values[root!.composition.parametersField]), copy: root!.copy };
      let key = String(row![carrier.definitionColumn]);
      for (const id of request.path) {
        const inner: ContentBlock | undefined = found?.copy?.blocks.find((block) => block.id === id);
        // A step that is stored must be an inclusion with a complete copy to walk on in.
        if (!found?.copy || (inner && !compositionOf(inner.definitionKey))) refuse("NOT_FOUND", "The path does not lead to an inclusion of this block.");
        key = inner?.definitionKey ?? request.definitionKey;
        found = inner ? { ...identityOf(inner, compositionOf), copy: nestedCopy(inner, compositionOf) } : undefined;
        // A step that is not stored names an inclusion the draft adds. Nothing is stored below it, so nothing stored
        // is protected there: the rest of the path names unsaved content as well.
        if (!inner) break;
      }
      if (key !== request.definitionKey) refuse("INVALID_STATE", "The stored block is an inclusion of another kind.");
      stored = found;
    } else if (request.path.length) refuse("VALIDATION", "A path selects an inclusion nested in a saved block; name that block.");
    const parametersField = definition!.fields.find((field) => field.key === composition!.parametersField);
    const acting = environment(trx, tenantId, carrier, { [ownerColumn]: host.id }, parametersField?.variables, (work) => work(context));
    const next = { versionId: request.versionId, parameters: request.parameters, draft: request.draft };
    const settled = request.baseline ? await settlePrepared(acting, stored, request.baseline, next) : await settle(acting, stored, next, true);
    if (countBlocks(settled.copy, compositionOf) > CONTENT_LIMITS.blocks) refuse("CONTENT_LIMIT_EXCEEDED", "Included content contains too many blocks.");
    // An explicit settle always captures, so it always answers with the capture it merged from.
    return { parameters: settled.parameters, copy: settled.copy, baseline: settled.baseline! };
  } catch (error) { contentRefusal(error); }
}

/**
 * Called before a Block row is removed, or moved within or out of its
 * collection. A source-locked document block stays where it is, and so does
 * any inclusion whose copy — at any depth — holds content its source protects.
 */
export async function assertBlockInclusionRemoval(carrier: RuntimeEntityValueCarrier, row: Row | undefined): Promise<void> {
  if (carrier.entityName !== "Block" || !row) return;
  try {
    lockedRow(carrier, row, undefined);
    const stored = inclusionOf(carrier, row);
    if (stored?.copy && holdsProtectedContent(stored.copy, compositionFor(carrier))) refuse("INVALID_STATE", "A block containing protected template content cannot be removed or moved.");
  } catch (error) { contentRefusal(error); }
}
