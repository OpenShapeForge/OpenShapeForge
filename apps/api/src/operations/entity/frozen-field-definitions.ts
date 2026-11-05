// SPDX-License-Identifier: BUSL-1.1
import { operationErrorOf } from "@openshapeforge/operations";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { DbSessionInput } from "../../db/session.js";
import { getGeneratedCrudTables, requireEntityOperation } from "./catalog.js";
import { entityValueCarriers } from "./entity-value-io.js";
import { fieldNameForColumn } from "./columns.js";
import { canReadClassifiedColumns } from "./classification.js";
import { columnFieldPolicy, hasUnreadableField } from "./field-policy.js";
import { assertRecordPermission } from "./record-permissions.js";
import { getGeneratedEntity } from "./queries.js";
import type { GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export function projectFrozenDefinitionFields(head: GeneratedCrudTable, tree: Record<string, unknown>, bindings: ReadonlyMap<string, string>, session: DbSessionInput): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {};
  for (const [field, columnName] of bindings) {
    const column = head.columns.find(item => item.name === columnName && fieldNameForColumn(item) === field);
    if (!column || hasUnreadableField(columnFieldPolicy(column), session, canReadClassifiedColumns(head.source?.authorization, session)) || !Object.hasOwn(tree, columnName)) continue;
    const value = tree[columnName];
    if (value === null) result[field] = [];
    else if (Array.isArray(value) && value.every(object)) result[field] = value;
  }
  return result;
}

type Dependencies = {
  tables: typeof getGeneratedCrudTables;
  carriers: typeof entityValueCarriers;
  requireRead: typeof requireEntityOperation;
  recordPermission: typeof assertRecordPermission;
  read: typeof getGeneratedEntity;
};
const dependencies: Dependencies = { tables: getGeneratedCrudTables, carriers: entityValueCarriers, requireRead: requireEntityOperation, recordPermission: assertRecordPermission, read: getGeneratedEntity };

/** Version.get exposes logical field definitions; immutable snapshot bytes and hash are untouched. */
export async function withFrozenFieldDefinitions(db: OpenShapeForgeDatabase, session: DbSessionInput, version: GeneratedCrudTable, data: GeneratedEntityRow, deps: Dependencies = dependencies): Promise<GeneratedEntityRow> {
  const tables = deps.tables();
  const versionName = version.source?.authoringEntityName;
  const heads = tables.filter(table => table.source?.versioning?.versionEntity === versionName);
  if (heads.length !== 1) return data;
  const head = heads[0]!;
  const bindings = new Map<string, string>();
  for (const table of tables) for (const carrier of deps.carriers(table)) for (const definition of Object.values(carrier.definitions)) for (const field of definition.fields) {
    const source = field.valueFieldsFrom;
    if (!object(source) || source.headEntity !== head.source?.authoringEntityName || typeof source.field !== "string" || typeof source.snapshotColumn !== "string" || typeof source.reference !== "string") continue;
    if (!definition.references.some(reference => reference.fieldKey === source.reference && reference.targetEntity === versionName)) continue;
    if (bindings.has(source.field) && bindings.get(source.field) !== source.snapshotColumn) throw new Error("Ambiguous frozen field definition mapping.");
    bindings.set(source.field, source.snapshotColumn);
  }
  if (!bindings.size) return data;
  const snapshotColumn = version.columns.find(column => fieldNameForColumn(column) === "snapshot");
  const snapshot = snapshotColumn ? data[snapshotColumn.name] : undefined;
  const tree = object(snapshot) && snapshot.schemaVersion === 1 && snapshot.entity === head.source?.authoringEntityName && object(snapshot.head) && object(snapshot.head.row) ? snapshot.head.row : undefined;
  if (!tree || typeof tree.id !== "string") return data;
  try {
    deps.requireRead(head, "get", session);
    if (head.source?.authorization?.recordPermissions) await deps.recordPermission(db, session, head, tree.id, "view");
    if (!await deps.read(db, session, { table: head.name, id: tree.id })) return data;
  } catch (error) {
    if (["FORBIDDEN", "NOT_FOUND", "GENERATED_CRUD_OPERATION_NOT_ENABLED"].includes(operationErrorOf(error)?.code ?? "")) return data;
    throw error;
  }
  return { ...data, frozenFieldDefinitions: projectFrozenDefinitionFields(head, tree, bindings, session) };
}
