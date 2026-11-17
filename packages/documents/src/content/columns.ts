// SPDX-License-Identifier: BUSL-1.1
/** Column cells contain the same canonical blocks as a document, never editor nodes. */
import { contentError } from './errors.js';
import { CONTENT_LIMITS, type JsonObject, type JsonValue } from './json.js';
import type { ContentBlock } from './types.js';
import { parseContentBlock, isInclusionCopy, readInclusionCopy } from './inclusion-copy.js';
export const COLUMN_SLOTS = ['left', 'center', 'right'] as const;
export type ColumnSlot = typeof COLUMN_SLOTS[number];
export const isColumns = (key: string) => key === 'TextColumns';
export function columnBlocks(value: unknown, depth = 0): ContentBlock[] {
  if (depth >= CONTENT_LIMITS.templateDepth) contentError("CONTENT_LIMIT_EXCEEDED", "Column content exceeds the maximum depth.");
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CONTENT_LIMITS.blocks) contentError('INVALID_VALUE', 'A column must contain a bounded list of blocks.');
  const blocks = value.map(entry => parseContentBlock(entry, Boolean(entry?.locked)));
  if (new Set(blocks.map(block => block.id)).size !== blocks.length) contentError('INVALID_VALUE', 'Blocks in a column must have unique identities.');
  for (const block of blocks) {
    if (block.region || block.layoutKey || ['PageBreak', 'SectionBreak'].includes(block.definitionKey)) contentError('INVALID_VALUE', 'A column contains flowing content, not page or section boundaries.');
    if (isColumns(block.definitionKey)) for (const slot of COLUMN_SLOTS) columnBlocks(block.values[slot], depth + 1);
    if (isInclusionCopy(block.values.content)) columnBlocks(readInclusionCopy(block.values.content).blocks, depth + 1);
  }
  return blocks;
}
export async function mapColumns(values: JsonObject, visit: (blocks: readonly ContentBlock[], slot: ColumnSlot) => Promise<readonly ContentBlock[]>): Promise<JsonObject> {
  const next = { ...values };
  for (const slot of COLUMN_SLOTS) if (values[slot] !== undefined) next[slot] = await visit(columnBlocks(values[slot]), slot) as unknown as JsonValue;
  return next;
}
