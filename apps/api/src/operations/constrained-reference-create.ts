// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import { withModuleOperationTransaction } from "../modules/platform.js";
import type { ModuleOperationHandler } from "../modules/contract.js";
import { getGeneratedCrudTables, requireEntityOperation } from "./entity/catalog.js";
import { createGeneratedEntityInTransaction } from "./entity/mutations.js";
import { fieldNameForColumn } from "./entity/columns.js";
import { serializeEntityRow } from "./entity/serialize-result.js";
import type { OperationContract } from "./runtime.js";

type Binding = Extract<NonNullable<OperationContract["implementation"]>, { type: "constrained-reference-create" }>;

function oneTable(entityName: string) {
  const tables = getGeneratedCrudTables().filter(table => table.source?.authoringEntityName === entityName);
  if (tables.length !== 1) throw operationFailure({ code: "INVALID_DEFINITION", message: `Entity ${entityName} has no unambiguous record projection.` });
  return tables[0]!;
}

export async function createConstrainedReferenceInTransaction(
  trx: Parameters<typeof createGeneratedEntityInTransaction>[0],
  session: Parameters<typeof createGeneratedEntityInTransaction>[1],
  binding: Binding,
  target: ReturnType<typeof oneTable>,
  child: ReturnType<typeof oneTable>,
  values: Record<string, unknown>,
) {
  const targetRow = await createGeneratedEntityInTransaction(trx, session, target, {
    ...values,
    ...binding.targetValues,
  });
  const idColumn = target.columns.find(column => column.name === target.primaryKey);
  const idField = idColumn ? fieldNameForColumn(idColumn) : "id";
  const id = targetRow[idField] ?? targetRow[target.primaryKey!];
  if (typeof id !== "string") throw operationFailure({ code: "INTERNAL_SERVER_ERROR", message: "Created reference has no canonical id." });
  await createGeneratedEntityInTransaction(trx, session, child, {
    ...binding.childValues,
    [binding.parentField]: id,
  });
  return targetRow;
}

/** Validate compiler-owned compound-create metadata once; callers can never choose these bindings. */
export function nativeConstrainedReferenceCreateBinding(operation: OperationContract): Readonly<Binding> {
  const binding = operation.implementation;
  if (!binding || binding.type !== "constrained-reference-create" || operation.plugin !== "core" ||
      operation.handler !== "constrainedReferenceCreate" || operation.target?.scope !== "collection" ||
      operation.target.entityName !== binding.targetEntityName || operation.auth.mode !== "session" ||
      operation.tenancy.mode !== "required" || operation.effects?.data !== "write" || operation.effects.external !== "none" ||
      operation.confirmation?.mode !== "none" || operation.idempotency.mode !== "none") {
    throw new Error(`Canonical constrained reference create Operation ${operation.key} has an unsupported or incomplete binding.`);
  }
  return Object.freeze(binding);
}

/** Create the referenced record and its required collection child in one core-owned transaction. */
export function nativeConstrainedReferenceCreateHandler(operation: OperationContract): ModuleOperationHandler {
  const binding = nativeConstrainedReferenceCreateBinding(operation);
  return async (input, context) => {
    if (!context.session || !context.platform || !context.db) throw operationFailure({
      code: "UNAUTHENTICATED", message: "Constrained reference creation requires a live verified session.",
    });
    const target = oneTable(binding.targetEntityName);
    const child = oneTable(binding.collectionEntityName);
    requireEntityOperation(target, "create", context.session);
    requireEntityOperation(child, "create", context.session);
    const values = input.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) throw operationFailure({ code: "VALIDATION", message: "Reference values are required." });
    const created = await withModuleOperationTransaction(context.platform, context.session, trx =>
      createConstrainedReferenceInTransaction(trx, context.session!, binding, target, child, values as Record<string, unknown>));
    return { value: serializeEntityRow(target, created) };
  };
}
