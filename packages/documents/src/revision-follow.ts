// SPDX-License-Identifier: BUSL-1.1
/**
 * The follow-template rule (docs/document-revisions.md): when a Template is
 * republished, every draft revision tracking it is re-seeded. `planFollow` is
 * the pure decision; `followTemplatePublish` applies it inside the publish
 * transaction as a versioning publish follower.
 */
import type { PublishFollower } from "@openshapeforge/versioning/followers";
import { parseSnapshot, rowId, type SnapshotNode } from "@openshapeforge/versioning/snapshot";
import { rows } from "./commands.js";
import {
  blockColumns, blockContent, contentKey, insertRevisionBlock, listRevisionBlocks, readTemplateVersion, replaceRevisionBlockContent,
  templateVariantBlocks,
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
 * and kept diverged blocks trail the template block that preceded them.
 */
export function planFollow(current: readonly FollowBlock[], previous: ReadonlyMap<string, string>, next: readonly FollowTemplateBlock[]): FollowPlan {
  const nextIds = new Set(next.map((block) => block.templateBlockId));
  const trailers = new Map<string | null, string[]>();
  const slotFor = new Map<string, string>();
  const reseed: { id: string; templateBlockId: string }[] = [];
  const diverge: string[] = [];
  const remove: string[] = [];
  const trail = (anchor: string | null, id: string) => trailers.set(anchor, [...(trailers.get(anchor) ?? []), id]);
  let anchor: string | null = null;
  for (const block of current) {
    const templateBlockId = block.origin === "template" ? block.templateBlockId : null;
    if (!templateBlockId) { trail(anchor, block.id); continue; }
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

function keyed(nodes: readonly SnapshotNode[]): Map<string, SnapshotNode> {
  return new Map(nodes.map((node) => [rowId(node), node]));
}

type DraftRevision = { id: string; template_version_id: string; channel: string; locale: string };

export const followTemplatePublish: PublishFollower = async ({ transaction, session, platform, sourceId, version, previousVersionId }) => {
  const drafts = await rows<DraftRevision>(transaction, `select r.id, r.template_version_id, r.channel, r.locale
      from erp.document_revisions r
      join erp.template_versions v on v.tenant_id = r.tenant_id and v.id = r.template_version_id
      where r.tenant_id = app.current_tenant() and v.template_id = $1::uuid and r.status = 'draft' and v.id <> $2::uuid
      order by r.id for update of r`, [sourceId, version.id]);
  if (!drafts.length) return;
  const columns = await blockColumns(transaction);
  const nextSnapshot = parseSnapshot(version.snapshot);
  for (const draft of drafts) {
    const tracked = await readTemplateVersion(transaction, draft.template_version_id);
    const previousNodes = tracked ? templateVariantBlocks(tracked.snapshot, draft.channel, draft.locale) ?? [] : [];
    const nextNodes = templateVariantBlocks(nextSnapshot, draft.channel, draft.locale) ?? [];
    const nextById = keyed(nextNodes);
    const current = await listRevisionBlocks(transaction, draft.id);
    const plan = planFollow(
      current.map((row) => ({ id: row.id, origin: row.origin, templateBlockId: row.template_block_id, diverged: row.diverged, key: contentKey(blockContent(row, columns)) })),
      new Map(previousNodes.map((node) => [rowId(node), contentKey(blockContent(node.row, columns))])),
      nextNodes.map((node) => ({ templateBlockId: rowId(node), key: contentKey(blockContent(node.row, columns)) })),
    );
    for (const entry of plan.reseed) await replaceRevisionBlockContent(transaction, entry.id, blockContent(nextById.get(entry.templateBlockId)!.row, columns), columns);
    // Ids travel as one text parameter; not every driver maps a JS array to a Postgres array.
    if (plan.diverge.length) await rows(transaction, "update erp.blocks set diverged = true, updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond') where tenant_id = app.current_tenant() and id = any(string_to_array($1::text, ',')::uuid[])", [plan.diverge.join(",")]);
    if (plan.remove.length) await rows(transaction, "delete from erp.blocks where tenant_id = app.current_tenant() and revision_id = $1::uuid and id = any(string_to_array($2::text, ',')::uuid[])", [draft.id, plan.remove.join(",")]);
    for (const [position, slot] of plan.order.entries()) {
      const id = slot.kind === "existing" ? slot.id : await insertRevisionBlock(transaction, {
        revisionId: draft.id, position, origin: "template", templateBlockId: slot.templateBlockId, content: blockContent(nextById.get(slot.templateBlockId)!.row, columns), columns,
      });
      await rows(transaction, "update erp.blocks set revision_id_position = $2::integer where tenant_id = app.current_tenant() and id = $1::uuid and revision_id_position <> $2::integer", [id, position]);
    }
    await rows(transaction, "update erp.document_revisions set template_version_id = $2::uuid, updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond') where tenant_id = app.current_tenant() and id = $1::uuid", [draft.id, version.id]);
    await platform.events.append(session, {
      aggregateType: "DocumentRevision", aggregateId: draft.id, eventType: "template-followed",
      payload: { templateVersionId: version.id, previousTemplateVersionId: draft.template_version_id, publishedBefore: previousVersionId,
        reseeded: plan.reseed.length, diverged: plan.diverge.length, removed: plan.remove.length, inserted: plan.insert.length },
    });
  }
};
