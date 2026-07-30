// SPDX-License-Identifier: BUSL-1.1
/**
 * Shared encoder/decoder for per-list table state (search + filters).
 *
 * Used by:
 * - `usePersistentTableState` (client hook) to read/write the live URL.
 * - Server components (Next.js pages) that need to read the same URL state
 *   to drive server-side filtering, so the SSR'd HTML matches the URL on
 *   hard refresh and there is no flash.
 *
 * URL format: a single param keyed by `tableId`, value is JSON-encoded
 * `{search, filters}`. Namespacing by `tableId` lets multiple tables share
 * a page without colliding on `?status=...` and friends.
 */
import { isRecord } from "@/lib/json-record";

export type TableState<TFilters> = {
  search: string;
  filters: TFilters;
};

export function normalizeTableStateValue<TFilters>(
  value: unknown,
  defaults: TableState<TFilters>,
  deserializeFilters?: (value: unknown) => TFilters,
): TableState<TFilters> | null {
  if (typeof value === "string") {
    try {
      return normalizeTableStateValue(
        JSON.parse(value) as unknown,
        defaults,
        deserializeFilters,
      );
    } catch {
      return null;
    }
  }

  if (!isRecord(value)) return null;

  const filters = deserializeFilters
    ? deserializeFilters(value.filters)
    : isRecord(value.filters) && isRecord(defaults.filters)
      ? ({ ...defaults.filters, ...value.filters } as TFilters)
      : defaults.filters;

  return {
    search:
      typeof value.search === "string" ? value.search : defaults.search,
    filters,
  };
}

/** Parse the raw URL-param value (stringified JSON) into a `TableState`. */
export function decodeTableStateValue<TFilters>(
  raw: string | null | undefined,
  defaults: TableState<TFilters>,
  deserializeFilters?: (value: unknown) => TFilters,
): TableState<TFilters> | null {
  if (!raw) return null;
  try {
    return normalizeTableStateValue(
      JSON.parse(raw) as unknown,
      defaults,
      deserializeFilters,
    );
  } catch {
    return null;
  }
}

/** Stringify a `TableState` for use as a URL-param value. */
export function encodeTableStateValue<TFilters>(
  state: TableState<TFilters>,
): string {
  return JSON.stringify(state);
}

/** Deep-equality check sufficient for the small JSON-serializable shapes used here. */
export function tableStatesEqual<TFilters>(
  a: TableState<TFilters>,
  b: TableState<TFilters>,
): boolean {
  if (a.search !== b.search) return false;
  return JSON.stringify(a.filters) === JSON.stringify(b.filters);
}

type ServerSearchParams =
  | Record<string, string | string[] | undefined>
  | URLSearchParams
  | null
  | undefined;

function readParam(
  searchParams: ServerSearchParams,
  key: string,
): string | null {
  if (!searchParams) return null;
  if (searchParams instanceof URLSearchParams) {
    return searchParams.get(key);
  }
  const value = searchParams[key];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Read the `TableState` for a given `tableId` from server-component
 * `searchParams`. Returns the defaults when the URL has no entry.
 *
 * Use from server components like:
 *
 * ```ts
 * const { search, filters } = readTableStateFromSearchParams(searchParams, {
 *   tableId: "whatsapp-templates",
 *   defaultFilters: { statusFilter: [] as string[] },
 * });
 * ```
 */
export function readTableStateFromSearchParams<TFilters>(
  searchParams: ServerSearchParams,
  options: {
    tableId: string;
    defaultSearch?: string;
    defaultFilters: TFilters;
    deserializeFilters?: (value: unknown) => TFilters;
  },
): TableState<TFilters> {
  const defaults: TableState<TFilters> = {
    search: options.defaultSearch ?? "",
    filters: options.defaultFilters,
  };
  const raw = readParam(searchParams, options.tableId);
  return (
    decodeTableStateValue(raw, defaults, options.deserializeFilters) ?? defaults
  );
}
