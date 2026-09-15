// SPDX-License-Identifier: BUSL-1.1
import type { CoreEntity, CompiledField, CompiledColumn, CompiledBlueprint } from "../types.js";

const RESERVED = new Set([
  "id", "tenantid", "externalid", "createdat", "updatedat", "deletedat",
  "createdby", "updatedby", "permissions", "recordpermissions", "ownerid",
  "sourceauthority", "sourceorganization", "sourceadministration",
]);

/** Only explicit, writable scalar content crosses the blueprint boundary. */
export function buildBlueprint(
  entity: CoreEntity,
  fields: CompiledField[],
  columns: CompiledColumn[],
): CompiledBlueprint | undefined {
  if (!entity.blueprint) return undefined;
  const keys = entity.blueprint.fields;
  if (!keys.length || new Set(keys).size !== keys.length) {
    throw new Error(`[${entity.entity}] blueprint.fields must be nonempty and unique.`);
  }
  for (const key of keys) {
    const field = fields.find((entry) => entry.key === key);
    const column = columns.find((entry) => entry.field === key);
    const normalized = (value: string) => value.replaceAll("_", "").toLowerCase();
    const protectedName = (value: string) => RESERVED.has(normalized(value)) || /password|secret|token|credential/i.test(value);
    const row = entity.authorization?.rowAccess;
    const protectedColumn = column && [row?.owner?.column, row?.group?.column].includes(column.column);
    if (!field || !column || protectedName(key) || protectedName(column.column) ||
        protectedColumn || row?.recordPermissions?.field === key ||
        field.cardinality !== "single" || field.valueType === "object" || column.type === "uuid" ||
        field.relationship || field.localized || field.computed || field.readOnly || field.immutable ||
        (field.semanticType && /password|secret|token|credential/i.test(field.semanticType)) ||
        field.writtenBy?.length || field.authorization || field.permissions ||
        (field.classification && field.classification.sensitivity !== "public")) {
      throw new Error(`[${entity.entity}] blueprint field "${key}" must be a writable, unclassified persisted scalar without identity, relationship, or authorization semantics.`);
    }
  }
  const labelField = entity.filterField ?? keys[0]!;
  if (!keys.includes(labelField) || fields.find((field) => field.key === labelField)?.valueType !== "string") {
    throw new Error(`[${entity.entity}] blueprint label field must be a copied string field.`);
  }
  const id = `osf-blueprints.${entity.entity}`;
  return {
    fields: [...keys], labelField,
    operations: { list: `${id}.list`, status: `${id}.status`, reset: `${id}.reset`, publish: `${id}.publish` },
  };
}
