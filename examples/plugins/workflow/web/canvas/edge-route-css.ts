// SPDX-License-Identifier: BUSL-1.1
/**
 * Coercions for the loosely typed values that arrive on an edge's inline
 * `style`. A style object allows `string | number | undefined` on almost every
 * property, so a renderer that wants "the stroke colour, or the default" has to
 * narrow first. These are that narrowing, in one place, so the fallback is not
 * re-derived per call site.
 *
 * Like the route geometry beside it, this has no consumer yet — it belongs to
 * the routed-edge renderer, which this repository does not draw.
 */

/** A non-blank string, or the fallback. Blank strings are not colours. */
export function getCssColor(
  value: string | number | undefined,
  fallback: string,
): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

/** A finite number, parsing a leading numeric prefix (`"2px"` → `2`). */
export function getCssNumber(
  value: string | number | undefined,
  fallback: number,
): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

/**
 * Font weight passes through untouched — both `600` and `"semibold"` are valid
 * CSS — so the only job is dropping `undefined` explicitly rather than by
 * accident.
 */
export function getCssFontWeight(
  value: string | number | undefined,
): string | number | undefined {
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }

  return undefined;
}
