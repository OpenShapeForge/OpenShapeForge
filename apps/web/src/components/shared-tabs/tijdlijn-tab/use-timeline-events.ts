// SPDX-License-Identifier: BUSL-1.1
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { getTimelineEvents } from "@/actions/timeline";
import type { TimelineEvent, TimelineResponse } from "@/lib/timeline-types";
import type { TijdlijnTabProps } from "./types";

type UseTimelineEventsArgs = Pick<
  TijdlijnTabProps,
  "entityUri" | "include" | "from" | "to"
> & {
  categorie?: string;
  actie?: string;
};

export function useTimelineEvents({
  entityUri,
  include,
  from,
  to,
  categorie,
  actie,
}: UseTimelineEventsArgs) {
  // Memoize the include list by content so identical relationship sets have a
  // stable key for request invalidation checks.
  const includeKey = useMemo(
    () => (include ?? []).map((entry) => entry.relationship).sort().join("|"),
    [include],
  );
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(false);
  const [isPending, startTransition] = useTransition();
  const requestVersion = useRef(0);

  useEffect(() => {
    const currentVersion = requestVersion.current + 1;
    requestVersion.current = currentVersion;

    setIsInitialLoading(true);

    startTransition(async () => {
      try {
        const result: TimelineResponse = await getTimelineEvents(entityUri, {
          limit: 20,
          categorie,
          actie,
          include,
          from,
          to,
        });

        if (requestVersion.current !== currentVersion) return;

        setEvents(result.events);
        setNextCursor(result.nextCursor);
        setTotal(result.total);
        setHasLoaded(true);
        setError(null);
      } catch (caught) {
        if (requestVersion.current !== currentVersion) return;
        setError(
          caught instanceof Error
            ? caught.message
            : "Tijdlijn laden mislukt.",
        );
      } finally {
        if (requestVersion.current === currentVersion) {
          setIsInitialLoading(false);
        }
      }
    });
  }, [entityUri, categorie, actie, includeKey, from, to, include]);

  const onLoadMore = useCallback(() => {
    if (!nextCursor || isPending) return;

    const cursor = nextCursor;
    const currentVersion = requestVersion.current + 1;
    requestVersion.current = currentVersion;

    startTransition(async () => {
      try {
        const result: TimelineResponse = await getTimelineEvents(entityUri, {
          cursor,
          limit: 20,
          categorie,
          actie,
          include,
          from,
          to,
        });

        if (requestVersion.current !== currentVersion) return;

        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          const appended = result.events.filter((e) => !seen.has(e.id));
          return [...prev, ...appended];
        });
        setNextCursor(result.nextCursor);
        setTotal(result.total);
      } catch (caught) {
        if (requestVersion.current !== currentVersion) return;
        setError(
          caught instanceof Error
            ? caught.message
            : "Meer items laden mislukt.",
        );
      }
    });
  }, [entityUri, nextCursor, isPending, categorie, actie, include, from, to]);

  return {
    events,
    hasLoaded,
    hasMore: Boolean(nextCursor),
    isFetchingMore: isPending && events.length > 0,
    isInitialLoading,
    onLoadMore,
    total,
    error,
  };
}
