// SPDX-License-Identifier: BUSL-1.1
import type {
  CoreEntity,
  CrudOperationKey,
  EntityOperationDefinition,
  McpConfig,
  RestConfig,
  UIDefinition,
} from "./types.js";

export function isCoreEntityV2(entity: CoreEntity): boolean {
  return entity.schemaVersion === 2;
}

export function v2OperationEntries(
  entity: CoreEntity,
): Array<[string, EntityOperationDefinition]> {
  return Object.entries(entity.operations ?? {});
}

export function v2OperationByAction(
  entity: CoreEntity,
): Partial<Record<CrudOperationKey, [string, EntityOperationDefinition]>> {
  const result: Partial<Record<CrudOperationKey, [string, EntityOperationDefinition]>> = {};
  for (const entry of v2OperationEntries(entity)) {
    const action = entry[1].implementation.action;
    if (result[action]) {
      throw new Error(
        `[${entity.entity}] schemaVersion 2 currently supports one generated entity operation per action; ` +
          `both "${result[action]![0]}" and "${entry[0]}" implement "${action}".`,
      );
    }
    result[action] = entry;
  }
  return result;
}

function projectedActions(
  entity: CoreEntity,
  interfaceName: "rest" | "mcp" | "web" | "graphql",
): Partial<Record<CrudOperationKey, boolean>> {
  const operations = entity.interfaces?.[interfaceName]?.operations ?? {};
  const definitions = entity.operations ?? {};
  const result: Partial<Record<CrudOperationKey, boolean>> = {};
  for (const operationKey of Object.keys(operations)) {
    const definition = definitions[operationKey];
    if (!definition) {
      throw new Error(
        `[${entity.entity}] interfaces.${interfaceName}.operations.${operationKey} ` +
          "does not reference a canonical operation.",
      );
    }
    result[definition.implementation.action] = true;
  }
  return result;
}

function completeProjectedActions(
  entity: CoreEntity,
  interfaceName: "rest" | "mcp" | "web" | "graphql",
): Record<CrudOperationKey, boolean> {
  const projected = projectedActions(entity, interfaceName);
  return Object.fromEntries(
    (["list", "get", "create", "update", "delete"] as const).map((action) => [
      action,
      projected[action] === true,
    ]),
  ) as Record<CrudOperationKey, boolean>;
}

export function v2RestConfig(entity: CoreEntity): RestConfig | undefined {
  if (!entity.interfaces?.rest) return undefined;
  return { operations: completeProjectedActions(entity, "rest") };
}

export function v2McpConfig(entity: CoreEntity): McpConfig | undefined {
  const mcp = entity.interfaces?.mcp;
  if (!mcp) return undefined;
  return {
    operations: completeProjectedActions(entity, "mcp"),
    ...(mcp.resource ? { resource: mcp.resource } : {}),
  };
}

export function v2WebOperationActions(
  entity: CoreEntity,
): Partial<Record<CrudOperationKey, boolean>> | undefined {
  if (!entity.interfaces?.web) return undefined;
  return projectedActions(entity, "web");
}

export function v2GraphqlOperationActions(
  entity: CoreEntity,
): Record<CrudOperationKey, boolean> {
  return entity.interfaces?.graphql
    ? completeProjectedActions(entity, "graphql")
    : { list: false, get: false, create: false, update: false, delete: false };
}

/**
 * Lower the v2 web layout into the existing compiler view IR. This is a
 * one-way compiler lowering, not a compatibility fallback: v2 YAML cannot
 * contain `ui`, and the generated WebManifest stays the public output.
 */
export function v2WebUi(entity: CoreEntity): UIDefinition | undefined {
  const web = entity.interfaces?.web;
  if (!web) return undefined;
  const collection = web.views.collection;
  const record = web.views.record;
  const presentations: NonNullable<UIDefinition["presentations"]> = {
    list: {
      type: "list",
      columns: collection.columns,
      ...(collection.title ? { title: collection.title } : {}),
      ...(collection.defaultSort ? { defaultSort: collection.defaultSort } : {}),
    },
  };
  const routes: NonNullable<UIDefinition["routes"]> = {
    list: collection.route,
  };

  if (record) {
    if (record.routes?.read) routes.detail = record.routes.read;
    if (record.routes?.create) routes.create = record.routes.create;
    presentations.detail = {
      type: "detail",
      header: {
        title: record.title,
        ...(record.subtitle ? { subtitle: record.subtitle } : {}),
      },
      actions: (record.actions ?? []).map((key) =>
        key === "delete"
          ? { key, mutation: "delete" }
          : { key, route: key },
      ),
      groups: record.layout.tabs,
    };
    const variants: Record<string, { title: import("./types.js").LocalizedText; groups?: import("./types.js").ViewGroup[]; extends?: string }> = {};
    if (record.modes?.create) {
      variants.create = {
        title: record.modes.create.title,
        groups: record.modes.create.groups,
      };
    }
    if (record.modes?.update) {
      variants.edit = {
        title: record.modes.update.title,
        ...(record.modes.update.groups
          ? { groups: record.modes.update.groups }
          : { extends: "create" }),
      };
    }
    if (Object.keys(variants).length > 0) {
      presentations.form = { type: "form", variants };
    }
  }

  return { routes, presentations };
}

export function assertV2Authoring(entity: CoreEntity, origin: string): void {
  if (!isCoreEntityV2(entity)) return;
  if (!entity.operations || Object.keys(entity.operations).length === 0) {
    throw new Error(`${origin} schemaVersion 2 must declare at least one operation.`);
  }
  v2OperationByAction(entity);

  for (const [operationKey, operation] of v2OperationEntries(entity)) {
    if (operation.confirmation.mode !== "none") {
      throw new Error(
        `${origin} operation "${operationKey}" declares confirmation mode ` +
          `"${operation.confirmation.mode}". The contract is reserved, but runtime ` +
          "enforcement must land before this mode can compile.",
      );
    }
    if (operation.reliability.idempotency.mode === "keyed") {
      throw new Error(
        `${origin} operation "${operationKey}" declares keyed idempotency. The contract ` +
          "is reserved, but server-side key enforcement must land before it can compile.",
      );
    }
    const expectedIdempotency = ["list", "get", "delete"].includes(
      operation.implementation.action,
    )
      ? "natural"
      : "none";
    if (operation.reliability.idempotency.mode !== expectedIdempotency) {
      throw new Error(
        `${origin} operation "${operationKey}" declares ` +
          `idempotency "${operation.reliability.idempotency.mode}", but generated entity ` +
          `action "${operation.implementation.action}" currently requires ` +
          `"${expectedIdempotency}" so interface metadata stays truthful.`,
      );
    }
  }

  const visitFields = (fields: readonly CoreEntity["fields"][number][]) => {
    for (const field of fields) {
      if (field.render !== undefined) {
        throw new Error(
          `${origin} schemaVersion 2 field "${field.key}" declares render. ` +
            "Field presentation belongs to an interface or renderer registry.",
        );
      }
      visitFields(field.children ?? []);
      visitFields(field.shape ?? []);
      if (field.item) visitFields([field.item]);
    }
  };
  visitFields(entity.fields);

  for (const interfaceName of ["rest", "graphql", "mcp", "web"] as const) {
    if (entity.interfaces?.[interfaceName]) projectedActions(entity, interfaceName);
  }
}
