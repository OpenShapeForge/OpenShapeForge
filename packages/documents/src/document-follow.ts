// SPDX-License-Identifier: BUSL-1.1
/**
 * The follow-template rule (docs/document-content.md): a document moves to a
 * template version only when Document.linkTemplate says so, variant by
 * variant. Publishing a template never changes a document. `planFollow` is
 * the pure decision per variant; `applyTemplateVersion` applies it to one
 * document inside the caller's transaction.
 *
 * What a document receives is captured content: the template's blocks with
 * every variable resolved once from the document's values, and every
 * inclusion the template holds as a complete literal copy. A block the
 * document changed is kept; an inclusion both sides changed is merged from
 * its own source record or refuses the link as a whole.
 */
import { operationFailure } from "@openshapeforge/operations";
import type { RuntimeEntityValueCarrier } from "@openshapeforge/plugin-runtime";
import { orderedChildren, rowId, type PublishedSnapshot, type SnapshotNode } from "@openshapeforge/versioning/snapshot";
import { rows } from "./commands.js";
import { blockHash, holdsProtectedContent, inclusionCopyContent, isInclusionCopy, mergeInclusionCopy, readInclusionCopy, templateComposition, type CompositionOf } from "./content/inclusion-copy.js";
import type { ContentBlock } from "./content/types.js";
import {
  blockContent, contentKey, deleteDocumentBlocks, insertDocumentBlock, insertDocumentVariant, listDocumentBlocks, listDocumentVariants,
  markBlocksDiverged, readTemplateVersion, replaceDocumentBlockContent, templateVariants, updateBlockPositions,
  type BlockColumns, type BlockContent, type DocumentBlockRow, type DocumentVariantRow, type TemplateVersionRow,
} from "./document-blocks.js";

export type FollowBlock = Readonly<{ id: string; origin: string; templateBlockId: string | null; diverged: boolean; key: string }>;
export type FollowTemplateBlock = Readonly<{ templateBlockId: string; key: string; locked: boolean }>;
export type FollowSlot = Readonly<{ kind: "existing"; id: string } | { kind: "insert"; templateBlockId: string }>;
export type FollowPlan = Readonly<{
  /** Final collection order: existing rows and template blocks to insert. */
  order: readonly FollowSlot[];
  /** Existing template blocks whose content is replaced by the new snapshot block. */
  reseed: readonly Readonly<{ id: string; templateBlockId: string }>[];
  /** Existing blocks that keep a local edit and are flagged. */
  diverge: readonly string[];
  remove: readonly string[];
  insert: readonly string[];
}>;

/**
 * `previous` maps template block id to the content key the variant was seeded
 * from; local changes and deletions survive source changes. A newly locked
 * block conflicts with existing local changes instead of overwriting them.
 * Local blocks and kept diverged blocks trail the template block that
 * preceded them. A second row claiming the same template block is treated as
 * a local block.
 */
export function planFollow(current: readonly FollowBlock[], previous: ReadonlyMap<string, string>, next: readonly FollowTemplateBlock[]): FollowPlan {
  const nextById = new Map(next.map((block) => [block.templateBlockId, block]));
  const trailers = new Map<string | null, string[]>();
  const slotFor = new Map<string, string>();
  const reseed: { id: string; templateBlockId: string }[] = [];
  const diverge: string[] = [];
  const remove: string[] = [];
  const seen = new Set<string>();
  const trail = (anchor: string | null, id: string) => trailers.set(anchor, [...(trailers.get(anchor) ?? []), id]);
  let anchor: string | null = null;
  for (const block of current) {
    const templateBlockId = block.origin === "template" && block.templateBlockId && !seen.has(block.templateBlockId) ? block.templateBlockId : null;
    if (!templateBlockId) { trail(anchor, block.id); continue; }
    seen.add(templateBlockId);
    const upcoming = nextById.get(templateBlockId);
    const edited = block.diverged || previous.get(templateBlockId) !== block.key;
    if(upcoming?.locked&&edited)throw operationFailure({code:'INVALID_STATE',message:'The new template locks locally changed content; the existing document has been kept.',retryable:false});
    if (upcoming && !edited) { reseed.push({ id: block.id, templateBlockId }); slotFor.set(templateBlockId, block.id); anchor = templateBlockId; }
    else if (upcoming) { diverge.push(block.id); slotFor.set(templateBlockId, block.id); anchor = templateBlockId; }
    else if (!edited) remove.push(block.id);
    else { diverge.push(block.id); trail(anchor, block.id); }
  }
  const insert: string[] = [];
  const order: FollowSlot[] = (trailers.get(null) ?? []).map((id) => ({ kind: "existing", id }));
  for (const block of next) {
    if(previous.has(block.templateBlockId)&&!seen.has(block.templateBlockId)){
      if(block.locked)throw operationFailure({code:'INVALID_STATE',message:'The new template protects locally removed content; the existing document has been kept.',retryable:false});
      continue;
    }
    const existing = slotFor.get(block.templateBlockId);
    if (existing) order.push({ kind: "existing", id: existing });
    else { insert.push(block.templateBlockId); order.push({ kind: "insert", templateBlockId: block.templateBlockId }); }
    for (const id of trailers.get(block.templateBlockId) ?? []) order.push({ kind: "existing", id });
  }
  return { order, reseed, diverge, remove, insert };
}

export type TrackedDocument = Readonly<{ id: string; template_version_id: string | null }>;
/**
 * `capture` returns the blocks of one variant of the version being linked as
 * this document receives them (content/capture.ts `captureTemplateBlocks`),
 * limited to the definitions a document may hold. It runs as the session
 * that links.
 */
export type ApplyContext = Readonly<{
  trx: unknown; columns: BlockColumns; permitted: ReadonlySet<string>; carrier: RuntimeEntityValueCarrier; tracked: Map<string, TemplateVersionRow | undefined>;
  capture: (variant: Readonly<{ id: string; channel: string; locale: string }>) => Promise<readonly ContentBlock[]>;
}>;

const variantBlocks = (node: SnapshotNode) => orderedChildren(node, "blocks", "variant_id_position");
const TOUCH = "updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')";

type VariantFollow = Readonly<{ problems: readonly string[]; changed: boolean }>;

/** The row content of one captured block: the snapshot row's own columns, with the resolved values and concrete references. */
function capturedContent(node: SnapshotNode, block: ContentBlock, apply: ApplyContext): BlockContent {
  const { carrier, columns } = apply;
  const content: Record<string, unknown> = { ...blockContent(node.row, columns), [carrier.valuesColumn]: block.values };
  if (columns.has("locked")) content.locked = block.locked === true;
  if (columns.has("editable_children")) content.editable_children = block.editableChildren === true ? true : null;
  if (columns.has("lock_override")) content.lock_override = null;
  for (const reference of carrier.definitions[block.definitionKey]?.references ?? []) {
    const value = block.references[reference.fieldKey];
    if (columns.has(reference.column)) content[reference.column] = value && !Array.isArray(value) && "id" in value ? value.id : null;
    if (reference.parameterColumn && columns.has(reference.parameterColumn)) content[reference.parameterColumn] = null;
  }
  return content;
}

const compositionFor = (carrier: RuntimeEntityValueCarrier): CompositionOf => (key) => { const entry = carrier.definitions[key]; return entry ? templateComposition(entry.fields) : undefined; };

/** The authored blocks of the inclusion a snapshot row stores, when it stores a complete copy. */
function authoredInclusion(node: SnapshotNode | undefined, carrier: RuntimeEntityValueCarrier): readonly ContentBlock[] | undefined {
  const content = (node?.row[carrier.valuesColumn] as Record<string, unknown> | null | undefined)?.content;
  return isInclusionCopy(content) ? readInclusionCopy(content).blocks : undefined;
}

/**
 * An inclusion the document already holds is updated from its own source
 * record: local changes inside it stay, untouched blocks adopt the new
 * capture, and a real conflict refuses the link. Returns the content to
 * write and whether it still differs from the template's.
 */
async function followInclusion(apply: ApplyContext, row: DocumentBlockRow, previous: SnapshotNode | undefined, next: SnapshotNode, block: ContentBlock): Promise<{ content: BlockContent; local: boolean } | undefined> {
  const { carrier } = apply;
  const compositionOf = compositionFor(carrier);
  const stored = (row[carrier.valuesColumn] as Record<string, unknown> | null | undefined)?.content;
  if (!compositionOf(block.definitionKey) || row[carrier.definitionColumn] !== block.definitionKey || !isInclusionCopy(stored) || !isInclusionCopy(block.values.content)) return undefined;
  const current = readInclusionCopy(stored), captured = readInclusionCopy(block.values.content);
  const authoredOld = authoredInclusion(previous, carrier);
  const merged = await mergeInclusionCopy({ baseline: current.source, current: current.blocks, ...(authoredOld ? { authoredOld } : {}), authoredNew: authoredInclusion(next, carrier) ?? [], captured, compositionOf });
  const result: ContentBlock = { ...block, values: { ...block.values, content: inclusionCopyContent(merged) } };
  return { content: capturedContent(next, result, apply), local: await blockHash(result) !== await blockHash(block) };
}

/** Re-seeds one variant; `changed` says whether any block row was written, which is what drafts the document. */
async function followVariant(apply: ApplyContext, variant: DocumentVariantRow, previousVariant: SnapshotNode | undefined, nextVariant: SnapshotNode): Promise<VariantFollow> {
  const { trx, columns } = apply;
  const previousNodes = new Map((previousVariant ? variantBlocks(previousVariant) : []).map((node) => [rowId(node), node]));
  const allNext = variantBlocks(nextVariant);
  const skipped = [...new Set(allNext.filter((node) => !apply.permitted.has(String(node.row.definition_key))).map((node) => String(node.row.definition_key)))];
  const nextNodes = allNext.filter((node) => apply.permitted.has(String(node.row.definition_key)));
  const nextById = new Map(nextNodes.map((node) => [rowId(node), node]));
  const captured = new Map((await apply.capture({ id: rowId(nextVariant), channel: variant.channel, locale: variant.locale })).map((block) => [block.id, block]));
  const seed = (templateBlockId: string): BlockContent => {
    const block = captured.get(templateBlockId);
    if (!block) throw new Error(`Template block ${templateBlockId} was not captured.`);
    return capturedContent(nextById.get(templateBlockId)!, block, apply);
  };
  const current = await listDocumentBlocks(trx, variant.id);
  // A seeded block holds resolved content, so it never equals what the template authored: the server's own
  // mark of a local change (`diverged`, set when a canonical write changes the block) is what says it was edited.
  const baseline = new Map([...previousNodes].map(([id, node]) => [id, contentKey(blockContent(node.row, columns))]));
  const plan = planFollow(
    current.map((row) => ({ id: row.id, origin: row.origin, templateBlockId: row.template_block_id, diverged: row.diverged, key: (row.template_block_id ? baseline.get(row.template_block_id) : undefined) ?? "" })),
    baseline,
    nextNodes.map((node) => ({ templateBlockId: rowId(node), key: contentKey(blockContent(node.row, columns)), locked: captured.get(rowId(node))?.locked === true && !captured.get(rowId(node))?.editableChildren })),
  );
  const unchanged = new Map(current.map((row) => [row.id, contentKey(blockContent(row, columns))]));
  const byId = new Map(current.map((row) => [row.id, row]));
  let changed = false;
  const stillLocal: string[] = [];
  const write = async (id: string, content: BlockContent) => {
    if (unchanged.get(id) === contentKey(content)) return;
    await replaceDocumentBlockContent(trx, id, content, columns);
    changed = true;
  };
  for (const entry of plan.reseed) {
    const followed = await followInclusion(apply, byId.get(entry.id)!, previousNodes.get(entry.templateBlockId), nextById.get(entry.templateBlockId)!, captured.get(entry.templateBlockId)!);
    await write(entry.id, followed?.content ?? seed(entry.templateBlockId));
    if (followed?.local) stillLocal.push(entry.id);
  }
  // A locally changed inclusion is not left behind: it is merged like any other, and stays marked as local.
  for (const id of plan.diverge) {
    const row = byId.get(id)!;
    const node = row.template_block_id ? nextById.get(row.template_block_id) : undefined;
    const block = row.template_block_id ? captured.get(row.template_block_id) : undefined;
    const followed = node && block ? await followInclusion(apply, row, previousNodes.get(row.template_block_id!), node, block) : undefined;
    if (!followed) continue;
    await write(id, followed.content);
    if (followed.local) stillLocal.push(id);
  }
  // An inclusion the new version no longer has cannot take content with it that its copy protects.
  for (const id of plan.remove) {
    const row = byId.get(id)!;
    const stored = (row[apply.carrier.valuesColumn] as Record<string, unknown> | null | undefined)?.content;
    const compositionOf = compositionFor(apply.carrier);
    if (compositionOf(String(row[apply.carrier.definitionColumn])) && isInclusionCopy(stored) && holdsProtectedContent(readInclusionCopy(stored), compositionOf))
      throw operationFailure({ code: "INVALID_STATE", message: "The new template no longer holds content that is protected here; the existing document has been kept.", retryable: false });
  }
  const newlyDiverged = [...new Set([...plan.diverge.filter((id) => !byId.get(id)?.diverged), ...stillLocal])];
  await markBlocksDiverged(trx, newlyDiverged);
  await deleteDocumentBlocks(trx, variant.id, plan.remove);
  const order: string[] = [];
  for (const [position, slot] of plan.order.entries()) {
    order.push(slot.kind === "existing" ? slot.id : await insertDocumentBlock(trx, {
      variantId: variant.id, position, templateBlockId: slot.templateBlockId, content: seed(slot.templateBlockId), columns,
    }));
  }
  const moved = current.some((row, index) => order[index] !== row.id);
  changed ||= plan.diverge.some((id) => !byId.get(id)?.diverged) || plan.remove.length > 0 || plan.insert.length > 0 || moved;
  await updateBlockPositions(trx, variant.id, order);
  if (changed) await rows(trx, `update erp.document_variants set ${TOUCH} where tenant_id = app.current_tenant() and id = $1::uuid`, [variant.id]);
  return { changed, problems: skipped.length ? [`Skipped template block definition(s) not allowed on a document: ${skipped.join(", ")}.`] : [] };
}

/**
 * Re-seeds one document from `next`: every template variant becomes or
 * updates a document variant of the same channel and locale; document
 * variants the template no longer has stay and are named in the problem.
 * The caller runs this under the `link` command. Returns the follow problem
 * to record, or null.
 */
export async function applyTemplateVersion(apply: ApplyContext, document: TrackedDocument, next: TemplateVersionRow): Promise<string | null> {
  const { trx } = apply;
  let previous: PublishedSnapshot | undefined;
  if (document.template_version_id) {
    if (!apply.tracked.has(document.template_version_id)) apply.tracked.set(document.template_version_id, await readTemplateVersion(trx, document.template_version_id));
    const tracked = apply.tracked.get(document.template_version_id);
    if (!tracked) return `Tracked template version ${document.template_version_id} is unavailable; the document was left as it is.`;
    previous = tracked.snapshot;
  }
  const previousVariants = previous ? templateVariants(previous) : [];
  const existing = new Map((await listDocumentVariants(trx, document.id)).map((variant) => [`${variant.channel}/${variant.locale}`, variant]));
  const problems: string[] = [];
  const covered = new Set<string>();
  // The pin always moves; the head is drafted only when a block actually
  // changed (the draft rule, docs/document-content.md).
  let changed = false;
  for (const { channel, locale, node } of templateVariants(next.snapshot)) {
    const key = `${channel}/${locale}`;
    covered.add(key);
    let variant = existing.get(key);
    if (!variant) { variant = await insertDocumentVariant(trx, document.id, channel, locale); changed = true; }
    const followed = await followVariant(apply, variant, previousVariants.find((entry) => entry.channel === channel && entry.locale === locale)?.node, node);
    problems.push(...followed.problems);
    changed ||= followed.changed;
  }
  const orphaned = [...existing.keys()].filter((key) => !covered.has(key) && previousVariants.some((entry) => `${entry.channel}/${entry.locale}` === key));
  if (orphaned.length) problems.push(`The template no longer has variant(s) ${orphaned.join(", ")}; they were left as they are.`);
  await rows(trx, `update erp.documents set template_version_id = $2::uuid, follow_error = $3::text,
      lifecycle_status = case when $4::boolean then 'draft' else lifecycle_status end, ${TOUCH}
    where tenant_id = app.current_tenant() and id = $1::uuid`, [document.id, next.id, problems.length ? problems.join(" ").slice(0, 2000) : null, changed]);
  return problems.length ? problems.join(" ") : null;
}
