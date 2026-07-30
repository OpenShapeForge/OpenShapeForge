// SPDX-License-Identifier: BUSL-1.1
import {
  type ColumnDef,
  type Table as TanStackTable,
  flexRender,
} from "@tanstack/react-table";
import {
  ListTable,
  ListTableBody,
  ListTableCell,
  type ListTableFileType,
  ListTableHead,
  ListTableHeader,
  ListTableRow,
  ListTableSortIcon,
} from "@openshapeforge/ui";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/display/skeleton";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";
import { TableEmptyState } from "./table-empty-state";
import { TableLoadingRow } from "./table-loading-row";

type ColumnClassMeta = {
  headerClassName?: string;
  headerContentClassName?: string;
  cellClassName?: string;
  cellContentClassName?: string;
  listHeaderLabel?: string;
};

export const SELECT_COLUMN_ID = "__data-table-select__";

function getColumnMeta<TData>(columnDef: ColumnDef<TData, unknown>): ColumnClassMeta {
  const meta = columnDef.meta;
  if (!meta || typeof meta !== "object") return {};
  return meta as ColumnClassMeta;
}

function isActionsColumnId(columnId: string) {
  return columnId === "actions";
}

function getListCellType(
  columnId: string,
  index: number,
  selectionEnabled: boolean,
) {
  if (columnId === SELECT_COLUMN_ID) return "icon" as const;
  if (isActionsColumnId(columnId)) return "icon" as const;
  return index === 0 || (selectionEnabled && index === 1)
    ? ("heavy" as const)
    : ("default" as const);
}

function isPrimaryDataCell(
  columnId: string,
  index: number,
  selectionEnabled: boolean,
) {
  if (columnId === SELECT_COLUMN_ID || isActionsColumnId(columnId)) {
    return false;
  }
  return index === 0 || (selectionEnabled && index === 1);
}

function DataTablePrimaryLink({ href, children }: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={(event) => event.stopPropagation()}
      className="block min-w-0 rounded-sm text-inherit no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {children}
    </Link>
  );
}

function ListTableLoadingRows({ columnCount }: { columnCount: number }) {
  return (
    <>
      {Array.from({ length: 6 }).map((_, rowIndex) => (
        <ListTableRow
          // biome-ignore lint/suspicious/noArrayIndexKey: stable skeleton count
          key={`loading-${rowIndex}`}
          aria-busy="true"
        >
          {Array.from({ length: columnCount }).map((_, cellIndex) => (
            <ListTableCell
              // biome-ignore lint/suspicious/noArrayIndexKey: column count is stable for the row
              key={cellIndex}
            >
              <Skeleton className="h-4 w-full" />
            </ListTableCell>
          ))}
        </ListTableRow>
      ))}
    </>
  );
}

function ListTableEmptyState({ message }: { message: ReactNode }) {
  return (
    <ListTableRow>
      <ListTableCell colSpan={1} contentClassName="justify-center text-center">
        <span className="text-muted-foreground">{message}</span>
      </ListTableCell>
    </ListTableRow>
  );
}

type DataTableRenderingProps<TData> = {
  table: TanStackTable<TData>;
  visibleLeafColumnsCount: number;
  selectionEnabled: boolean;
  showSkeleton: boolean;
  showEmpty: boolean;
  emptyMessage: ReactNode;
  onRowClick?: (row: TData) => void;
  getRowHref?: (row: TData) => string | null | undefined;
  renderExpandedRow?: (row: TData) => ReactNode;
  isRowExpanded?: (row: TData) => boolean;
};

export function FigmaListTableMarkup<TData>({
  table,
  visibleLeafColumnsCount,
  selectionEnabled,
  showSkeleton,
  showEmpty,
  emptyMessage,
  onRowClick,
  getRowHref,
  renderExpandedRow,
  isRowExpanded,
  listGridTemplateColumns,
  getListRowFileType,
}: DataTableRenderingProps<TData> & {
  listGridTemplateColumns?: string;
  getListRowFileType?: (row: TData) => ListTableFileType | null | undefined;
}) {
  return (
    <ListTable
      gridTemplateColumns={
        listGridTemplateColumns ??
        `repeat(${visibleLeafColumnsCount}, minmax(0, 1fr))`
      }
    >
      <ListTableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <ListTableRow key={headerGroup.id} type="header">
            {headerGroup.headers.map((header, index) => {
              const meta = getColumnMeta(header.column.columnDef);
              const cellType = getListCellType(
                header.column.id,
                index,
                selectionEnabled,
              );
              const headerCellType =
                header.column.id === SELECT_COLUMN_ID ? "default" : cellType;
              const label =
                meta.listHeaderLabel ??
                (typeof header.column.columnDef.header === "string"
                  ? header.column.columnDef.header
                  : undefined);
              return (
                <ListTableHead
                  key={header.id}
                  type={headerCellType}
                  className={cn(meta.headerClassName)}
                  contentClassName={cn(meta.headerContentClassName)}
                  iconRight={
                    headerCellType !== "icon" && header.column.getCanSort() ? (
                      <ListTableSortIcon />
                    ) : undefined
                  }
                >
                  {header.isPlaceholder
                    ? null
                    : label ??
                      flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                </ListTableHead>
              );
            })}
          </ListTableRow>
        ))}
      </ListTableHeader>
      <ListTableBody>
        {showSkeleton ? (
          <ListTableLoadingRows columnCount={visibleLeafColumnsCount} />
        ) : showEmpty ? (
          <ListTableEmptyState message={emptyMessage} />
        ) : (
          table.getRowModel().rows.map((row) => {
            const original = row.original;
            const expanded = isRowExpanded ? isRowExpanded(original) : false;
            const rowFileType = getListRowFileType?.(original);
            const rowHref = getRowHref?.(original) ?? null;
            return (
              <Fragment key={row.id}>
                <ListTableRow
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  data-row-id={
                    typeof (original as { id?: unknown })?.id === "string"
                      ? ((original as { id?: string }).id as string)
                      : undefined
                  }
                  onClick={onRowClick ? () => onRowClick(original) : undefined}
                  className={onRowClick ? "cursor-pointer" : undefined}
                >
                  {row.getVisibleCells().map((cell, index) => {
                    const meta = getColumnMeta(cell.column.columnDef);
                    const cellType = getListCellType(
                      cell.column.id,
                      index,
                      selectionEnabled,
                    );
                    const cellContent = flexRender(
                      cell.column.columnDef.cell,
                      cell.getContext(),
                    );
                    return (
                      <ListTableCell
                        key={cell.id}
                        type={cellType}
                        fileIcon={
                          rowFileType &&
                          cellType === "heavy" &&
                          !isActionsColumnId(cell.column.id)
                            ? rowFileType
                            : undefined
                        }
                        className={cn(meta.cellClassName)}
                        contentClassName={cn(meta.cellContentClassName)}
                      >
                        {rowHref &&
                        isPrimaryDataCell(
                          cell.column.id,
                          index,
                          selectionEnabled,
                        ) ? (
                          <DataTablePrimaryLink href={rowHref}>
                            {cellContent}
                          </DataTablePrimaryLink>
                        ) : (
                          cellContent
                        )}
                      </ListTableCell>
                    );
                  })}
                </ListTableRow>
                {expanded && renderExpandedRow ? (
                  <ListTableRow data-state="expanded">
                    <ListTableCell
                      colSpan={visibleLeafColumnsCount}
                      className="h-auto"
                      contentClassName="h-auto px-0"
                    >
                      {renderExpandedRow(original)}
                    </ListTableCell>
                  </ListTableRow>
                ) : null}
              </Fragment>
            );
          })
        )}
      </ListTableBody>
    </ListTable>
  );
}

export function DefaultTableMarkup<TData>({
  table,
  visibleLeafColumnsCount,
  selectionEnabled,
  showSkeleton,
  showEmpty,
  emptyMessage,
  onRowClick,
  getRowHref,
  renderExpandedRow,
  isRowExpanded,
  density,
}: DataTableRenderingProps<TData> & {
  density: "compact" | "spacious";
}) {
  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <TableHead
                key={header.id}
                className={cn(
                  getColumnMeta(header.column.columnDef).headerClassName,
                )}
              >
                {header.isPlaceholder
                  ? null
                  : flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {showSkeleton ? (
          Array.from({ length: 6 }).map((_, index) => (
            <TableLoadingRow
              // biome-ignore lint/suspicious/noArrayIndexKey: stable skeleton count
              key={`loading-${index}`}
              columnCount={visibleLeafColumnsCount}
            />
          ))
        ) : showEmpty ? (
          <TableEmptyState
            colSpan={visibleLeafColumnsCount}
            message={emptyMessage}
          />
        ) : (
          table.getRowModel().rows.map((row) => {
            const original = row.original;
            const expanded = isRowExpanded ? isRowExpanded(original) : false;
            const rowHref = getRowHref?.(original) ?? null;
            return (
              <Fragment key={row.id}>
                <TableRow
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  onClick={onRowClick ? () => onRowClick(original) : undefined}
                  className={onRowClick ? "cursor-pointer" : undefined}
                >
                  {row.getVisibleCells().map((cell, index) => {
                    const cellContent = flexRender(
                      cell.column.columnDef.cell,
                      cell.getContext(),
                    );
                    return (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          getColumnMeta(cell.column.columnDef).cellClassName,
                          density === "compact" && "py-1.5",
                        )}
                      >
                        {rowHref &&
                        isPrimaryDataCell(
                          cell.column.id,
                          index,
                          selectionEnabled,
                        ) ? (
                          <DataTablePrimaryLink href={rowHref}>
                            {cellContent}
                          </DataTablePrimaryLink>
                        ) : (
                          cellContent
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
                {expanded && renderExpandedRow ? (
                  <TableRow
                    data-state="expanded"
                    className="bg-muted/20 hover:bg-muted/20"
                  >
                    <TableCell
                      colSpan={visibleLeafColumnsCount}
                      className="p-0"
                    >
                      {renderExpandedRow(original)}
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
