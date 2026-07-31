// SPDX-License-Identifier: BUSL-1.1
/**
 * Adapter that converts the compiler's column schema (`EntityListColumn[]`) to
 * TanStack Table `ColumnDef[]`. Mirrors the cell rendering logic from the
 * legacy `EntityList` so that compiler-emitted list pages can switch to
 * `DataTable` without behavioural changes.
 */

import { createElement, type ComponentType, type ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { resolveReferentieGroepItems } from "@/lib/referentiedata";
import { TableColumnHeader as TableColumnHeaderBase } from "@/components/ui/data-table/table-column-header";

// `TableColumnHeader` is generic over `<TData, TValue>`. When we build columns
// dynamically from a schema the concrete row type isn't available to the JSX
// factory, so cast it to a non-generic component type for `createElement`.
const TableColumnHeader = TableColumnHeaderBase as ComponentType<{
  column: unknown;
  title: string;
  className?: string;
}>;

export type LocalizedText = string | { en?: string; nl?: string };

export interface EntityListColumn {
  key: string;
  label: string;
  sortable?: boolean;
  /**
   * Optional dotted path applied by `mapConnectionRows` when flattening
   * GraphQL nodes to row records. Defaults to `key` when omitted.
   */
  accessor?: string;
  render?: {
    component: string;
    props?: Record<string, unknown>;
  };
  referentieGroep?: string;
  headerClassName?: string;
  cellClassName?: string;
  contentClassName?: string;
  /** Render the cell value in a monospace font (identifiers, codes, …). */
  mono?: boolean;
  /** Treat this column as numeric: tabular-nums + right align. */
  numeric?: boolean;
  align?: "left" | "right" | "center";
}

function resolveLocalizedText(
  value: LocalizedText | undefined,
  fallback: string | undefined,
  lang: string,
): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, string | undefined>;
    const primary = record[lang];
    if (typeof primary === "string" && primary.length > 0) return primary;
    if (typeof record.en === "string" && record.en.length > 0) return record.en;
    if (typeof record.nl === "string" && record.nl.length > 0) return record.nl;
    return (
      Object.values(record).find(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      ) ?? fallback
    );
  }
  return fallback;
}

function humanizeReferenceValue(value: string): string {
  const normalized = value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (normalized.length === 0) return value;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function resolveColumnReferentieGroep(col: EntityListColumn): string | undefined {
  if (col.referentieGroep) return col.referentieGroep;
  const renderGroep = col.render?.props?.referentieGroep;
  return typeof renderGroep === "string" ? renderGroep : undefined;
}

function resolveCellDisplayValue(
  col: EntityListColumn,
  rawValue: unknown,
  lang: string,
): string {
  if (rawValue == null || rawValue === "") return "";

  const value = String(rawValue);

  if (col.render?.component === "ReferenceSelect") {
    const groep = resolveColumnReferentieGroep(col);
    if (groep) {
      const { items } = resolveReferentieGroepItems(groep);
      const option = items.find((item) => item.value === value);
      if (option) {
        return resolveLocalizedText(option.label, value, lang) ?? value;
      }
    }
    return humanizeReferenceValue(value);
  }

  return value;
}

export interface MapSchemaColumnsOptions {
  lang: string;
}

/**
 * Convert schema column definitions to TanStack column defs.
 *
 * `TData` defaults to `Record<string, unknown>` — the row shape used by the
 * list adapter (`mapConnectionRows`). Callers with stronger row typings can
 * specify it explicitly.
 */
export function mapSchemaColumns<TData extends Record<string, unknown> = Record<string, unknown>>(
  columns: EntityListColumn[],
  { lang }: MapSchemaColumnsOptions,
): ColumnDef<TData>[] {
  return columns.map((col) => {
    const sortable = col.sortable !== false;

    const columnDef: ColumnDef<TData> = {
      accessorKey: col.key,
      header: sortable
        ? ({ column }) =>
            createElement(TableColumnHeader, {
              column,
              title: col.label,
              className: col.headerClassName,
            })
        : () =>
            createElement(
              "div",
              {
                className: cn(
                  "text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground",
                  col.headerClassName,
                ),
              },
              col.label,
            ),
      enableSorting: sortable,
      cell: ({ row }) => {
        const rawValue = row.getValue(col.key);
        const value = resolveCellDisplayValue(col, rawValue, lang);

        const isRightAligned = col.align === "right" || col.numeric === true;

        if (col.mono) {
          return createElement(
            "span",
            {
              className: cn(
                "font-mono text-[13px] text-muted-foreground",
                col.contentClassName,
              ),
            },
            value,
          );
        }

        if (isRightAligned) {
          return createElement(
            "span",
            {
              className: cn("tabular-nums text-neutral-600", col.contentClassName),
              title: value,
            },
            value,
          );
        }

        if (!col.contentClassName) {
          return value as ReactNode;
        }

        return createElement(
          "div",
          {
            className: col.contentClassName,
            title: value,
          },
          value,
        );
      },
      meta: {
        headerClassName: col.headerClassName,
        cellClassName: col.cellClassName,
        listHeaderLabel: col.label,
      },
    };

    return columnDef;
  });
}
