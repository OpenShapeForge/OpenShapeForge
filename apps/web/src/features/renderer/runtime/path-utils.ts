// SPDX-License-Identifier: BUSL-1.1
/**
 * Path utilities for navigating nested form values by dotted-path strings.
 *
 * Form fields can live at arbitrary depths (e.g. "address.street" or
 * "items.0.name"). This module provides:
 * - `parseRendererPath` / `stringifyRendererPath` — convert between dotted
 *   string paths and typed path-part arrays
 * - `getValueAtPath` — immutably read a value from a nested object/array
 * - `setValueAtPath` — immutably set a value deep inside a nested structure
 *
 * Used by nearly every renderer runtime module for value access and updates.
 */
export type RendererPathPart = string | number;

export function getValueAtPath(
  source: unknown,
  path: readonly RendererPathPart[],
): unknown {
  return path.reduce<unknown>((current, part) => {
    if (typeof part === "number") {
      return Array.isArray(current) ? current[part] : undefined;
    }

    return current && typeof current === "object"
      ? (current as Record<string, unknown>)[part]
      : undefined;
  }, source);
}

export function setValueAtPath(
  source: unknown,
  path: readonly RendererPathPart[],
  value: unknown,
): unknown {
  if (path.length === 0) {
    return value;
  }

  const [head, ...tail] = path;

  if (typeof head === "number") {
    const currentArray = Array.isArray(source) ? [...source] : [];
    currentArray[head] = setValueAtPath(currentArray[head], tail, value);
    return currentArray;
  }

  const currentObject =
    source && typeof source === "object" && !Array.isArray(source)
      ? { ...(source as Record<string, unknown>) }
      : {};
  currentObject[head] = setValueAtPath(currentObject[head], tail, value);
  return currentObject;
}

export function parseRendererPath(path: string): RendererPathPart[] {
  if (!path.trim()) {
    return [];
  }

  return path
    .split(".")
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

export function stringifyRendererPath(path: readonly RendererPathPart[]): string {
  return path.map((part) => String(part)).join(".");
}
