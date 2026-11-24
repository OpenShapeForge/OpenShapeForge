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
// Leave room for executable Operation schemas.
const MAX_RECORD_GROUP_BYTES = 8_000;

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
  let response: unknown;
  try {
    if (!await input.eligible()) return { status: "unavailable", groups: [] };
    input.assertRequestActive();
    response = await input.execute({
      operation: { id: APPLICATION_SEARCH_OPERATION_ID, intent: "invoke" },
      input: {
        query,
        locale: input.locale.tag === "nl" ? "nl" : "en",
        ...(entity ? { entity } : {}),
        ...(cursor ? { after: cursor } : {}),
        first: entity ? SINGLE_ENTITY_PAGE : FANOUT_PAGE,
      },
    }, input.signal ? { signal: input.signal } : {});
  } catch {
    return { status: "unavailable", groups: [] };
  }
  const data = (response as { data?: unknown } | null)?.data as { groups?: unknown; incomplete?: unknown } | undefined;
  if (!data || typeof data !== "object" || !Array.isArray(data.groups)) return { status: "unavailable", groups: [] };
  return budgeted(data.groups, data.incomplete === true, entity);
}

/**
 * Keep the canonical order and complete pages. Dropped authorized groups
 * make a fan-out result incomplete and are named for targeted retrieval.
 */
function budgeted(raw: readonly unknown[], incomplete: boolean, targetEntity: string | undefined): RecordSearchResult {
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
    const remainingBytes = MAX_RECORD_GROUP_BYTES - bytes;
    let size = Buffer.byteLength(JSON.stringify(projected));
    if (targetEntity === group.entity && size > remainingBytes) {
      // Keep every canonical ID and cursor. Only display labels can be previewed.
      const overhead = Buffer.byteLength(JSON.stringify({
        ...projected,
        items: items.map(({ id }) => ({ id, label: "" })),
      }));
      // JSON can encode a character as six bytes (such as an escaped control
      // character). An ellipsis adds three bytes to a shortened label.
      const previewLength = Math.floor(((remainingBytes - overhead) / items.length - 3) / 6);
      if (previewLength >= 0) {
        for (const item of items) {
          const characters = [...item.label];
          if (characters.length > previewLength) item.label = characters.slice(0, previewLength).join("") + "…";
        }
        size = Buffer.byteLength(JSON.stringify(projected));
      }
    }
    if (total + items.length > MAX_RECORD_SEARCH_RESULTS || size > remainingBytes) {
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
