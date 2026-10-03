// SPDX-License-Identifier: BUSL-1.1

/**
 * One total order for identifiers that are compared between processes and
 * across page boundaries: plain UTF-16 code units, the same order `<` gives.
 *
 * `localeCompare` is not that order. ICU collation interleaves upper- and
 * lower-case ids (`CpqQuote.approve` sorts between `core.*` and `cpq.*`) and
 * varies with the ICU build, so a cursor advanced with `>` over a list sorted
 * with `localeCompare` loops and skips, and a fingerprint computed on two
 * differently built nodes disagrees.
 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
