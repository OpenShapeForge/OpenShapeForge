// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useEffect, useRef } from "react";
import { useRealtimeContext } from "@/features/realtime/components/RealtimeProvider";
import type { RealtimeResourceKey } from "@/features/realtime/lib/resource-keys";

type UseRealtimeResourceOptions = {
  enabled?: boolean;
  onInvalidate: () => void | Promise<void>;
  debounceMs?: number;
};

export function useRealtimeResource(
  resourceKey: RealtimeResourceKey | RealtimeResourceKey[] | null,
  {
    enabled = true,
    onInvalidate,
    debounceMs = 300,
  }: UseRealtimeResourceOptions,
) {
  const { subscribe } = useRealtimeContext();
  const callbackRef = useRef(onInvalidate);
  callbackRef.current = onInvalidate;

  useEffect(() => {
    const resourceKeys = Array.isArray(resourceKey)
      ? resourceKey.filter(Boolean)
      : resourceKey
        ? [resourceKey]
        : [];

    if (!enabled || resourceKeys.length === 0) {
      return;
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribes = resourceKeys.map((key) =>
      subscribe(key, () => {
        if (debounceMs <= 0) {
          void callbackRef.current();
          return;
        }

        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
          void callbackRef.current();
        }, debounceMs);
      }),
    );

    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  }, [debounceMs, enabled, resourceKey, subscribe]);
}
