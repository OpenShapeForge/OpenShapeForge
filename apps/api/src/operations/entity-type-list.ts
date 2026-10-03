// SPDX-License-Identifier: BUSL-1.1
import { OperationFailure, operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationHandler } from "../modules/contract.js";
import type { DbSessionInput } from "../db/session.js";
import { getGeneratedCrudTables, isGeneratedCrudOperationEnabled, requireEntityOperation } from "./entity/catalog.js";
import type { OperationContract } from "./runtime.js";

export type EntityTypeListInput = { locale?: "en" | "nl"; search?: string; first?: number; after?: string };

/** Read grants come from the same server-owned catalog and gate as record reads. */
export function listReadableEntityTypes(session: DbSessionInput, input: EntityTypeListInput, labels: Record<string, { en: string; nl: string }> = {}) {
  const first = input.first ?? 25;
  if (!Number.isInteger(first) || first < 1 || first > 100) throw operationFailure({
    code: "INVALID_INPUT", message: "Page size must be between 1 and 100.",
  });
  const search = (input.search ?? "").trim().toLocaleLowerCase();
  const visible = getGeneratedCrudTables().flatMap((table) => {
    const name = table.source?.authoringEntityName;
    if (!name) return [];
    const operation = isGeneratedCrudOperationEnabled(table, "list") ? "list" : "get";
    try { requireEntityOperation(table, operation, session); }
    catch (error) {
      if (error instanceof OperationFailure && ["FORBIDDEN", "GENERATED_CRUD_OPERATION_NOT_ENABLED"].includes(error.operationError.code)) return [];
      throw error;
    }
    return [{ value: name, label: labels[name]?.[input.locale ?? "en"] ?? name }];
  });
  const rows = [...new Map(visible.map((item) => [item.value, item])).values()]
    .filter((item) => item.label.toLocaleLowerCase().includes(search) || item.value.toLocaleLowerCase().includes(search))
    .sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : 0)
    .filter((item) => !input.after || item.value > input.after);
  const items = rows.slice(0, first);
  return { items, pageInfo: { hasNextPage: rows.length > first, endCursor: items.at(-1)?.value ?? null } };
}

export function nativeEntityTypeListHandler(operation: OperationContract): ModuleOperationHandler {
  if (operation.key !== "entityTypes.list" || operation.plugin !== "core" ||
      operation.handler !== "listEntityTypes" || operation.implementation?.type !== "entity-type-list" ||
      operation.auth.mode !== "session" || operation.tenancy.mode !== "required" ||
      operation.effects?.data !== "read" || operation.effects.external !== "none") {
    throw new Error(`Canonical entity type list Operation ${operation.key} has an invalid binding.`);
  }
  const labels = operation.implementation.labels;
  return async (input, context) => {
    if (!context.session) throw operationFailure({ code: "UNAUTHENTICATED", message: "Entity types require a verified session." });
    return { value: listReadableEntityTypes(context.session, input as EntityTypeListInput, labels) };
  };
}
