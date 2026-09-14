// SPDX-License-Identifier: BUSL-1.1
import type { GeneratedCrudColumn, GeneratedCrudTable } from "./types.js";

export function fieldNameForColumn(column: GeneratedCrudColumn) {
  return column.sourceField ??
    column.name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

export function fieldColumnMap(table: GeneratedCrudTable) {
  return new Map(table.columns.map((column) => [fieldNameForColumn(column), column]));
}

export function tableColumnMap(table: GeneratedCrudTable) {
  return new Map(table.columns.map((column) => [column.name, column]));
}
