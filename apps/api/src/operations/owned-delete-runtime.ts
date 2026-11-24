// SPDX-License-Identifier: BUSL-1.1
import type { ModuleOperationHandler } from "../modules/contract.js";
import { withModuleOperationTransaction } from "../modules/platform.js";
import { assertOperationAdmitted, withOwnedExecutionAdmission } from "./execution-policy.js";
import { executeOwnedDeleteGraph, refuseOwnedDelete } from "./owned-delete-execution.js";
import type { OperationContract } from "./runtime.js";

function refuse(): never {
  refuseOwnedDelete();
}

export function nativeOwnedDeleteHandler(operation: OperationContract): ModuleOperationHandler {
  const binding = operation.implementation;
  if (binding?.type !== "ownedDelete" || operation.plugin !== "core" || operation.handler !== "ownedDelete" ||
      operation.target?.scope !== "record" || operation.target.inputField !== "id" ||
      operation.target.entityName !== binding.plan.root || operation.auth.mode !== "session" ||
      operation.tenancy.mode !== "required" || operation.confirmation?.mode !== "acknowledgement" ||
      operation.effects?.data !== "delete" || operation.effects.external !== "none") {
    throw new Error(`Canonical owned delete Operation ${operation.key} has an invalid binding.`);
  }
  const { plan } = binding;
  return async (input, context) => {
    const session = context.session;
    const tenant = session?.tenantId;
    if (!session || !tenant || !session.userId || !context.db || typeof input.id !== "string") refuse();
    const rootId = input.id;
    const database = context.db;
    return withModuleOperationTransaction(context.platform, session, async (trx) => {
      const admit = () => assertOperationAdmitted(database, session, {
        id: operation.key, intent: "invoke", effects: operation.effects,
      });
      return withOwnedExecutionAdmission(trx, session, admit, async () => {
        const counts = await executeOwnedDeleteGraph(trx, session, plan, tenant, rootId, {
          operationKey: operation.key, lifecycle: "draft-only",
        });
        return { value: { id: rootId, ...Object.fromEntries(Object.entries(plan.resultCounts).map(([key, entity]) => [key, counts[entity]])) } };
      });
    });
  };
}
