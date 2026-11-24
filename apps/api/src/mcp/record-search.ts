// SPDX-License-Identifier: BUSL-1.1
/**
 * The additive `records` branch of the searchable Operation search tool.
 *
 * Records are found by the canonical `application.search` Operation, entered
 * through the same audited Operation runtime the executor uses: its authorization,
 * row-level security, field projection, ordering and per-entity cursors decide
 * what is returned. This module only maps the request onto it, contains
 * record-side failures, and bounds the total number of references in a response.
 */
import { MAX_RECORD_SEARCH_RESULTS } from "@openshapeforge/operations";
import type { RecordSearchArguments } from "./operation-search.js";

export const APPLICATION_SEARCH_OPERATION_ID = "application.search";
/** Per-entity page sizes, within the canonical per-source limit (20). */
const FANOUT_PAGE = 5;
const SINGLE_ENTITY_PAGE = 10;
// Leave room for executable Operation schemas and keep full labels and cursors together.
const MAX_RECORD_GROUP_BYTES = 8_000;
const MAX_LABEL_PREVIEW_CHARACTERS = 400;

export type RecordSearchStatus = "ok" | "incomplete" | "unavailable";
export type RecordGroup = { entity: string; items: { id: string; label: string }[]; nextCursor?: string };
export type RecordSearchResult = { status: RecordSearchStatus; groups: RecordGroup[]; truncated?: string[] };

type Execute = (
  request: { operation: { id: string; intent: "invoke" }; input: Record<string, unknown> },
  options: { signal?: AbortSignal },
) => Promise<unknown>;

/**
 * Search records. Never throws for a record-side dependency failure: that is
 * `unavailable`, with no error detail. Cancellation is the caller's to observe:
 * it must discard this result when the request was cancelled.
 */
export async function searchRecords(input: {
  records: RecordSearchArguments;
  eligible: () => Promise<boolean>;
  assertRequestActive: () => void;
  locale: { tag: string };
  execute: Execute;
  signal?: AbortSignal;
}): Promise<RecordSearchResult> {
  const { query, entity, cursor } = input.records;
  const search = async (first: number): Promise<RecordSearchResult> => {
    input.assertRequestActive();
    const response = await input.execute({
      operation: { id: APPLICATION_SEARCH_OPERATION_ID, intent: "invoke" },
      input: {
        query,
        locale: input.locale.tag === "nl" ? "nl" : "en",
        ...(entity ? { entity } : {}),
        ...(cursor ? { after: cursor } : {}),
        first,
      },
    }, input.signal ? { signal: input.signal } : {});
    const data = (response as { data?: unknown } | null)?.data as { groups?: unknown; incomplete?: unknown } | undefined;
    if (!data || typeof data !== "object" || !Array.isArray(data.groups)) return { status: "unavailable", groups: [] };
    return budgeted(data.groups, data.incomplete === true, first === 1);
  };
  try {
    if (!await input.eligible()) return { status: "unavailable", groups: [] };
    const result = await search(entity ? SINGLE_ENTITY_PAGE : FANOUT_PAGE);
    // Re-read an oversized targeted page at the same position for a usable cursor.
    if (entity && result.truncated?.includes(entity)) return await search(1);
    return result;
  } catch {
    return { status: "unavailable", groups: [] };
  }
}

/**
 * Keep the canonical group order. A group is kept whole or dropped: trimming
 * its items would leave its cursor pointing past results the caller never saw.
 * Dropped authorized groups make the result incomplete and are named.
 */
function budgeted(raw: readonly unknown[], incomplete: boolean, allowLabelPreview: boolean): RecordSearchResult {
  const groups: RecordGroup[] = [];
  const truncated: string[] = [];
  let total = 0;
  let bytes = 0;
  for (const candidate of raw) {
    const group = candidate as { entity?: unknown; items?: unknown; nextCursor?: unknown } | null;
    if (typeof group?.entity !== "string" || !Array.isArray(group.items)) {
      incomplete = true;
      continue;
    }
    const items = group.items.flatMap((item: { id?: unknown; label?: unknown } | null) =>
      typeof item?.id === "string" && typeof item.label === "string" ? [{ id: item.id, label: item.label }] : []);
    if (items.length !== group.items.length) incomplete = true;
    if (items.length === 0) continue;
    const projected = {
      entity: group.entity,
      items,
      ...(typeof group.nextCursor === "string" && group.nextCursor ? { nextCursor: group.nextCursor } : {}),
    };
    let size = Buffer.byteLength(JSON.stringify(projected));
    if (allowLabelPreview && items.length === 1 && size > MAX_RECORD_GROUP_BYTES) {
      // One long label must not make its record or the rest of the page unreachable.
      const item = items[0]!;
      item.label = [...item.label].slice(0, MAX_LABEL_PREVIEW_CHARACTERS).join("") + "…";
      size = Buffer.byteLength(JSON.stringify(projected));
    }
    if (total + items.length > MAX_RECORD_SEARCH_RESULTS || bytes + size > MAX_RECORD_GROUP_BYTES) {
      truncated.push(group.entity);
      continue;
    }
    total += items.length;
    bytes += size;
    groups.push(projected);
  }
  const status: RecordSearchStatus = incomplete || truncated.length > 0 ? "incomplete" : "ok";
  return { status, groups, ...(truncated.length > 0 ? { truncated } : {}) };
}
