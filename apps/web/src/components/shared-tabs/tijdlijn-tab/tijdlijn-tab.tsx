// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  DataTable,
  TableFacetedFilter,
} from "@/components/ui/data-table";
import type { TimelineEvent } from "@/lib/timeline-types";
import { TIMELINE_COLUMNS } from "./timeline-columns";
import { useTimelineEvents } from "./use-timeline-events";
import {
  useFilteredTimelineEvents,
  useTimelineTableState,
} from "./use-timeline-table-state";
import type { TijdlijnTabProps } from "./types";

export function TijdlijnTab({ entityUri, include, from, to }: TijdlijnTabProps) {
  const tableState = useTimelineTableState();
  const {
    events,
    error,
    hasLoaded,
    hasMore,
    isFetchingMore,
    isInitialLoading,
    onLoadMore,
    total,
  } = useTimelineEvents({
    entityUri,
    include,
    from,
    to,
    categorie: tableState.categorie,
    actie: tableState.actie,
  });
  const filteredEvents = useFilteredTimelineEvents(events, tableState.search);

  return (
    <div className="py-4">
      <DataTable<TimelineEvent>
        columns={TIMELINE_COLUMNS}
        data={filteredEvents}
        getRowId={(row) => row.id}
        onLoadMore={onLoadMore}
        hasMore={hasMore}
        isLoading={isInitialLoading && events.length === 0}
        isFetchingMore={isFetchingMore}
        totalCount={total}
        search={{
          value: tableState.search,
          onChange: tableState.setSearch,
          placeholder: "Zoeken in tijdlijn...",
        }}
        sorting={tableState.sorting}
        onSortingChange={tableState.setSorting}
        filters={
          <>
            <TableFacetedFilter
              title="Domein"
              // Gateway only supports a single categorie.
              mode="single"
              options={tableState.domainOptions}
              selectedValues={tableState.categorieFilter}
              onSelectedChange={tableState.setCategorieFilter}
            />
            <TableFacetedFilter
              title="Actie"
              mode="single"
              options={tableState.actieOptions}
              selectedValues={tableState.actieFilter}
              onSelectedChange={tableState.setActieFilter}
            />
          </>
        }
        onResetFilters={
          tableState.isFiltered ? tableState.resetTableState : undefined
        }
        onRowClick={tableState.handleRowClick}
        renderExpandedRow={tableState.renderExpandedRow}
        isRowExpanded={tableState.isRowExpanded}
        emptyMessage={
          hasLoaded
            ? "Geen activiteit gevonden voor dit item."
            : "Tijdlijn laden..."
        }
        error={error ?? undefined}
        regionLabel="Tijdlijn"
      />
    </div>
  );
}
