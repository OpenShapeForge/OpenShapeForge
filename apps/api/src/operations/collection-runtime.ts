// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import { withModuleOperationTransaction } from "../modules/platform.js";
import type { ModuleOperationHandler } from "../modules/contract.js";
import { executeCollectionMutationInTransaction, type CollectionMutationBinding, type CollectionMutationRequest } from "./entity/collection-mutations.js";
import type { OperationContract } from "./runtime.js";
import { getGeneratedCrudTables } from "./entity/catalog.js";
import { serializeEntityRow } from "./entity/serialize-result.js";

/** Validate compiler-owned bindings once at boot, never choose them from input. */
export function nativeCollectionBinding(operation: OperationContract): Readonly<CollectionMutationBinding> {
  const binding = operation.implementation;
  if (!binding || binding.type !== "collection" ||
      operation.plugin !== "core" || operation.handler !== "collectionMutation" ||
      !/^[A-Z][A-Za-z0-9]*$/.test(binding.entityName) || !/^[a-z][A-Za-z0-9]*$/.test(binding.field) ||
      !["insert", "move", "update", "remove"].includes(binding.action) || operation.target?.entityName !== binding.entityName ||
      operation.target.scope !== "record" || operation.target.inputField !== "id" ||
      operation.auth.mode !== "session" || !operation.auth.roles?.length || operation.tenancy.mode !== "required" ||
      operation.effects?.data !== "write" || operation.effects.external !== "none" ||
      operation.concurrency?.version?.mode !== "required" || operation.concurrency.version.field !== "updatedAt" ||
      operation.concurrency.editLease || operation.confirmation?.mode !== "none" || operation.idempotency.mode !== "none") {
    throw new Error(`Canonical collection Operation ${operation.key} has an unsupported or incomplete binding.`);
  }
  return Object.freeze({ entityName: binding.entityName, field: binding.field, action: binding.action });
}

/** Uses the same live guarded transaction as other canonical write Operations. */
export function nativeCollectionHandler(operation: OperationContract): ModuleOperationHandler {
  const binding = nativeCollectionBinding(operation);
  return async (input, context) => {
    if (!context.session || !context.platform || !context.db) throw operationFailure({
      code: "UNAUTHENTICATED", message: "Collection changes require a live verified session.",
    });
    const parents = getGeneratedCrudTables().filter((table) => table.source?.authoringEntityName === binding.entityName);
    if (parents.length !== 1) throw operationFailure({ code: "INVALID_DEFINITION", message: "The collection owner has no unambiguous record projection." });
    const value = await withModuleOperationTransaction(context.platform, context.session, async (trx) => {
      const result = await executeCollectionMutationInTransaction(trx, context.session!, binding, input as CollectionMutationRequest);
      return { ...result, parent: serializeEntityRow(parents[0]!, result.parent) };
    });
    return { value };
  };
}
