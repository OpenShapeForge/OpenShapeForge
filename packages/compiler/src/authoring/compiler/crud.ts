// SPDX-License-Identifier: BUSL-1.1
/**
 * Common generated-CRUD exposure compiler.
 *
 * The result is the upper bound shared by GraphQL, REST, MCP and workflow.
 * Transport-specific authoring may narrow it, never widen it. Absence keeps
 * the historical all-operations default for existing entities.
 */
import type { CrudConfig, CrudOperationKey, CrudSection } from "../types.js";
import type { LoadedArtifacts } from "../loader.js";

export const CRUD_OPERATION_KEYS: readonly CrudOperationKey[] = [
  "list",
  "get",
  "create",
  "update",
  "delete",
];

export function resolveCrudOperations(
  authored: LoadedArtifacts["coreEntity"]["crud"],
): CrudSection["operations"] {
  if (authored === false) {
    return Object.fromEntries(
      CRUD_OPERATION_KEYS.map((operation) => [operation, false]),
    ) as Record<CrudOperationKey, boolean>;
  }

  const config: CrudConfig = authored === true || authored === undefined ? {} : authored;
  const enabled = config.enabled !== false;
  return Object.fromEntries(
    CRUD_OPERATION_KEYS.map((operation) => [
      operation,
      enabled && config.operations?.[operation] !== false,
    ]),
  ) as Record<CrudOperationKey, boolean>;
}

export function buildCrud(
  coreEntity: LoadedArtifacts["coreEntity"],
): CrudSection {
  return { operations: resolveCrudOperations(coreEntity.crud) };
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
