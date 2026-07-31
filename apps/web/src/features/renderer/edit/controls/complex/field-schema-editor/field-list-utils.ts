// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";

export function updateItemAtIndex(
  items: Field[],
  index: number,
  nextItem: Field,
  onChange: (items: Field[]) => void,
) {
  const nextItems = [...items];
  nextItems[index] = nextItem;
  onChange(nextItems);
}

export function buildSiblingKeyCounts(items: Field[]) {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = item.key.trim();
    if (key.length === 0) {
      return counts;
    }

    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}
