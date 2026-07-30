// SPDX-License-Identifier: BUSL-1.1
import { useCallback, useMemo, useState } from "react";
import { usePersistentTableState } from "@/components/ui/data-table/use-persistent-table-state";
import type { TimelineEvent } from "@/lib/timeline-types";
import { ACTIE_LABELS, DOMAIN_COLORS } from "./timeline-styles";
import { TimelineFieldDiff } from "./timeline-field-diff";
import {
  DEFAULT_TABLE_FILTERS,
  type TimelineSortingState,
} from "./types";

export function useTimelineTableState() {
  const {
    search,
    setSearch,
    filters: tableFilters,
    setFilters: setTableFilters,
    resetTableState,
  } = usePersistentTableState({
    tableId: "timeline",
    defaultFilters: DEFAULT_TABLE_FILTERS,
  });
  const categorieFilter = tableFilters.categorieFilter;
  const actieFilter = tableFilters.actieFilter;
  const [sorting, setSorting] = useState<TimelineSortingState>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set<string>(),
  );

  const setCategorieFilter = useCallback(
    (categorieFilter: string[]) => {
      setTableFilters((current) => ({ ...current, categorieFilter }));
    },
    [setTableFilters],
  );

  const setActieFilter = useCallback(
    (actieFilter: string[]) => {
      setTableFilters((current) => ({ ...current, actieFilter }));
    },
    [setTableFilters],
  );

  const handleRowClick = useCallback((event: TimelineEvent) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(event.id)) {
        next.delete(event.id);
      } else {
        next.add(event.id);
      }
      return next;
    });
  }, []);

  const isRowExpanded = useCallback(
    (event: TimelineEvent) => expandedIds.has(event.id),
    [expandedIds],
  );

  const renderExpandedRow = useCallback((event: TimelineEvent) => {
    const fieldChanges = event.metadata?.fieldChanges ?? [];
    return <TimelineFieldDiff fieldChanges={fieldChanges} />;
  }, []);

  const domainOptions = useMemo(
    () =>
      Object.keys(DOMAIN_COLORS).map((d) => ({
        value: d,
        label: d,
      })),
    [],
  );

  const actieOptions = useMemo(
    () =>
      Object.entries(ACTIE_LABELS).map(([value, label]) => ({ value, label })),
    [],
  );

  const isFiltered =
    categorieFilter.length > 0 ||
    actieFilter.length > 0 ||
    search.trim().length > 0;

  return {
    actie: actieFilter[0],
    actieFilter,
    actieOptions,
    categorie: categorieFilter[0],
    categorieFilter,
    domainOptions,
    handleRowClick,
    isFiltered,
    isRowExpanded,
    renderExpandedRow,
    resetTableState,
    search,
    setActieFilter,
    setCategorieFilter,
    setSearch,
    setSorting,
    sorting,
  };
}

export function useFilteredTimelineEvents(
  events: TimelineEvent[],
  search: string,
) {
  // The gateway does not accept a text-search parameter on this endpoint, so
  // the search input performs a client-side filter over the already-loaded
  // events. The server-side request remains bounded by the timeline page size.
  return useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return events;
    return events.filter((event) => {
      const haystack = [
        event.titel,
        event.omschrijving ?? "",
        event.categorie,
        event.actie,
        event.actor?.displayName ?? "",
        event.actor?.roleLabel ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [events, search]);
}
