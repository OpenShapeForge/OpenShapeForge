// SPDX-License-Identifier: BUSL-1.1
/**
 * Common generated-CRUD exposure compiler.
 *
 * An entity exposes exactly the CRUD intents its canonical Operations
 * implement. The result is the upper bound shared by GraphQL, REST, MCP and
 * workflow; transport-specific interfaces may narrow it, never widen it.
 */
import type { CrudOperationKey, CrudSection } from "../types.js";
import type { LoadedArtifacts } from "../loader.js";
import { operationByAction } from "../entity-model.js";

export const CRUD_OPERATION_KEYS: readonly CrudOperationKey[] = [
  "list",
  "get",
  "create",
  "update",
  "delete",
];

export function buildCrud(
  coreEntity: LoadedArtifacts["coreEntity"],
): CrudSection {
  const operations = operationByAction(coreEntity);
  return {
    operations: Object.fromEntries(
      CRUD_OPERATION_KEYS.map((operation) => [operation, Boolean(operations[operation])]),
    ) as Record<CrudOperationKey, boolean>,
  };
}

export function limitCrudOperations<T extends CrudOperationKey>(
  requested: Record<T, boolean>,
  policy: CrudSection,
): Record<T, boolean> {
  return Object.fromEntries(
    Object.entries(requested).map(([operation, enabled]) => [
      operation,
      enabled === true && policy.operations[operation as CrudOperationKey] === true,
    ]),
  ) as Record<T, boolean>;
}
