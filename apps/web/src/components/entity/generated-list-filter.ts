// SPDX-License-Identifier: BUSL-1.1
/**
 * Shared shape + URL-state -> GraphQL filter translator for entity list
 * UIs. Imported by:
 *   - `app/(generated)/[entity]/page.tsx` and `list-client.tsx`     (server + client)
 *   - `EntityWorkspacePage` and `WorkspaceListClient`               (server + client)
 *
 * Both the dynamic-list and the workspace-list use the same
 * `{ facetSelections, textFilterValues }` shape under URL state, so a single
 * encoder works for either pane and keeps the contract in one place.
 */
import { isRecord } from "@/lib/json-record";

export type GeneratedListTableFilters = {
  facetSelections: Record<string, string[]>;
  textFilterValues: Record<string, string>;
};

export const DEFAULT_GENERATED_LIST_FILTERS: GeneratedListTableFilters = {
  facetSelections: {},
  textFilterValues: {},
};

function readStringArrayRecord(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string[]] =>
        Array.isArray(entry[1]) &&
        entry[1].every((item) => typeof item === "string"),
    ),
  );
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function deserializeGeneratedListFilters(
  value: unknown,
): GeneratedListTableFilters {
  if (!isRecord(value)) return DEFAULT_GENERATED_LIST_FILTERS;
  return {
    facetSelections: readStringArrayRecord(value.facetSelections),
    textFilterValues: readStringRecord(value.textFilterValues),
  };
}

/**
 * Translate per-list URL state into the GraphQL `<Entity>Filter` input the
 * resolver expects. Convention (matches the compiler's filter-input codegen):
 *   - free-text search: `filter[<filterField>] = search`  (resolver does
 *     `ilike '%value%'` for STRING_FIELDS, exact `=` otherwise)
 *   - faceted multi-select: `filter[<key>In] = [values]`  (resolver does
 *     SQL `IN (...)`)
 *   - free-text per-column filter (`type: "text"`):
 *     `filter[<key>] = value`
 *
 * Returns `undefined` when the filter would be empty so callers can omit
 * the GraphQL arg entirely.
 */
export function buildGeneratedListFilter(
  config: {
    filterField?: string;
    filters?: { key: string; type?: "select" | "text"; param?: string }[];
  },
  state: { search: string; filters: GeneratedListTableFilters },
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  const search = state.search.trim();
  if (search.length > 0 && config.filterField) {
    out[config.filterField] = search;
  }
  for (const filter of config.filters ?? []) {
    const param = filter.param ?? filter.key;
    if ((filter.type ?? "select") === "select") {
      const values = state.filters.facetSelections[param];
      if (Array.isArray(values) && values.length > 0) {
        out[`${filter.key}In`] = values;
      }
      continue;
    }
    const text = state.filters.textFilterValues[param]?.trim();
    if (text && text.length > 0) {
      out[filter.key] = text;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
