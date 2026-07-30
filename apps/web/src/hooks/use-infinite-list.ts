// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  ENTITY_LIST_PAGE_SIZE,
  mapConnectionRows,
  type EntityListConnection,
  type EntityListRowSourceColumn,
} from "@/components/entity/entity-list-rows";

export type ListSort = { field: string; direction: string };

export interface ListActionOptions {
  filter?: Record<string, unknown>;
  sort?: ListSort;
  first?: number;
  after?: string;
  query?: string;
}

export interface UseInfiniteListOptions<TData> {
  initialData?: TData[];
  initialCursor?: string | null;
  initialHasMore?: boolean;
  initialTotalCount?: number;
  pageSize?: number;
  query?: string;
  sort?: ListSort;
  filter?: Record<string, unknown>;
  /** Schema columns used by `mapConnectionRows` to flatten GraphQL nodes to row records. */
  columns?: EntityListRowSourceColumn[];
}

export interface UseInfiniteListResult<TData> {
  data: TData[];
  hasMore: boolean;
  /** True only during the initial load (no data yet). */
  isLoading: boolean;
  /** True while subsequent pages are being fetched. */
  isFetchingMore: boolean;
  totalCount: number;
  error: string | null;
  onLoadMore: () => void;
}

function mergeRows<TData>(current: TData[], incoming: TData[]): TData[] {
  const seenIds = new Set(
    current.map((row) => {
      const id = (row as { id?: unknown })?.id;
      return id == null ? "" : String(id);
    }),
  );
  const appended = incoming.filter((row) => {
    const rawId = (row as { id?: unknown })?.id;
    const id = rawId == null ? "" : String(rawId);
    if (!id) {
      return true;
    }
    if (seenIds.has(id)) {
      return false;
    }
    seenIds.add(id);
    return true;
  });

  return [...current, ...appended];
}

/**
 * Hook that drives cursor-based infinite lists backed by a GraphQL connection
 * list action. Replaces the legacy `InfiniteEntityList` wrapper component.
 *
 * Behaviour:
 * - If `initialData` is provided, the hook assumes the caller already
 *   server-rendered the first page and `isLoading` starts `false`.
 * - If `initialData` is omitted, the hook triggers a first fetch on mount
 *   and `isLoading` stays `true` until that call resolves.
 * - When `query`, `filter`, or `sort` change at runtime the hook resets the
 *   accumulated rows and refetches page 1 with the new options. A
 *   `requestVersion` ref acts as a stale-request guard so a slow response
 *   from an earlier set of options cannot clobber a newer one.
 * - Concurrent `onLoadMore` calls are coalesced via a ref guard.
 * - When the server returns the same cursor with zero new rows, the hook
 *   sets `hasMore = false` to avoid infinite loops.
 */
export function useInfiniteList<TData>(
  listAction: (opts?: ListActionOptions) => Promise<EntityListConnection>,
  options: UseInfiniteListOptions<TData> = {},
): UseInfiniteListResult<TData> {
  const {
    initialData,
    initialCursor = null,
    initialHasMore = false,
    initialTotalCount,
    pageSize = ENTITY_LIST_PAGE_SIZE,
    query,
    sort,
    filter,
    columns,
  } = options;

  const hasInitialData = initialData !== undefined;
  const startingData: TData[] = hasInitialData ? initialData : [];

  const [data, setData] = useState<TData[]>(startingData);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [hasMore, setHasMore] = useState<boolean>(initialHasMore);
  const [totalCount, setTotalCount] = useState<number>(
    initialTotalCount ?? startingData.length,
  );
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(!hasInitialData);
  const [isPending, startTransition] = useTransition();

  const dataRef = useRef(data);
  const cursorRef = useRef(cursor);
  const hasMoreRef = useRef(hasMore);
  const isLoadingMoreRef = useRef(false);
  /**
   * Monotonically incremented for every outgoing request. `applyPage`/error
   * handlers check the captured version against `requestVersion.current` and
   * drop the response if it has been superseded.
   */
  const requestVersion = useRef(0);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);
  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  const applyPage = useCallback(
    (page: EntityListConnection) => {
      const nextRows = columns
        ? (mapConnectionRows(page, columns) as unknown as TData[])
        : ((page.edges ?? [])
            .map((edge) => edge.node)
            .filter((node): node is Record<string, unknown> => !!node) as unknown as TData[]);

      const currentRows = dataRef.current;
      const merged = mergeRows(currentRows, nextRows);
      const nextCursor = page.pageInfo?.endCursor ?? null;
      const appendedCount = merged.length - currentRows.length;
      const madeProgress =
        appendedCount > 0 || nextCursor !== cursorRef.current;
      const nextHasMore = Boolean(page.pageInfo?.hasNextPage) && madeProgress;

      dataRef.current = merged;
      cursorRef.current = nextCursor;
      hasMoreRef.current = nextHasMore;

      setData(merged);
      setCursor(nextCursor);
      setHasMore(nextHasMore);
      setTotalCount((current) => page.totalCount ?? current);
      setError(null);
    },
    [columns],
  );

  const resetToFreshPage = useCallback(
    (page: EntityListConnection) => {
      const nextRows = columns
        ? (mapConnectionRows(page, columns) as unknown as TData[])
        : ((page.edges ?? [])
            .map((edge) => edge.node)
            .filter((node): node is Record<string, unknown> => !!node) as unknown as TData[]);

      const nextCursor = page.pageInfo?.endCursor ?? null;
      const nextHasMore = Boolean(page.pageInfo?.hasNextPage);

      dataRef.current = nextRows;
      cursorRef.current = nextCursor;
      hasMoreRef.current = nextHasMore;

      setData(nextRows);
      setCursor(nextCursor);
      setHasMore(nextHasMore);
      setTotalCount(page.totalCount ?? nextRows.length);
      setError(null);
    },
    [columns],
  );

  const fetchInitial = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const page = await listAction({
        query,
        sort,
        filter,
        first: pageSize,
      });
      if (requestVersion.current !== version) return;
      applyPage(page);
    } catch (caught) {
      if (requestVersion.current !== version) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "Laden van resultaten mislukt.",
      );
    } finally {
      if (requestVersion.current === version) {
        setIsLoading(false);
      }
    }
  }, [applyPage, filter, listAction, pageSize, query, sort]);

  // Initial fetch when no SSR-hydrated data was provided.
  const didInitialFetchRef = useRef(false);
  useEffect(() => {
    if (hasInitialData || didInitialFetchRef.current) return;
    didInitialFetchRef.current = true;
    void fetchInitial();
    // Intentionally only runs once on mount.
    // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot initial fetch
  }, []);

  // Refetch page 1 whenever `query`, `filter`, or `sort` change. Compares the
  // JSON representation to avoid false positives from new object identity
  // between renders with equivalent content. Skipped on the very first run so
  // initialData / fetchInitial remain the single source of truth for mount.
  const lastOptionsKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = JSON.stringify({
      query: query ?? null,
      filter: filter ?? null,
      sort: sort ?? null,
    });

    if (lastOptionsKeyRef.current === null) {
      // First render — baseline the key without triggering a refetch. The
      // mount-time `fetchInitial` effect (or `initialData`) already covers
      // the first page.
      lastOptionsKeyRef.current = key;
      return;
    }

    if (lastOptionsKeyRef.current === key) {
      return;
    }

    lastOptionsKeyRef.current = key;

    const version = ++requestVersion.current;
    isLoadingMoreRef.current = false;

    // Reset visible state immediately so the UI doesn't briefly show stale
    // rows alongside a loading indicator.
    dataRef.current = [];
    cursorRef.current = null;
    hasMoreRef.current = true;
    setData([]);
    setCursor(null);
    setHasMore(true);
    setTotalCount(0);
    setError(null);
    setIsLoading(true);

    startTransition(async () => {
      try {
        const page = await listAction({
          query,
          sort,
          filter,
          first: pageSize,
        });
        if (requestVersion.current !== version) return;
        resetToFreshPage(page);
      } catch (caught) {
        if (requestVersion.current !== version) return;
        setError(
          caught instanceof Error
            ? caught.message
            : "Laden van resultaten mislukt.",
        );
      } finally {
        if (requestVersion.current === version) {
          setIsLoading(false);
        }
      }
    });
  }, [query, filter, sort, listAction, pageSize, resetToFreshPage]);

  const onLoadMore = useCallback(() => {
    if (!hasMoreRef.current || isLoadingMoreRef.current) {
      return;
    }

    isLoadingMoreRef.current = true;
    const version = ++requestVersion.current;

    startTransition(async () => {
      try {
        const page = await listAction({
          query,
          sort,
          filter,
          first: pageSize,
          after: cursorRef.current ?? undefined,
        });
        if (requestVersion.current !== version) return;
        applyPage(page);
      } catch (caught) {
        if (requestVersion.current !== version) return;
        setError(
          caught instanceof Error
            ? caught.message
            : "Meer resultaten laden mislukt.",
        );
      } finally {
        if (requestVersion.current === version) {
          isLoadingMoreRef.current = false;
        }
      }
    });
  }, [applyPage, filter, listAction, pageSize, query, sort]);

  return {
    data,
    hasMore,
    isLoading,
    isFetchingMore: isPending || isLoadingMoreRef.current,
    totalCount,
    error,
    onLoadMore,
  };
}
