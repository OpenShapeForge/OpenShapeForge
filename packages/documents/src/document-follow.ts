// SPDX-License-Identifier: BUSL-1.1
/**
 * The follow-template rule (docs/document-content.md): when a Template is
 * republished, every document tracking it is re-seeded, variant by variant.
 * `planFollow` is the pure decision per variant; `applyTemplateVersion`
 * applies it to one document inside the caller's transaction and is shared
 * with Document.linkTemplate; `followTemplatePublish` runs it for every
 * tracking document as a versioning publish follower. One document that
 * cannot be followed records why on itself and never vetoes the publication.
 */
import { operationErrorOf } from "@openshapeforge/operations";
import type { PublishFollower, PublishFollowerContext } from "@openshapeforge/versioning/followers";
import { orderedChildren, parseSnapshot, rowId, type PublishedSnapshot, type SnapshotNode } from "@openshapeforge/versioning/snapshot";
import { rows } from "./commands.js";
import {
  appendRecordEvent, blockColumns, blockContent, contentKey, deleteDocumentBlocks, insertDocumentBlock, insertDocumentVariant, listDocumentBlocks, listDocumentVariants,
  markBlocksDiverged, readTemplateVersion, replaceDocumentBlockContent, templateVariants, updateBlockPositions, withDocumentCommand,
  type BlockColumns, type DocumentVariantRow, type TemplateVersionRow,
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
 * from; a block whose key still matches was not edited locally. A block the
 * new snapshot marks locked is re-seeded whatever happened to it locally.
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
    const edited = !upcoming?.locked && (block.diverged || previous.get(templateBlockId) !== block.key);
    if (upcoming && !edited) { reseed.push({ id: block.id, templateBlockId }); slotFor.set(templateBlockId, block.id); anchor = templateBlockId; }
    else if (upcoming) { diverge.push(block.id); slotFor.set(templateBlockId, block.id); anchor = templateBlockId; }
    else if (!edited) remove.push(block.id);
    else { diverge.push(block.id); trail(anchor, block.id); }
  }
  const insert: string[] = [];
  const order: FollowSlot[] = (trailers.get(null) ?? []).map((id) => ({ kind: "existing", id }));
  for (const block of next) {
    const existing = slotFor.get(block.templateBlockId);
    if (existing) order.push({ kind: "existing", id: existing });
    else { insert.push(block.templateBlockId); order.push({ kind: "insert", templateBlockId: block.templateBlockId }); }
    for (const id of trailers.get(block.templateBlockId) ?? []) order.push({ kind: "existing", id });
  }
  return { order, reseed, diverge, remove, insert };
}

export type TrackedDocument = Readonly<{ id: string; template_version_id: string | null }>;
export type ApplyContext = Readonly<{ trx: unknown; columns: BlockColumns; permitted: ReadonlySet<string>; tracked: Map<string, TemplateVersionRow | undefined> }>;

/** Content columns a snapshot row knows; a column added later never counts as a local edit. */
const snapshotColumns = (node: SnapshotNode) => Object.keys(node.row);
const variantBlocks = (node: SnapshotNode) => orderedChildren(node, "blocks", "variant_id_position");
const TOUCH = "updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')";

type VariantFollow = Readonly<{ problems: readonly string[]; changed: boolean }>;

/** Re-seeds one variant; `changed` says whether any block row was written, which is what drafts the document. */
async function followVariant(apply: ApplyContext, variant: DocumentVariantRow, previousVariant: SnapshotNode | undefined, nextVariant: SnapshotNode): Promise<VariantFollow> {
  const { trx, columns } = apply;
  const previousNodes = new Map((previousVariant ? variantBlocks(previousVariant) : []).map((node) => [rowId(node), node]));
  const allNext = variantBlocks(nextVariant);
  const skipped = [...new Set(allNext.filter((node) => !apply.permitted.has(String(node.row.definition_key))).map((node) => String(node.row.definition_key)))];
  const nextNodes = allNext.filter((node) => apply.permitted.has(String(node.row.definition_key)));
  const nextById = new Map(nextNodes.map((node) => [rowId(node), node]));
  const current = await listDocumentBlocks(trx, variant.id);
  const plan = planFollow(
    current.map((row) => {
      const previous = row.template_block_id ? previousNodes.get(row.template_block_id) : undefined;
      return { id: row.id, origin: row.origin, templateBlockId: row.template_block_id, diverged: row.diverged, key: contentKey(blockContent(row, columns, previous ? snapshotColumns(previous) : undefined)) };
    }),
    new Map([...previousNodes].map(([id, node]) => [id, contentKey(blockContent(node.row, columns))])),
    nextNodes.map((node) => ({ templateBlockId: rowId(node), key: contentKey(blockContent(node.row, columns)), locked: node.row.locked === true })),
  );
  const unchanged = new Map(current.map((row) => [row.id, contentKey(blockContent(row, columns))]));
  let changed = false;
  for (const entry of plan.reseed) {
    const content = blockContent(nextById.get(entry.templateBlockId)!.row, columns);
    if (unchanged.get(entry.id) === contentKey(content)) continue;
    await replaceDocumentBlockContent(trx, entry.id, content, columns);
    changed = true;
  }
  const newlyDiverged = plan.diverge.filter((id) => !current.find((row) => row.id === id)?.diverged);
  await markBlocksDiverged(trx, newlyDiverged);
  await deleteDocumentBlocks(trx, variant.id, plan.remove);
  const order: string[] = [];
  for (const [position, slot] of plan.order.entries()) {
    order.push(slot.kind === "existing" ? slot.id : await insertDocumentBlock(trx, {
      variantId: variant.id, position, templateBlockId: slot.templateBlockId, content: blockContent(nextById.get(slot.templateBlockId)!.row, columns), columns,
    }));
  }
  const moved = current.some((row, index) => order[index] !== row.id);
  changed ||= newlyDiverged.length > 0 || plan.remove.length > 0 || plan.insert.length > 0 || moved;
  await updateBlockPositions(trx, variant.id, order);
  if (changed) await rows(trx, `update erp.document_variants set ${TOUCH} where tenant_id = app.current_tenant() and id = $1::uuid`, [variant.id]);
  return { changed, problems: skipped.length ? [`Skipped template block definition(s) not allowed on a document: ${skipped.join(", ")}.`] : [] };
}

/**
 * Re-seeds one document from `next`: every template variant becomes or
 * updates a document variant of the same channel and locale; document
 * variants the template no longer has stay and are named in the problem.
 * The caller runs this under the `link` or `follow` command. Returns the
 * follow problem to record, or null.
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

function describe(platform: PublishFollowerContext["platform"], error: unknown): string {
  const known = operationErrorOf(error) ?? platform.errors.classifyDatabase(error);
  return known ? `${known.code}: ${known.message}` : "The document could not follow the new template version.";
}

export const followTemplatePublish: PublishFollower = async (context) => {
  const { transaction: trx, session, platform, sourceId, version } = context;
  const documents = await rows<TrackedDocument>(trx, `select d.id, d.template_version_id
      from erp.documents d
      join erp.template_versions v on v.tenant_id = d.tenant_id and v.id = d.template_version_id
      where d.tenant_id = app.current_tenant() and v.template_id = $1::uuid and v.id <> $2::uuid
      order by d.id for update of d`, [sourceId, version.id]);
  if (!documents.length) return;
  const next: TemplateVersionRow = { id: version.id, template_id: sourceId, version_number: Number(version.version_number), status: String(version.status), snapshot: parseSnapshot(version.snapshot) };
  const carrier = platform.schemas.entityValues?.get("Block", "values");
  if (!carrier) throw new Error("Compiled block definitions are unavailable.");
  const apply: ApplyContext = {
    trx, columns: await blockColumns(trx, carrier), tracked: new Map(),
    permitted: new Set(platform.schemas.entityValues?.collection("DocumentVariant", "blocks")?.allowedDefinitions ?? []),
  };
  await withDocumentCommand(trx, "follow", async () => {
    for (const document of documents) {
      // A savepoint keeps one failing document from poisoning the publish transaction.
      await rows(trx, "savepoint follow_document", []);
      try {
        await applyTemplateVersion(apply, document, next);
        await rows(trx, "release savepoint follow_document", []);
      } catch (error) {
        await rows(trx, "rollback to savepoint follow_document", []);
        await rows(trx, `update erp.documents set follow_error = $2::text, ${TOUCH} where tenant_id = app.current_tenant() and id = $1::uuid`, [document.id, describe(platform, error).slice(0, 2000)]);
      }
      await appendRecordEvent(platform, session, { aggregateType: "document", table: "documents", id: document.id, operation: "updated" });
    }
  });
};
