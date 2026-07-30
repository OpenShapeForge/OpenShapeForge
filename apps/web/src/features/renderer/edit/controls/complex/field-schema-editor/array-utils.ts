// SPDX-License-Identifier: BUSL-1.1
export function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

export function moveArrayItem<T>(items: T[], index: number, direction: -1 | 1) {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= items.length) {
    return items;
  }

  const nextItems = [...items];
  const [item] = nextItems.splice(index, 1);
  nextItems.splice(targetIndex, 0, item);
  return nextItems;
}

export function duplicateArrayItem<T>(items: T[], index: number) {
  const nextItems = [...items];
  nextItems.splice(index + 1, 0, cloneValue(items[index]));
  return nextItems;
}
