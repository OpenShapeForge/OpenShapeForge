// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  type ColumnDef,
  type OnChangeFn,
  type RowSelectionState,
  type SortingState,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type { ListTableFileType } from "@openshapeforge/ui";
import type { ReactNode } from "react";
import { useRef } from "react";
import { Checkbox } from "@/features/renderer/edit/controls/basic/checkbox";
import { useRealtimeResource } from "@/features/realtime/lib/use-realtime-resource";
import type { RealtimeResourceKey } from "@/features/realtime/lib/resource-keys";
import { cn } from "@/lib/utils";
import {
  DefaultTableMarkup,
  FigmaListTableMarkup,
  SELECT_COLUMN_ID,
} from "./data-table-rendering";
import { TableBulkActionBar } from "./table-bulk-action-bar";
import { TableErrorBanner } from "./table-error-banner";
import { TableLoadMoreSentinel } from "./table-load-more-sentinel";
import {
  TableSummaryStrip,
  type TableSummaryItem,
} from "./table-summary-strip";
import { TableToolbar } from "./table-toolbar";

export interface DataTableProps<TData> {
  // Data
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  getRowId?: (row: TData, index: number) => string;

  // Infinite scroll (always on)
  onLoadMore: () => void | Promise<void>;
  hasMore: boolean;
  isLoading?: boolean;
  isFetchingMore?: boolean;
  totalCount?: number;

  // Search (required)
  search: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  };

  // Sorting (controlled)
  sorting: SortingState;
  onSortingChange: OnChangeFn<SortingState>;

  // Filters
  filters?: ReactNode;
  onResetFilters?: () => void;

  // Toolbar actions
  toolbarActions?: ReactNode;

  // Realtime invalidation (opt-in)
  realtimeResourceKey?: RealtimeResourceKey | RealtimeResourceKey[] | null;
  onRealtimeInvalidate?: () => void | Promise<void>;
  realtimeEnabled?: boolean;
  realtimeDebounceMs?: number;

  // Row selection (opt-in)
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: OnChangeFn<RowSelectionState>;
  bulkActions?: ReactNode;

  // Row interaction
  onRowClick?: (row: TData) => void;
  getRowHref?: (row: TData) => string | null | undefined;
  renderExpandedRow?: (row: TData) => ReactNode;
  isRowExpanded?: (row: TData) => boolean;

  // State feedback
  emptyMessage?: ReactNode;
  error?: ReactNode;

  // Layout
  density?: "compact" | "spacious";
  summary?: TableSummaryItem[];
  className?: string;
  presentation?: "default" | "figma-list";
  listGridTemplateColumns?: string;
  getListRowFileType?: (row: TData) => ListTableFileType | null | undefined;

  // Accessibility
  /** Label applied to the outer landmark region. Override when multiple tables
   *  render on the same page to keep landmarks unique. */
  regionLabel?: string;
}

function applyRowSelectionRange(
  previous: RowSelectionState,
  rowIds: string[],
  selected: boolean,
): RowSelectionState {
  const next = { ...previous };

  for (const rowId of rowIds) {
    if (selected) {
      next[rowId] = true;
    } else {
      delete next[rowId];
    }
  }

  return next;
}

function DataTableRealtimeSubscription({
  resourceKey,
  enabled,
  debounceMs,
  onInvalidate,
}: {
  resourceKey: RealtimeResourceKey | RealtimeResourceKey[];
  enabled: boolean;
  debounceMs: number;
  onInvalidate: () => void | Promise<void>;
}) {
  useRealtimeResource(resourceKey, {
    enabled,
    debounceMs,
    onInvalidate,
  });

  return null;
}

export function DataTable<TData>({
  columns,
  data,
  getRowId,
  onLoadMore,
  hasMore,
  isLoading = false,
  isFetchingMore = false,
  totalCount,
  search,
  sorting,
  onSortingChange,
  filters,
  onResetFilters,
  toolbarActions,
  realtimeResourceKey,
  onRealtimeInvalidate,
  realtimeEnabled = true,
  realtimeDebounceMs = 300,
  rowSelection,
  onRowSelectionChange,
  bulkActions,
  onRowClick,
  getRowHref,
  renderExpandedRow,
  isRowExpanded,
  emptyMessage = "Geen resultaten gevonden.",
  error,
  density = "spacious",
  summary,
  className,
  presentation = "default",
  listGridTemplateColumns,
  getListRowFileType,
  regionLabel = "Data tabel",
}: DataTableProps<TData>) {
  const selectionEnabled = typeof onRowSelectionChange === "function";
  const lastSelectionAnchorRowIdRef = useRef<string | null>(null);
  const nextSelectionUsesRangeRef = useRef(false);

  const effectiveColumns: ColumnDef<TData, unknown>[] = selectionEnabled
    ? [
        {
          id: SELECT_COLUMN_ID,
          header: ({ table }) => (
            <Checkbox
              checked={
                table.getIsAllPageRowsSelected() ||
                (table.getIsSomePageRowsSelected() && "indeterminate")
              }
              onCheckedChange={(value) =>
                table.toggleAllPageRowsSelected(!!value)
              }
              aria-label="Selecteer alles"
            />
          ),
          cell: ({ row, table }) => (
            <div onClick={(event) => event.stopPropagation()}>
              <Checkbox
                checked={row.getIsSelected()}
                onClickCapture={(event) => {
                  nextSelectionUsesRangeRef.current = event.shiftKey;
                }}
                onMouseDown={(event) => {
                  nextSelectionUsesRangeRef.current = event.shiftKey;
                }}
                onPointerDown={(event) => {
                  nextSelectionUsesRangeRef.current = event.shiftKey;
                }}
                onKeyDown={(event) => {
                  if (event.key === " " || event.key === "Enter") {
                    nextSelectionUsesRangeRef.current = event.shiftKey;
                  }
                }}
                onCheckedChange={(value) => {
                  const selected = value === true;
                  const useRange = nextSelectionUsesRangeRef.current;
                  nextSelectionUsesRangeRef.current = false;

                  const anchorRowId = lastSelectionAnchorRowIdRef.current;
                  lastSelectionAnchorRowIdRef.current = row.id;

                  if (!useRange || !anchorRowId || anchorRowId === row.id) {
                    row.toggleSelected(selected);
                    return;
                  }

                  const currentRows = table.getRowModel().rows;
                  const anchorIndex = currentRows.findIndex(
                    (currentRow) => currentRow.id === anchorRowId,
                  );
                  const targetIndex = currentRows.findIndex(
                    (currentRow) => currentRow.id === row.id,
                  );

                  if (anchorIndex === -1 || targetIndex === -1) {
                    row.toggleSelected(selected);
                    return;
                  }

                  const [startIndex, endIndex] =
                    anchorIndex < targetIndex
                      ? [anchorIndex, targetIndex]
                      : [targetIndex, anchorIndex];
                  const rangeRowIds = currentRows
                    .slice(startIndex, endIndex + 1)
                    .map((currentRow) => currentRow.id);

                  onRowSelectionChange?.((previous) =>
                    applyRowSelectionRange(previous, rangeRowIds, selected),
                  );
                }}
                aria-label="Selecteer rij"
              />
            </div>
          ),
          enableSorting: false,
          enableHiding: false,
          meta: {
            headerClassName: "w-10",
            headerContentClassName: "justify-center px-0",
            cellClassName: "w-10",
            cellContentClassName: "px-0",
          },
        } satisfies ColumnDef<TData, unknown>,
        ...columns,
      ]
    : columns;

  const table = useReactTable<TData>({
    data,
    columns: effectiveColumns,
    state: {
      sorting,
      ...(rowSelection ? { rowSelection } : {}),
    },
    onSortingChange,
    onRowSelectionChange: onRowSelectionChange,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    enableRowSelection: selectionEnabled,
    getRowId: getRowId,
  });

  const visibleLeafColumnsCount = table.getVisibleLeafColumns().length;

  const bodyRows = table.getRowModel().rows;
  const showSkeleton = isLoading && bodyRows.length === 0;
  const showEmpty = !isLoading && bodyRows.length === 0;

  const selectedCount = selectionEnabled
    ? Object.keys(rowSelection ?? {}).filter((key) => rowSelection?.[key])
        .length
    : 0;

  const isFigmaList = presentation === "figma-list";

  const tableMarkup = isFigmaList ? (
    <FigmaListTableMarkup<TData>
      table={table}
      visibleLeafColumnsCount={visibleLeafColumnsCount}
      selectionEnabled={selectionEnabled}
      showSkeleton={showSkeleton}
      showEmpty={showEmpty}
      emptyMessage={emptyMessage}
      onRowClick={onRowClick}
      getRowHref={getRowHref}
      renderExpandedRow={renderExpandedRow}
      isRowExpanded={isRowExpanded}
      listGridTemplateColumns={listGridTemplateColumns}
      getListRowFileType={getListRowFileType}
    />
  ) : (
    <DefaultTableMarkup<TData>
      table={table}
      visibleLeafColumnsCount={visibleLeafColumnsCount}
      selectionEnabled={selectionEnabled}
      showSkeleton={showSkeleton}
      showEmpty={showEmpty}
      emptyMessage={emptyMessage}
      onRowClick={onRowClick}
      getRowHref={getRowHref}
      renderExpandedRow={renderExpandedRow}
      isRowExpanded={isRowExpanded}
      density={density}
    />
  );

  return (
    <div
      role="region"
      aria-label={regionLabel}
      aria-busy={isLoading || isFetchingMore}
      className={cn("space-y-4", className)}
    >
      {realtimeResourceKey && onRealtimeInvalidate ? (
        <DataTableRealtimeSubscription
          resourceKey={realtimeResourceKey}
          enabled={realtimeEnabled}
          debounceMs={realtimeDebounceMs}
          onInvalidate={onRealtimeInvalidate}
        />
      ) : null}

      {error ? <TableErrorBanner>{error}</TableErrorBanner> : null}

      {density === "spacious" && summary && summary.length > 0 ? (
        <TableSummaryStrip items={summary} />
      ) : null}

      <TableToolbar
        search={{
          value: search.value,
          onChange: search.onChange,
          placeholder: search.placeholder,
        }}
        filters={filters}
        onResetFilters={onResetFilters}
        actions={toolbarActions}
      />

      <div
        className={cn(
          "overflow-hidden bg-white",
          isFigmaList
            ? "rounded-none border-0"
            : "rounded-[14px] border border-border",
        )}
      >
        {tableMarkup}

        <TableLoadMoreSentinel
          hasMore={hasMore}
          isFetchingMore={isFetchingMore}
          totalCount={totalCount ?? data.length}
          onLoadMore={onLoadMore}
        />
      </div>

      {selectionEnabled && bulkActions && selectedCount > 0 ? (
        <TableBulkActionBar
          selectedCount={selectedCount}
          onClearSelection={() => onRowSelectionChange?.({})}
        >
          {bulkActions}
        </TableBulkActionBar>
      ) : null}
    </div>
  );
}
