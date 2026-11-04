// SPDX-License-Identifier: BUSL-1.1
import type { FormulaType } from "./types.js";

const BY_BASE_TYPE: Readonly<Record<string, FormulaType>> = {
  string: "text",
  integer: "number",
  number: "number",
  money: "number",
  boolean: "boolean",
  date: "date",
  datetime: "timestamp",
};

/**
 * The formula type of a field, from its osfType's base type — the same
 * mapping that picks its index column. A collection, a reference or an
 * object type has none, and a formula cannot read it.
 */
export function formulaTypeForBaseType(
  baseType: string,
  cardinality: "single" | "collection" = "single",
): FormulaType | undefined {
  return cardinality === "collection" ? undefined : BY_BASE_TYPE[baseType];
}
