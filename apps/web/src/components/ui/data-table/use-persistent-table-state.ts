// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  decodeTableStateValue,
  encodeTableStateValue,
  tableStatesEqual,
  type TableState,
} from "./table-state";

const TABLE_STATE_STORAGE_PREFIX = "openshapeforge.table-state:v1";

type UsePersistentTableStateOptions<TFilters> = {
  tableId: string;
  defaultSearch?: string;
  defaultFilters: TFilters;
  initialState?: TableState<TFilters> | null;
  deserializeFilters?: (value: unknown) => TFilters;
  persistState?: (
    state: TableState<TFilters>,
    signal: AbortSignal,
  ) => Promise<void> | void;
  persistStateDebounceMs?: number;
};

export function usePersistentTableState<TFilters>({
  tableId,
  defaultSearch = "",
  defaultFilters,
  initialState,
  deserializeFilters,
  persistState,
  persistStateDebounceMs = 500,
}: UsePersistentTableStateOptions<TFilters>) {
  const router = useRouter();
  const pathname = usePathname() ?? "unknown";
  const searchParams = useSearchParams();

  const defaultStateRef = useRef<TableState<TFilters>>({
    search: defaultSearch,
    filters: defaultFilters,
  });
  defaultStateRef.current = { search: defaultSearch, filters: defaultFilters };

  const storageKey = useMemo(
    () => `${TABLE_STATE_STORAGE_PREFIX}:${pathname}:${tableId}`,
    [pathname, tableId],
  );

  const urlRaw = searchParams ? searchParams.get(tableId) : null;
  const hasInitialState = initialState !== undefined && initialState !== null;
  const persistStateRef = useRef(persistState);
  persistStateRef.current = persistState;
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistAbortRef = useRef<AbortController | null>(null);
  const didMutateRef = useRef(false);

  // Initial state: URL > server-loaded preference > defaults. Synchronous so
  // SSR and first client render agree, eliminating the flash for refreshed or
  // server-persisted filter state.
  const [state, setState] = useState<TableState<TFilters>>(() => {
    const fromUrl = decodeTableStateValue(
      urlRaw,
      defaultStateRef.current,
      deserializeFilters,
    );
    return fromUrl ?? initialState ?? defaultStateRef.current;
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const pendingPersistenceRef = useRef<TableState<TFilters> | null>(null);
  const didSyncUrlRef = useRef(false);

  useEffect(() => {
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      persistAbortRef.current?.abort();
      persistAbortRef.current = null;
      if (didMutateRef.current && persistStateRef.current) {
        const ac = new AbortController();
        void Promise.resolve(
          persistStateRef.current(stateRef.current, ac.signal),
        ).catch(() => {
          // Best-effort flush on unmount; ignore failures.
        });
      }
    };
  }, []);

  // Sync state when the URL changes for reasons we did not initiate
  // (browser back/forward, soft navigation with new params).
  // The deep-equal guard prevents the local-write -> URL-write -> state-write loop.
  useEffect(() => {
    if (!didSyncUrlRef.current) {
      didSyncUrlRef.current = true;
      return;
    }

    const fromUrl = decodeTableStateValue(
      urlRaw,
      defaultStateRef.current,
      deserializeFilters,
    );
    const next = fromUrl ?? defaultStateRef.current;
    if (tableStatesEqual(stateRef.current, next)) return;
    pendingPersistenceRef.current = null;
    stateRef.current = next;
    setState(next);
  }, [urlRaw, deserializeFilters]);

  const writeUrl = useCallback(
    (next: TableState<TFilters>) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (tableStatesEqual(next, defaultStateRef.current)) {
        params.delete(tableId);
      } else {
        params.set(tableId, encodeTableStateValue(next));
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams, tableId],
  );

  const writeStorage = useCallback(
    (next: TableState<TFilters>) => {
      if (typeof window === "undefined") return;
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Keep in-memory controls usable when localStorage is unavailable.
      }
    },
    [storageKey],
  );

  const writePersistedState = useCallback(() => {
    if (!persistStateRef.current) return;

    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
    }

    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      persistAbortRef.current?.abort();
      const ac = new AbortController();
      persistAbortRef.current = ac;
      const snapshot = stateRef.current;
      void Promise.resolve(
        persistStateRef.current?.(snapshot, ac.signal),
      ).catch(() => {
        // Preference persistence is a convenience; table controls should
        // remain usable if the background save fails.
      });
    }, persistStateDebounceMs);
  }, [persistStateDebounceMs]);

  // Layout effect: sync URL + localStorage before paint so `router.refresh()`
  // and other effects observe the same query string the user just committed.
  useLayoutEffect(() => {
    const pending = pendingPersistenceRef.current;
    if (!pending || !tableStatesEqual(pending, state)) return;

    pendingPersistenceRef.current = null;
    writeUrl(state);
    writeStorage(state);
    writePersistedState();
  }, [state, writePersistedState, writeStorage, writeUrl]);

  const commitLocalState = useCallback((next: TableState<TFilters>) => {
    if (tableStatesEqual(stateRef.current, next)) return;
    didMutateRef.current = true;
    stateRef.current = next;
    pendingPersistenceRef.current = next;
    setState(next);
  }, []);

  // Bare-URL fallback: when the URL has no state for this table, hydrate from
  // localStorage and push it into the URL. The brief flash on first paint here
  // is unavoidable — localStorage is client-only, so the server cannot read it.
  const [isHydrated, setIsHydrated] = useState(
    () => urlRaw !== null || hasInitialState,
  );
  const hydratedKeyRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (hasInitialState && urlRaw === null) {
      hydratedKeyRef.current = storageKey;
      setIsHydrated(true);
      return;
    }

    if (urlRaw !== null) {
      hydratedKeyRef.current = storageKey;
      setIsHydrated(true);
      return;
    }
    if (typeof window === "undefined") return;
    if (hydratedKeyRef.current === storageKey) return;
    hydratedKeyRef.current = storageKey;

    try {
      const raw = window.localStorage.getItem(storageKey);
      const fromStorage = decodeTableStateValue(
        raw,
        defaultStateRef.current,
        deserializeFilters,
      );
      if (
        fromStorage &&
        !tableStatesEqual(fromStorage, defaultStateRef.current)
      ) {
        stateRef.current = fromStorage;
        setState(fromStorage);
        writeUrl(fromStorage);
      }
    } catch {
      // ignore
    }
    setIsHydrated(true);
  }, [hasInitialState, storageKey, urlRaw, writeUrl, deserializeFilters]);

  const setSearch = useCallback(
    (search: string) => {
      commitLocalState({ ...stateRef.current, search });
    },
    [commitLocalState],
  );

  const setFilters = useCallback(
    (filters: TFilters | ((current: TFilters) => TFilters)) => {
      const current = stateRef.current;
      const nextFilters =
        typeof filters === "function"
          ? (filters as (current: TFilters) => TFilters)(current.filters)
          : filters;
      commitLocalState({ ...current, filters: nextFilters });
    },
    [commitLocalState],
  );

  const resetTableState = useCallback(() => {
    commitLocalState(defaultStateRef.current);
  }, [commitLocalState]);

  return {
    search: state.search,
    setSearch,
    filters: state.filters,
    setFilters,
    resetTableState,
    isHydrated,
  };
}
