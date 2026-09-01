// SPDX-License-Identifier: BUSL-1.1
import type { CompiledField } from "./authoring/types.js";

export type FieldQueryCapabilities = {
  searchable: boolean;
  filterable: boolean;
  sortable: boolean;
};

function isScalar(field: Pick<CompiledField, "cardinality" | "valueType">): boolean {
  return field.cardinality !== "collection" && field.valueType !== "object";
}

/**
 * Backward-compatible effective query behavior. Existing single scalar fields
 * remain filterable and sortable when no flag is authored. Existing text
 * fields also become the default free-text search corpus. Explicit false opts
 * out; explicit true is rejected by authoring validation on unsupported shapes.
 */
export function fieldQueryCapabilities(
  field: Pick<CompiledField, "cardinality" | "valueType" | "searchable" | "filterable" | "sortable">,
): FieldQueryCapabilities {
  const scalar = isScalar(field);
  const text = scalar && field.valueType === "string";
  return {
    searchable: text && field.searchable !== false,
    filterable: scalar && field.filterable !== false,
    sortable: scalar && field.sortable !== false,
  };
}
