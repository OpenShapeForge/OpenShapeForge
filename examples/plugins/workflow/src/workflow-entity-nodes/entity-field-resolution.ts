// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
import type { CoreEntity, Field } from "../../../../../packages/compiler/src/authoring/types.js";
import { resolveCrudOperations } from "../../../../../packages/compiler/src/authoring/compiler/crud.js";
import type { WorkflowActionConfig, WorkflowActionEntry } from "./types.js";
import { ACTION_ORDER } from "./types.js";
import { cloneWorkflowField, filterWorkflowHiddenFields } from "./utils.js";

export function resolveFieldSubset(
  fields: Field[],
  keys: string[] | undefined,
  fallback: Field[],
) {
  if (!keys || keys.length === 0) {
    return filterWorkflowHiddenFields(fallback).map(cloneWorkflowField);
  }

  const fieldMap = new Map(fields.map((field) => [field.key, field]));
  return keys
    .map((key) => fieldMap.get(key))
    .filter((field): field is Field => Boolean(field))
    .filter((field) => !isWorkflowHiddenField(field))
    .map(cloneWorkflowField);
}
export function normalizeActionConfig(
  config: WorkflowActionConfig | undefined,
): Exclude<WorkflowActionConfig, boolean> | null {
  if (config == null || config === false) {
    return null;
  }

  if (config === true) {
    return { enabled: true };
  }

  if (config.enabled === false) {
    return null;
  }

  return {
    enabled: config.enabled ?? true,
    readableFields: config.readableFields,
    writableFields: config.writableFields,
    defaultSort: config.defaultSort,
  };
}

export function getEntityActionConfigs(entity: CoreEntity) {
  const actionConfigMap = entity.workflow?.nodes?.actions;
  if (!actionConfigMap) {
    return [];
  }

  const crudOperations = resolveCrudOperations(entity.crud);
  const actionCrudOperation = {
    create: "create",
    getOne: "get",
    list: "list",
    update: "update",
    delete: "delete",
  } as const;
  const enabledActions: WorkflowActionEntry[] = ACTION_ORDER.flatMap((action) => {
    if (!crudOperations[actionCrudOperation[action]]) {
      return [];
    }
    const config = normalizeActionConfig(actionConfigMap[action]);
    if (!config?.enabled) {
      return [];
    }

    return [{ action, config }];
  });

  const waitConfig = normalizeActionConfig(actionConfigMap.wait);
  if (waitConfig?.enabled && crudOperations.get) {
    enabledActions.push({
      action: "wait",
      config: waitConfig,
    });
  }

  const awaitActionConfig = normalizeActionConfig(actionConfigMap.awaitAction);
  if (awaitActionConfig?.enabled && crudOperations.get) {
    enabledActions.push({
      action: "awaitAction",
      config: awaitActionConfig,
    });
  }

  return enabledActions;
}
