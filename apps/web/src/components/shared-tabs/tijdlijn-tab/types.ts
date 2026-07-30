// SPDX-License-Identifier: BUSL-1.1
import type { SortingState } from "@tanstack/react-table";

export interface TimelineIncludeOption {
  relationship: string;
}

export interface TijdlijnTabProps {
  entityUri: string;
  /**
   * Per-view relationship sources to compose into the timeline. `self` is
   * always implicit; only relationship entries need to be listed here.
   */
  include?: readonly TimelineIncludeOption[];
  /** Inclusive lower bound on `occurredAt`. ISO timestamp. */
  from?: string;
  /** Exclusive upper bound on `occurredAt`. ISO timestamp. */
  to?: string;
}

export type TimelineTableFilters = {
  categorieFilter: string[];
  actieFilter: string[];
};

export const DEFAULT_TABLE_FILTERS: TimelineTableFilters = {
  categorieFilter: [],
  actieFilter: [],
};

export type TimelineSortingState = SortingState;
