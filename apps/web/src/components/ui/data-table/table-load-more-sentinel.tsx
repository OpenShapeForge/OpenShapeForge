// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useEffect, useRef } from "react";
import { Skeleton } from "@/components/ui/display/skeleton";

export interface TableLoadMoreSentinelProps {
  hasMore: boolean;
  isFetchingMore: boolean;
  totalCount: number;
  onLoadMore: () => void | Promise<void>;
  /** IntersectionObserver root margin. Defaults to "200px". */
  rootMargin?: string;
}

/**
 * A visually minimal sentinel rendered at the bottom of a data table. When it
 * enters the viewport (within `rootMargin`), `onLoadMore` fires as long as
 * `hasMore` is true and a fetch isn't already in flight.
 */
export function TableLoadMoreSentinel({
  hasMore,
  isFetchingMore,
  totalCount,
  onLoadMore,
  rootMargin = "200px",
}: TableLoadMoreSentinelProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    if (!hasMore) return;
    const node = sentinelRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void onLoadMoreRef.current();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, rootMargin]);

  return (
    <div
      className="py-2 text-center text-sm text-muted-foreground"
      data-slot="table-load-more-sentinel"
    >
      {isFetchingMore ? (
        <span className="inline-flex items-center gap-2">
          <Skeleton className="h-4 w-4 rounded-full" />
          Laden…
        </span>
      ) : !hasMore && totalCount > 0 ? (
        <span>Alle {totalCount} resultaten geladen</span>
      ) : null}
      <div ref={sentinelRef} className="h-px" aria-hidden="true" />
    </div>
  );
}
