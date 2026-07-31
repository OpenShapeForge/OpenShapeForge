// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useSyncExternalStore } from "react";
import {
  getEntityFieldSuggestionsVersion,
  subscribeEntityFieldSuggestions,
} from "@/features/renderer/runtime/entity-field-suggestions";

/**
 * Subscribes a component to the entity field-suggestion cache. The synchronous
 * `getEntityFieldSuggestions` / `getEntityConditionFilterFields` readers return
 * `[]` on a cache miss and warm the cache in the background; this hook makes the
 * subscribing component re-render when that fetch completes so the now-cached
 * suggestions are picked up. The returned version number is otherwise unused.
 *
 * Mounted once at the renderer root so every field/variable picker beneath it
 * (including workflow custom-field adapters) re-renders when suggestions load.
 */
export function useEntityFieldSuggestionsVersion(): number {
  return useSyncExternalStore(
    subscribeEntityFieldSuggestions,
    getEntityFieldSuggestionsVersion,
    () => 0,
  );
}
