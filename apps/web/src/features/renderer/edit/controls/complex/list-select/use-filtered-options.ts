// SPDX-License-Identifier: BUSL-1.1
import { useMemo } from "react";
import type { ListSelectOption } from "./types";

export function useFilteredOptions(
  options: ListSelectOption[],
  query: string,
) {
  return useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(normalized) ||
        option.value.toLowerCase().includes(normalized) ||
        (option.description?.toLowerCase().includes(normalized) ?? false),
    );
  }, [options, query]);
}
