// SPDX-License-Identifier: BUSL-1.1
/**
 * WorkspaceListClient — client-side list pane for the split `EntityWorkspacePage`.
 *
 * Wraps `DataTable` + `useInfiniteList` using the same column/filter plumbing
 * as the generated `[entity]/list-client.tsx`. Preserves the props that the
 * workspace layout currently passes to the list side.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table/data-table";
import { TableFacetedFilter } from "@/components/ui/data-table/table-faceted-filter";
import { TableTextFilter } from "@/components/ui/data-table/table-text-filter";
import { usePersistentTableState } from "@/components/ui/data-table/use-persistent-table-state";
import {
  mapSchemaColumns,
  type EntityListColumn,
  type LocalizedText,
} from "@/components/ui/data-table/columns/map-schema-columns";
import {
  createActionsColumn,
  type EntityListActionDefinition,
  type EntityListRowActionConfig,
} from "@/components/ui/data-table/columns/create-actions-column";
import { useInfiniteList } from "@/hooks/use-infinite-list";
import type { EntityListConnection } from "@/components/entity/entity-list-rows";
import {
  DEFAULT_GENERATED_LIST_FILTERS,
  buildGeneratedListFilter,
  deserializeGeneratedListFilters,
  type GeneratedListTableFilters,
} from "@/components/entity/generated-list-filter";
import { resolveRouteTemplate } from "@/lib/route-template";

type AnyRow = Record<string, unknown>;

type ListSort = { field: string; direction: string };

type StaticOption = {
  label: LocalizedText;
  value: string;
};

export interface WorkspaceListFilter {
  key: string;
  type?: "select" | "text";
  label?: LocalizedText;
  placeholder?: LocalizedText;
  param?: string;
  staticOptions?: StaticOption[];
}

export interface WorkspaceListClientProps {
  columns: EntityListColumn[];
  initialRows: AnyRow[];
  initialEndCursor: string | null;
  initialHasNextPage: boolean;
  initialTotalCount: number;
  listAction: (opts?: {
    filter?: Record<string, unknown>;
    sort?: ListSort;
    first?: number;
    after?: string;
    query?: string;
  }) => Promise<EntityListConnection>;
  listQuery?: string;
  listSort?: ListSort;
  rowLink: string;
  lang: string;
  regionLabel: string;
  filters?: WorkspaceListFilter[];
  // Free-text search column for backend pushdown — see generated-list-filter.
  filterField?: string;
  searchPlaceholder?: string;
  actionDefinitions?: Record<string, EntityListActionDefinition>;
  rowActions?: EntityListRowActionConfig[];
  routes?: Record<string, LocalizedText | string>;
  deleteMutationName?: string;
  // Per-entity URL state key. Required so two workspace lists on the same
  // route group don't share a key (this used to be hard-coded to
  // "workspace-list" — that bug is now fixed at the call site).
  tableId: string;
}

function resolveLocalizedText(
  value: LocalizedText | undefined,
  fallback: string,
  lang: string,
): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, string | undefined>;
    const primary = record[lang];
    if (typeof primary === "string" && primary.length > 0) return primary;
    if (typeof record.en === "string" && record.en.length > 0) return record.en;
    if (typeof record.nl === "string" && record.nl.length > 0) return record.nl;
  }
  return fallback;
}

export function WorkspaceListClient({
  columns,
  initialRows,
  initialEndCursor,
  initialHasNextPage,
  initialTotalCount,
  listAction,
  listQuery,
  listSort,
  rowLink,
  lang,
  regionLabel,
  filters,
  filterField,
  searchPlaceholder,
  actionDefinitions,
  rowActions,
  routes,
  tableId,
}: WorkspaceListClientProps) {
  const router = useRouter();

  const [sorting, setSorting] = useState<SortingState>([]);
  const {
    search,
    setSearch,
    filters: tableFilters,
    setFilters: setTableFilters,
    resetTableState,
  } = usePersistentTableState<GeneratedListTableFilters>({
    tableId,
    defaultFilters: DEFAULT_GENERATED_LIST_FILTERS,
    deserializeFilters: deserializeGeneratedListFilters,
  });
  const facetSelections = tableFilters.facetSelections;
  const textFilterValues = tableFilters.textFilterValues;

  const backendFilter = useMemo(
    () =>
      buildGeneratedListFilter(
        { filterField, filters },
        { search, filters: tableFilters },
      ),
    [filterField, filters, search, tableFilters],
  );

  const {
    data,
    hasMore,
    isLoading,
    isFetchingMore,
    totalCount,
    error,
    onLoadMore,
  } = useInfiniteList<AnyRow>(listAction, {
    initialData: initialRows,
    initialCursor: initialEndCursor,
    initialHasMore: initialHasNextPage,
    initialTotalCount,
    query: listQuery,
    sort: listSort,
    filter: backendFilter,
    columns,
  });

  const hasRowActions = Array.isArray(rowActions) && rowActions.length > 0;

  const setFacetSelection = useCallback(
    (param: string, values: string[]) => {
      setTableFilters((current) => ({
        ...current,
        facetSelections: { ...current.facetSelections, [param]: values },
      }));
    },
    [setTableFilters],
  );

  const setTextFilterValue = useCallback(
    (param: string, value: string) => {
      setTableFilters((current) => ({
        ...current,
        textFilterValues: { ...current.textFilterValues, [param]: value },
      }));
    },
    [setTableFilters],
  );

  const tableColumns = useMemo<ColumnDef<AnyRow>[]>(() => {
    const baseColumns = mapSchemaColumns<AnyRow>(columns, { lang });
    if (!hasRowActions) return baseColumns;
    return [
      ...baseColumns,
      createActionsColumn<AnyRow>({
        actionDefinitions,
        rowActions,
        routes,
        lang,
      }),
    ];
  }, [columns, actionDefinitions, rowActions, routes, hasRowActions, lang]);

  const resolvedFilters = useMemo(() => {
    return (filters ?? []).map((filter) => {
      const fallback = filter.key;
      const title = resolveLocalizedText(filter.label, fallback, lang);
      const placeholder = resolveLocalizedText(filter.placeholder, title, lang);
      const param = filter.param ?? filter.key;

      const staticOptions = filter.staticOptions?.map((option) => ({
        value: option.value,
        label: resolveLocalizedText(option.label, option.value, lang),
      }));

      const derivedOptions = staticOptions?.length
        ? staticOptions
        : Array.from(
            new Set(
              data
                .map((row) => row[filter.key])
                .filter((value): value is string | number => value != null && value !== "")
                .map((value) => String(value)),
            ),
          )
            .sort((left, right) =>
              left.localeCompare(right, lang, { sensitivity: "base", numeric: true }),
            )
            .map((value) => ({ value, label: value }));

      return { filter, title, placeholder, param, options: derivedOptions };
    });
  }, [filters, data, lang]);

  // Backend is now authoritative for both search and faceted filtering
  // (`backendFilter` is forwarded into `useInfiniteList` above). No
  // client-side post-filter pass.
  const anyFilterActive =
    search.trim().length > 0 ||
    Object.values(facetSelections).some((values) => values.length > 0) ||
    Object.values(textFilterValues).some((value) => (value ?? "").trim().length > 0);

  const filtersNode = resolvedFilters.length > 0 ? (
    <>
      {resolvedFilters.map((entry) => {
        if ((entry.filter.type ?? "select") === "select") {
          return (
            <TableFacetedFilter
              key={entry.param}
              title={entry.title}
              options={entry.options}
              selectedValues={facetSelections[entry.param] ?? []}
              onSelectedChange={(values) => setFacetSelection(entry.param, values)}
            />
          );
        }
        return (
          <TableTextFilter
            key={entry.param}
            title={entry.title}
            placeholder={entry.placeholder}
            value={textFilterValues[entry.param] ?? ""}
            onChange={(value) => setTextFilterValue(entry.param, value)}
          />
        );
      })}
    </>
  ) : null;

  return (
    <div data-testid="entity-list-table" className="contents">
      <DataTable<AnyRow>
        columns={tableColumns}
        data={data}
        hasMore={hasMore}
        onLoadMore={onLoadMore}
        isLoading={isLoading}
        isFetchingMore={isFetchingMore}
        totalCount={totalCount}
        error={error}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: searchPlaceholder ?? (lang === "nl" ? "Zoeken..." : "Search..."),
        }}
        sorting={sorting}
        onSortingChange={setSorting}
        filters={filtersNode}
        regionLabel={regionLabel}
        onResetFilters={
          anyFilterActive ? resetTableState : undefined
        }
        getRowHref={(row) => resolveRouteTemplate(rowLink, row)}
        onRowClick={(row) => router.push(resolveRouteTemplate(rowLink, row))}
      />
    </div>
  );
}
