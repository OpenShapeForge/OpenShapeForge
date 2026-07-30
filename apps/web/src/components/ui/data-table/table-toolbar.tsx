// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { ReactNode } from "react";
import { TableSearchInput } from "./table-search-input";
import { TableResetFiltersButton } from "./table-reset-filters-button";

export interface TableToolbarSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export interface TableToolbarProps {
  /** Search input configuration. Pass `null` to omit the search input. */
  search?: TableToolbarSearchProps | null;
  /** Filter controls rendered between search and reset. */
  filters?: ReactNode;
  /** When provided, a reset button is rendered after the filters. */
  onResetFilters?: () => void;
  /** Label for the reset button (defaults to "Herstellen"). */
  resetLabel?: string;
  /** Right-aligned action buttons (e.g. "New", "Export"). */
  actions?: ReactNode;
}

/**
 * Composed toolbar for a DataTable. Internally delegates to
 * `TableSearchInput` and `TableResetFiltersButton` so that the design team
 * can iterate on those primitives independently.
 */
export function TableToolbar({
  search,
  filters,
  onResetFilters,
  resetLabel,
  actions,
}: TableToolbarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        {search ? (
          <TableSearchInput
            value={search.value}
            onChange={search.onChange}
            placeholder={search.placeholder}
          />
        ) : null}

        {filters}

        {onResetFilters ? (
          <TableResetFiltersButton onClick={onResetFilters} label={resetLabel} />
        ) : null}
      </div>

      {actions ? (
        <div className="flex items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
