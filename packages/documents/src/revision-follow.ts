// SPDX-License-Identifier: BUSL-1.1
/**
 * The follow-template rule (docs/document-revisions.md): when a Template is
 * republished, every draft revision tracking it is re-seeded. `planFollow` is
 * the pure decision; `followTemplatePublish` applies it inside the publish
 * transaction as a versioning publish follower. One draft that cannot be
 * followed records why on itself and never vetoes the template publication.
 */
import { operationErrorOf } from "@openshapeforge/operations";
import type { PublishFollower, PublishFollowerContext } from "@openshapeforge/versioning/followers";
import { parseSnapshot, rowId, type PublishedSnapshot, type SnapshotNode } from "@openshapeforge/versioning/snapshot";
import { rows } from "./commands.js";
import {
  appendRecordEvent, blockColumns, blockContent, contentKey, deleteRevisionBlocks, insertRevisionBlock, listRevisionBlocks, markBlocksDiverged,
  readTemplateVersion, replaceRevisionBlockContent, templateVariantBlocks, updateBlockPositions, withRevisionCommand, type BlockColumns, type TemplateVersionRow,
} from "./revision-blocks.js";

export type FollowBlock = Readonly<{ id: string; origin: string; templateBlockId: string | null; diverged: boolean; key: string }>;
export type FollowTemplateBlock = Readonly<{ templateBlockId: string; key: string }>;
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
 * `previous` maps template block id to the content key the revision was seeded
 * from; a block whose key still matches was not edited locally. Local blocks
 * and kept diverged blocks trail the template block that preceded them. A
 * second row claiming the same template block is treated as a local block.
 */
export function planFollow(current: readonly FollowBlock[], previous: ReadonlyMap<string, string>, next: readonly FollowTemplateBlock[]): FollowPlan {
  const nextIds = new Set(next.map((block) => block.templateBlockId));
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
    const edited = block.diverged || previous.get(templateBlockId) !== block.key;
    const present = nextIds.has(templateBlockId);
    if (present && !edited) { reseed.push({ id: block.id, templateBlockId }); slotFor.set(templateBlockId, block.id); anchor = templateBlockId; }
    else if (present) { diverge.push(block.id); slotFor.set(templateBlockId, block.id); anchor = templateBlockId; }
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

type DraftRevision = { id: string; template_version_id: string; channel: string; locale: string };
type Follow = PublishFollowerContext & { columns: BlockColumns; next: PublishedSnapshot; permitted: ReadonlySet<string>; tracked: Map<string, TemplateVersionRow | undefined> };

/** Content columns a snapshot row knows; a column added later never counts as a local edit. */
const snapshotColumns = (node: SnapshotNode) => Object.keys(node.row);

async function followDraft(follow: Follow, draft: DraftRevision): Promise<string | null> {
  const { transaction: trx, columns } = follow;
  if (!follow.tracked.has(draft.template_version_id)) follow.tracked.set(draft.template_version_id, await readTemplateVersion(trx, draft.template_version_id));
  const tracked = follow.tracked.get(draft.template_version_id);
  if (!tracked) return `Tracked template version ${draft.template_version_id} is unavailable; the draft was left as it is.`;
  const previousNodes = new Map((templateVariantBlocks(tracked.snapshot, draft.channel, draft.locale) ?? []).map((node) => [rowId(node), node]));
  const allNext = templateVariantBlocks(follow.next, draft.channel, draft.locale) ?? [];
  const skipped = [...new Set(allNext.filter((node) => !follow.permitted.has(String(node.row.definition_key))).map((node) => String(node.row.definition_key)))];
  const nextNodes = allNext.filter((node) => follow.permitted.has(String(node.row.definition_key)));
  const nextById = new Map(nextNodes.map((node) => [rowId(node), node]));
  const current = await listRevisionBlocks(trx, draft.id);
  const plan = planFollow(
    current.map((row) => {
      const previous = row.template_block_id ? previousNodes.get(row.template_block_id) : undefined;
      return { id: row.id, origin: row.origin, templateBlockId: row.template_block_id, diverged: row.diverged, key: contentKey(blockContent(row, columns, previous ? snapshotColumns(previous) : undefined)) };
    }),
    new Map([...previousNodes].map(([id, node]) => [id, contentKey(blockContent(node.row, columns))])),
    nextNodes.map((node) => ({ templateBlockId: rowId(node), key: contentKey(blockContent(node.row, columns)) })),
  );
  const unchanged = new Map(current.map((row) => [row.id, contentKey(blockContent(row, columns))]));
  for (const entry of plan.reseed) {
    const content = blockContent(nextById.get(entry.templateBlockId)!.row, columns);
    if (unchanged.get(entry.id) !== contentKey(content)) await replaceRevisionBlockContent(trx, entry.id, content, columns);
  }
  await markBlocksDiverged(trx, plan.diverge);
  await deleteRevisionBlocks(trx, draft.id, plan.remove);
  const order: string[] = [];
  for (const [position, slot] of plan.order.entries()) {
    order.push(slot.kind === "existing" ? slot.id : await insertRevisionBlock(trx, {
      revisionId: draft.id, position, origin: "template", templateBlockId: slot.templateBlockId, content: blockContent(nextById.get(slot.templateBlockId)!.row, columns), columns,
    }));
  }
  await updateBlockPositions(trx, draft.id, order);
  await rows(trx, "update erp.document_revisions set template_version_id = $2::uuid, follow_error = null, updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond') where tenant_id = app.current_tenant() and id = $1::uuid", [draft.id, follow.version.id]);
  return skipped.length ? `Skipped template block definition(s) not allowed on a revision: ${skipped.join(", ")}.` : null;
}

function describe(platform: PublishFollowerContext["platform"], error: unknown): string {
  const known = operationErrorOf(error) ?? platform.errors.classifyDatabase(error);
  return known ? `${known.code}: ${known.message}` : "The draft could not follow the new template version.";
}

export const followTemplatePublish: PublishFollower = async (context) => {
  const { transaction: trx, session, platform, sourceId, version } = context;
  const drafts = await rows<DraftRevision>(trx, `select r.id, r.template_version_id, r.channel, r.locale
      from erp.document_revisions r
      join erp.template_versions v on v.tenant_id = r.tenant_id and v.id = r.template_version_id
      where r.tenant_id = app.current_tenant() and v.template_id = $1::uuid and r.status = 'draft' and v.id <> $2::uuid
      order by r.id for update of r`, [sourceId, version.id]);
  if (!drafts.length) return;
  const follow: Follow = {
    ...context, columns: await blockColumns(trx), next: parseSnapshot(version.snapshot), tracked: new Map(),
    permitted: new Set(platform.schemas.entityValues?.collection("DocumentRevision", "blocks")?.allowedDefinitions ?? []),
  };
  await withRevisionCommand(trx, "follow", async () => {
    for (const draft of drafts) {
      // A savepoint keeps one failing draft from poisoning the publish transaction.
      await rows(trx, "savepoint follow_draft", []);
      let problem: string | null;
      try {
        problem = await followDraft(follow, draft);
        await rows(trx, "release savepoint follow_draft", []);
      } catch (error) {
        await rows(trx, "rollback to savepoint follow_draft", []);
        problem = describe(platform, error);
      }
      if (problem) await rows(trx, "update erp.document_revisions set follow_error = $2::text, updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond') where tenant_id = app.current_tenant() and id = $1::uuid", [draft.id, problem.slice(0, 2000)]);
      await appendRecordEvent(platform, session, { aggregateType: "documentRevision", table: "document_revisions", id: draft.id, operation: "updated" });
    }
  });
};
