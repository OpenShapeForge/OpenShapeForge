// SPDX-License-Identifier: BUSL-1.1
/**
 * The type axis itself: every field definition names one `osfType`.
 *
 * `semanticType` is renamed in place. A field that only had `valueType` gets
 * that value as its `osfType` (the seven base types are osf types). An
 * authored `valueType` beside a semantic type is dropped: the catalog entry
 * already declares the base. Runs over the whole document — entity fields,
 * nested children/item/shape, catalog shapes, workflow-node and connector
 * fields — because they all share the FieldDefinition contract. A map counts
 * as a field when it has a `key` and one of the type properties.
 */
import type { Pair, Scalar, YAMLMap } from "yaml";
import { findPair, yaml } from "./corpus.ts";

export interface RenameReport {
  renamed: number;
  derivedFromValueType: number;
  valueTypesDropped: number;
}

const BASE_TYPES = new Set(["string", "integer", "number", "boolean", "date", "datetime", "object"]);

function isFieldMap(map: YAMLMap): boolean {
  return Boolean(findPair(map, "key")) && Boolean(findPair(map, "semanticType") || findPair(map, "valueType"));
}

function renameField(field: YAMLMap, report: RenameReport): void {
  const semantic = findPair(field, "semanticType");
  const value = findPair(field, "valueType");
  const osf = findPair(field, "osfType");
  if (semantic) {
    (semantic.key as Scalar).value = "osfType";
    report.renamed += 1;
  }
  if (value && (semantic || osf)) {
    field.items.splice(field.items.indexOf(value), 1);
    report.valueTypesDropped += 1;
  } else if (value) {
    const base = String((value.value as Scalar).value);
    if (!BASE_TYPES.has(base)) throw new Error(`field ${String((findPair(field, "key")!.value as Scalar).value)}: valueType ${base} is not a base type.`);
    (value.key as Scalar).value = "osfType";
    report.derivedFromValueType += 1;
    report.valueTypesDropped += 1;
  }
}

export function renameTypeAxis(node: unknown, report: RenameReport): void {
  if (yaml.isMap(node)) {
    const map = node as YAMLMap;
    if (isFieldMap(map)) renameField(map, report);
    // Catalog entries keep `valueType` untouched: they have no `key`, and
    // their base is what the compiler derives a field's baseType from.
    for (const pair of map.items as Pair[]) renameTypeAxis(pair.value, report);
  } else if (yaml.isSeq(node)) {
    for (const item of node.items) renameTypeAxis(item, report);
  }
}
