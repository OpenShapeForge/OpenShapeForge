// SPDX-License-Identifier: BUSL-1.1
/**
 * The host-owned copy an inclusion stores in its `content` value.
 *
 * `blocks` is the complete content of the inclusion, as the host shows, edits
 * and prints it. `source` is the server's record of what was captured: one
 * entry per captured block, in source order, with the hash of the block as it
 * was resolved and the source's lock. `page` is the source variant's page
 * settings. Nothing here reads a template: a copy is read, protected and
 * merged from what it stores.
 *
 * `source` and `page` are written by the server only. A caller may send them
 * back as it read them; anything else is refused, never adopted.
 */
import { contentError } from "./errors.js";
import { canonicalJson, CONTENT_LIMITS, hashCanonicalJson, type JsonObject, type JsonValue } from "./json.js";
import type { ContentBlock } from "./types.js";

export type CopySourceEntry = {
  readonly id: string;
  /** Hash of the block as captured (`blockHash`); a block that still hashes to it has no local change. */
  readonly hash: string;
  /** The source protects this block: it cannot be changed, removed or reordered against other locked blocks. */
  readonly locked?: true;
  /** The block still names variables of the host, so the host binds it when it is read. Every other captured block is literal. */
  readonly deferred?: true;
};

export type InclusionCopy = {
  readonly page?: JsonObject;
  readonly source: readonly CopySourceEntry[];
  readonly blocks: readonly ContentBlock[];
};

/** Which fields of a block definition make it an inclusion; undefined for every other definition. */
export type CompositionOf = (definitionKey: string) => { readonly templateVersionField: string; readonly parametersField?: string } | undefined;

export const OBSOLETE_INCLUSION = "This inclusion is stored in the earlier reference-only form, which is no longer read. Insert the template again, or republish the template that contains it, so a complete copy is captured.";

const BLOCK_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const LAYOUT_KEY = /^[a-z][A-Za-z0-9-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const BLOCK_KEYS = ["id", "definitionKey", "schemaVersion", "values", "references", "region", "layoutKey", "locked"];
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** The existing typed argument contract identifies a template inclusion without another block type system. */
export function templateComposition(fields: readonly Readonly<Record<string, unknown>>[]): { templateVersionField: string; parametersField: string } | undefined {
  for (const field of fields) {
    const binding = field.valueFieldsFrom as Record<string, unknown> | undefined;
    if (binding?.headEntity === "Template" && typeof binding.reference === "string" && typeof field.key === "string") return { templateVersionField: binding.reference, parametersField: field.key };
  }
  return undefined;
}

/** Whether a stored `content` value is a complete copy; the reference-only form before it carried no `source`. */
export function isInclusionCopy(content: unknown): boolean {
  return object(content) && Array.isArray(content.source) && Array.isArray(content.blocks);
}

function parseBlock(entry: unknown, locked: boolean | undefined): ContentBlock {
  if (!object(entry) || typeof entry.id !== "string" || !BLOCK_ID.test(entry.id)) contentError("INVALID_VALUE", "An included block requires a valid identity.");
  if (Object.keys(entry).some((key) => !BLOCK_KEYS.includes(key))) contentError("INVALID_VALUE", "Included content carries unsupported block properties.");
  if (typeof entry.definitionKey !== "string" || !entry.definitionKey) contentError("BLOCK_UNKNOWN", "An included block requires its block definition.");
  if (!Number.isSafeInteger(entry.schemaVersion) || (entry.schemaVersion as number) < 1) contentError("INVALID_VALUE", "An included block requires its definition version.");
  const references = entry.references ?? {};
  if (!object(entry.values) || !object(references)) contentError("INVALID_VALUE", "Included block values and references must be objects.");
  const region = entry.region ?? "body";
  if (region !== "body" && region !== "header" && region !== "footer") contentError("INVALID_VALUE", "An included block requires a valid page region.");
  const layoutKey = region === "body" ? undefined : entry.layoutKey ?? undefined;
  if (region === "body" && entry.layoutKey != null) contentError("INVALID_VALUE", "Only a header or footer block names a page layout.");
  if (layoutKey !== undefined && (typeof layoutKey !== "string" || !LAYOUT_KEY.test(layoutKey))) contentError("INVALID_VALUE", "An included block requires a valid page layout.");
  if (entry.locked !== undefined && typeof entry.locked !== "boolean") contentError("INVALID_VALUE", "A source lock is true or false.");
  return {
    id: entry.id as string, ...((locked ?? entry.locked === true) ? { locked: true as const } : {}),
    definitionKey: entry.definitionKey as string, schemaVersion: entry.schemaVersion as number,
    values: entry.values as JsonObject, references: references as ContentBlock["references"],
    ...(region !== "body" ? { region } : {}), ...(layoutKey ? { layoutKey: layoutKey as string } : {}),
  };
}

function uniqueIds(ids: readonly string[], what: string) {
  if (new Set(ids).size !== ids.length) contentError("DUPLICATE", `${what} identities must be unique.`);
}

/** A stored copy, structurally checked. The earlier reference-only form is refused by name, never expanded. */
export function readInclusionCopy(content: unknown): InclusionCopy {
  if (!isInclusionCopy(content)) contentError("DEPENDENCY_INVALID", OBSOLETE_INCLUSION);
  const stored = content as Record<string, unknown>;
  if (Object.keys(stored).some((key) => !["page", "source", "blocks"].includes(key))) contentError("INVALID_VALUE", "Included content carries unsupported properties.");
  if (stored.page !== undefined && !object(stored.page)) contentError("INVALID_VALUE", "Included page settings must be an object.");
  const entries = stored.source as unknown[], rows = stored.blocks as unknown[];
  if (entries.length > CONTENT_LIMITS.blocks || rows.length > CONTENT_LIMITS.blocks) contentError("CONTENT_LIMIT_EXCEEDED", "Included content contains too many blocks.");
  const source = entries.map((entry): CopySourceEntry => {
    if (!object(entry) || typeof entry.id !== "string" || !BLOCK_ID.test(entry.id) || typeof entry.hash !== "string" || !HASH.test(entry.hash)
      || Object.keys(entry).some((key) => !["id", "hash", "locked", "deferred"].includes(key))
      || (entry.locked !== undefined && typeof entry.locked !== "boolean") || (entry.deferred !== undefined && typeof entry.deferred !== "boolean"))
      contentError("INVALID_VALUE", "Included content carries an invalid source record.");
    return { id: entry.id as string, hash: entry.hash as string, ...(entry.locked === true ? { locked: true as const } : {}), ...(entry.deferred === true ? { deferred: true as const } : {}) };
  });
  uniqueIds(source.map((entry) => entry.id), "Source record");
  const locked = new Set(source.filter((entry) => entry.locked).map((entry) => entry.id));
  const blocks = rows.map((entry) => parseBlock(entry, object(entry) && typeof entry.id === "string" ? locked.has(entry.id) : false));
  uniqueIds(blocks.map((block) => block.id), "Included block");
  return { ...(stored.page ? { page: stored.page as JsonObject } : {}), source, blocks };
}

/** The stored form of a copy: every block states the lock its source record carries. */
export function inclusionCopyContent(copy: InclusionCopy): JsonObject {
  const locked = new Set(copy.source.filter((entry) => entry.locked).map((entry) => entry.id));
  return {
    ...(copy.page ? { page: copy.page } : {}),
    source: copy.source.map((entry) => ({ id: entry.id, hash: entry.hash, ...(entry.locked ? { locked: true } : {}), ...(entry.deferred ? { deferred: true } : {}) })),
    blocks: copy.blocks.map(({ locked: _locked, ...block }) => ({ ...block, ...(locked.has(block.id) ? { locked: true } : {}) })) as unknown as JsonValue,
  };
}

/**
 * What a block is, apart from who protects it: its lock and, for a nested
 * inclusion, the source record of that inclusion are left out, so a baseline
 * stays linear in the content and is never hashed into itself.
 */
function comparable(block: ContentBlock): unknown {
  const content = block.values.content;
  const values = object(content) && Array.isArray(content.blocks)
    ? { ...block.values, content: { ...(content.page ? { page: content.page } : {}), blocks: (content.blocks as unknown[]).map((entry) => object(entry) && object(entry.values) ? comparable(entry as unknown as ContentBlock) : entry) } }
    : block.values;
  return { id: block.id, definitionKey: block.definitionKey, schemaVersion: block.schemaVersion, values, references: block.references ?? {}, ...(block.region ? { region: block.region } : {}), ...(block.layoutKey ? { layoutKey: block.layoutKey } : {}) };
}
const sameAuthored = (left: ContentBlock, right: ContentBlock) => canonicalJson(comparable(left)) === canonicalJson(comparable(right));

export function blockHash(block: ContentBlock): Promise<string> {
  return hashCanonicalJson(comparable(block), "osf-inclusion-block-v1");
}

/** The source record of freshly captured blocks, in their order. */
export async function sourceRecord(blocks: readonly ContentBlock[], deferred: ReadonlySet<string> = new Set()): Promise<CopySourceEntry[]> {
  const entries: CopySourceEntry[] = [];
  for (const block of blocks) entries.push({ id: block.id, hash: await blockHash(block), ...(block.locked ? { locked: true as const } : {}), ...(deferred.has(block.id) ? { deferred: true as const } : {}) });
  return entries;
}

/** The copy a nested inclusion block stores, or undefined when the block is no inclusion or holds no complete copy. */
export function nestedCopy(block: ContentBlock | undefined, compositionOf: CompositionOf): InclusionCopy | undefined {
  return block && compositionOf(block.definitionKey) && isInclusionCopy(block.values.content) ? readInclusionCopy(block.values.content) : undefined;
}

/** Whether a copy, or any inclusion nested in it, holds content its source protects. */
export function holdsProtectedContent(copy: InclusionCopy, compositionOf: CompositionOf, depth = 0): boolean {
  if (depth >= CONTENT_LIMITS.templateDepth) contentError("CONTENT_LIMIT_EXCEEDED", "Included content exceeds the maximum depth.");
  if (copy.source.some((entry) => entry.locked)) return true;
  return copy.blocks.some((block) => { const nested = nestedCopy(block, compositionOf); return nested ? holdsProtectedContent(nested, compositionOf, depth + 1) : false; });
}

export type LocalDraftOptions = {
  readonly compositionOf: CompositionOf;
  /**
   * Settles one nested inclusion of the draft against the stored one (absent
   * for a new inclusion): the caller captures, validates or merges it and
   * returns the block to store. Without it a nested inclusion must be stored
   * unchanged.
   */
  readonly settleNested?: (input: { readonly stored: ContentBlock | undefined; readonly draft: ContentBlock }) => Promise<ContentBlock>;
  /**
   * The baseline was captured in this same write, so the draft never saw it:
   * its own `source` and `page` are ignored and a protected block is taken
   * from the baseline instead of compared.
   */
  readonly freshBaseline?: boolean;
};

/**
 * The blocks of a caller's draft, checked against the stored baseline. The
 * source record and page settings stay the server's; a locked block must be
 * present, unchanged and in its source order; an enclosing block cannot be
 * removed or replaced while content nested in it is protected.
 */
export async function normalizeLocalDraft(stored: InclusionCopy, draft: unknown, options: LocalDraftOptions): Promise<readonly ContentBlock[]> {
  if (!object(draft) || Object.keys(draft).some((key) => !["page", "source", "blocks"].includes(key)) || !Array.isArray(draft.blocks) || draft.blocks.length > CONTENT_LIMITS.blocks)
    contentError("INVALID_VALUE", "Included content must contain an ordered block collection.");
  if (!options.freshBaseline) {
    if (draft.source !== undefined && canonicalJson(draft.source) !== canonicalJson(inclusionCopyContent(stored).source))
      contentError("INVALID_VALUE", "The source record of an inclusion is kept by the server and cannot be changed.");
    if (draft.page !== undefined && canonicalJson(draft.page) !== canonicalJson(stored.page ?? null))
      contentError("INVALID_VALUE", "The page settings of an inclusion come from its source and cannot be changed.");
  }
  const entries = new Map(stored.source.map((entry) => [entry.id, entry]));
  const storedBlocks = new Map(stored.blocks.map((block) => [block.id, block]));
  const blocks: ContentBlock[] = [];
  for (const raw of draft.blocks as unknown[]) {
    const entry = object(raw) && typeof raw.id === "string" ? entries.get(raw.id) : undefined;
    if (!options.freshBaseline && object(raw) && raw.locked !== undefined && raw.locked !== Boolean(entry?.locked))
      contentError("INVALID_VALUE", "A source lock is kept by the server and cannot be changed.");
    let block = parseBlock(raw, Boolean(entry?.locked));
    const previous = storedBlocks.get(block.id);
    if (options.compositionOf(block.definitionKey)) {
      if (options.settleNested) block = { ...await options.settleNested({ stored: previous && options.compositionOf(previous.definitionKey) ? previous : undefined, draft: block }), ...(entry?.locked ? { locked: true as const } : {}) };
      else if (!previous || !sameAuthored(previous, block)) contentError("INVALID_VALUE", "A nested inclusion can only be changed where its source can be captured.");
      else block = previous;
    }
    if (entry?.locked && await blockHash(block) !== entry.hash) {
      if (!options.freshBaseline || !previous) contentError("INVALID_VALUE", "A locked source block cannot be changed.");
      block = previous;
    }
    blocks.push(block);
  }
  uniqueIds(blocks.map((block) => block.id), "Included block");
  const present = new Set(blocks.map((block) => block.id));
  const locked = stored.source.filter((entry) => entry.locked).map((entry) => entry.id);
  if (locked.some((id) => !present.has(id))) contentError("INVALID_VALUE", "A locked source block cannot be removed.");
  if (blocks.filter((block) => block.locked).some((block, index) => block.id !== locked[index])) contentError("INVALID_VALUE", "Locked source blocks must retain their order.");
  for (const block of stored.blocks) {
    if (present.has(block.id)) continue;
    const nested = nestedCopy(block, options.compositionOf);
    if (nested && holdsProtectedContent(nested, options.compositionOf)) contentError("INVALID_VALUE", "Protected template content cannot be removed or replaced through an enclosing block.");
  }
  return blocks;
}

export type InclusionMerge = {
  /** The stored source record: what the current blocks were captured as. */
  readonly baseline: readonly CopySourceEntry[];
  /** The current local blocks, already checked against that baseline. */
  readonly current: readonly ContentBlock[];
  /** The source's own blocks as authored when the baseline was captured; absent when that source can no longer be read. */
  readonly authoredOld?: readonly ContentBlock[];
  /** The new source's own blocks as authored. */
  readonly authoredNew: readonly ContentBlock[];
  /** The new source, captured with the inclusion's inputs. */
  readonly captured: InclusionCopy;
  readonly compositionOf: CompositionOf;
};

function conflict(message: string): never {
  return contentError("INVALID_VALUE", `${message} The existing inclusion has been kept.`);
}

/**
 * Three-way update of a copy to a newly captured source.
 *
 * A block without a local change adopts the new capture, record values
 * included. A locally changed block keeps its local content when the source
 * did not change what it authored there — a refreshed record value never
 * overwrites a local edit. Local additions and removals are kept. A block both
 * sides changed, a new lock on locally changed or removed content, and a new
 * block that collides with a local one are conflicts: the update is refused
 * as a whole and nothing is written. A nested inclusion both sides changed is
 * merged by the same rule from its own source record.
 *
 * When the earlier source can no longer be read there is no authored
 * comparison, and a local change is kept rather than weighed against it.
 */
export async function mergeInclusionCopy(input: InclusionMerge, depth = 0): Promise<InclusionCopy> {
  if (depth >= CONTENT_LIMITS.templateDepth) contentError("CONTENT_LIMIT_EXCEEDED", "Included content exceeds the maximum depth.");
  const { compositionOf, captured } = input;
  const baseline = new Map(input.baseline.map((entry) => [entry.id, entry]));
  const current = new Map(input.current.map((block) => [block.id, block]));
  const next = new Map(captured.blocks.map((block) => [block.id, block]));
  const nextEntries = new Map(captured.source.map((entry) => [entry.id, entry]));
  const old = input.authoredOld ? new Map(input.authoredOld.map((block) => [block.id, block])) : undefined;
  const authored = new Map(input.authoredNew.map((block) => [block.id, block]));
  const chosen = new Map<string, ContentBlock>();
  const trailers = new Map<string | null, ContentBlock[]>();
  const trail = (anchor: string | null, block: ContentBlock) => { const { locked: _locked, ...local } = block; trailers.set(anchor, [...(trailers.get(anchor) ?? []), local]); };
  let anchor: string | null = null;
  for (const block of input.current) {
    const entry = baseline.get(block.id), replacement = next.get(block.id);
    if (!entry) {
      if (replacement) conflict("A new template block has the identity of a block added here.");
      trail(anchor, block);
      continue;
    }
    const hash = await blockHash(block);
    const edited = hash !== entry.hash;
    if (!replacement) {
      // Gone from the new source. Local content stays: a block changed here, or one that reached this copy through an enclosing template and never was this source's.
      if (edited || (old && !old.has(block.id))) trail(anchor, block);
      continue;
    }
    anchor = block.id;
    const upcoming = nextEntries.get(block.id)!;
    if (!edited || hash === upcoming.hash) { chosen.set(block.id, replacement); continue; }
    const { locked: _locked, ...local } = block;
    const before = old?.get(block.id), after = authored.get(block.id);
    const sourceChanged = Boolean(old) && (!before || !after || !sameAuthored(before, after));
    const mine = nestedCopy(block, compositionOf), theirs = nestedCopy(replacement, compositionOf);
    if (upcoming.locked) conflict("The new template locks a block that was changed here.");
    else if (!sourceChanged) chosen.set(block.id, local);
    else if (mine && theirs) {
      const merged = await mergeInclusionCopy({
        baseline: mine.source, current: mine.blocks, captured: theirs, compositionOf,
        ...(nestedCopy(before, compositionOf) ? { authoredOld: nestedCopy(before, compositionOf)!.blocks } : {}),
        authoredNew: nestedCopy(after, compositionOf)?.blocks ?? [],
      }, depth + 1);
      chosen.set(block.id, { ...replacement, values: { ...replacement.values, content: inclusionCopyContent(merged) } });
    } else conflict("The template changed a block that was also changed here.");
  }
  for (const entry of input.baseline) {
    if (!current.has(entry.id) && nextEntries.get(entry.id)?.locked) conflict("The new template protects a block that was removed here.");
  }
  const blocks: ContentBlock[] = [...(trailers.get(null) ?? [])];
  for (const block of captured.blocks) {
    // Removed here and still offered by the source: the removal is kept.
    if (!(baseline.has(block.id) && !current.has(block.id))) blocks.push(chosen.get(block.id) ?? block);
    blocks.push(...(trailers.get(block.id) ?? []));
  }
  if (blocks.length > CONTENT_LIMITS.blocks) contentError("CONTENT_LIMIT_EXCEEDED", "Included content contains too many blocks.");
  return { ...(captured.page ? { page: captured.page } : {}), source: captured.source, blocks };
}
