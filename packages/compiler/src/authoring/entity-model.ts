// SPDX-License-Identifier: BUSL-1.1
/**
 * The authored entity model, read: an entity's canonical Operations by key
 * and by the CRUD intent they implement, the plugin-handled ones, and the
 * per-transport projections (`interfaces.rest|graphql|mcp|web`) each
 * sub-compiler builds its section from.
 */
import type {
  CoreEntity,
  CrudOperationKey,
  EntityOperationDefinition,
  RestConfig,
  UIDefinition,
} from "./types.js";

/** The only authored entity shape: schemaVersion 3, behaviour in operations and interfaces. */
export const CORE_ENTITY_SCHEMA_VERSION = 3;

export function operationEntries(
  entity: CoreEntity,
): Array<[string, EntityOperationDefinition]> {
  return Object.entries(entity.operations ?? {});
}

/** Entity CRUD intent, including a plugin handler that implements that intent. */
export function operationAction(
  definition: EntityOperationDefinition,
): CrudOperationKey | undefined {
  if (definition.implementation.type === "collection") return undefined;
  return definition.implementation.action;
}

export function operationByAction(
  entity: CoreEntity,
): Partial<Record<CrudOperationKey, [string, EntityOperationDefinition]>> {
  const result: Partial<Record<CrudOperationKey, [string, EntityOperationDefinition]>> = {};
  for (const entry of operationEntries(entity)) {
    const action = operationAction(entry[1]);
    if (!action) continue;
    if (result[action]) {
      throw new Error(
        `[${entity.entity}] one generated entity operation per action; ` +
          `both "${result[action]![0]}" and "${entry[0]}" implement "${action}".`,
      );
    }
    result[action] = entry;
  }
  return result;
}

export function pluginOperations(entity: CoreEntity) {
  return operationEntries(entity).flatMap(([key, definition]) => {
    if (definition.implementation.type !== "collection" && (definition.implementation.type !== "plugin" || definition.implementation.action)) return [];
    const projection = (name: "rest" | "graphql" | "mcp" | "web") => {
      const contract = entity.interfaces?.[name];
      if (!contract) return undefined;
      return contract.operations?.[key] ?? {};
    };
    return [{
      key,
      id: definition.id ?? `${entity.entity}.${key}`,
      entityId: `${entity.module}.${entity.entity}`,
      entityName: entity.entity,
      definition,
      interfaces: {
        ...(entity.interfaces?.rest ? { rest: projection("rest") } : {}),
        ...(entity.interfaces?.graphql ? { graphql: projection("graphql") } : {}),
        ...(entity.interfaces?.mcp ? { mcp: projection("mcp") } : {}),
        ...(entity.interfaces?.web?.views ? { web: projection("web") } : {}),
      },
    }];
  });
}

export function projectedActions(
  entity: CoreEntity,
  interfaceName: "rest" | "mcp" | "web" | "graphql",
): Partial<Record<CrudOperationKey, boolean>> {
  const operations = entity.interfaces?.[interfaceName]?.operations ?? {};
  const definitions = entity.operations ?? {};
  const result: Partial<Record<CrudOperationKey, boolean>> = {};
  for (const definition of Object.values(definitions)) {
    const action = operationAction(definition);
    if (!action) continue;
    result[action] = true;
  }
  for (const operationKey of Object.keys(operations)) {
    const definition = definitions[operationKey];
    if (!definition) {
      throw new Error(
        `[${entity.entity}] interfaces.${interfaceName}.operations.${operationKey} ` +
          "does not reference a canonical operation.",
      );
    }
    const action = operationAction(definition);
    if (action) result[action] = operations[operationKey] !== false;
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


export function restConfig(entity: CoreEntity): RestConfig | undefined {
  if (!entity.interfaces?.rest) return undefined;
  return { ...(entity.interfaces.rest.basePath ? { basePath: entity.interfaces.rest.basePath } : {}), operations: completeProjectedActions(entity, "rest") };
}

export function webOperationActions(
  entity: CoreEntity,
): Partial<Record<CrudOperationKey, boolean>> | undefined {
  if (!entity.interfaces?.web?.views) return undefined;
  return projectedActions(entity, "web");
}

export function graphqlOperationActions(
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
export function webUi(entity: CoreEntity): UIDefinition | undefined {
  const web = entity.interfaces?.web;
  if (!web?.views) return undefined;
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
        ...(record.badges?.length ? { badges: record.badges } : {}),
      },
      actions: (record.actions ?? []).map((key) => {
        const implementation = entity.operations![key]!.implementation;
        const action = implementation.action;
        if (!action) return { key, route: key };
        return action === "delete"
          ? { key, mutation: "delete" }
          : { key, route: action === "update" ? "edit" : key };
      }),
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
      presentations.form = { type: "form", variants, ...(record.variableSources ? { variableSources: record.variableSources } : {}) };
    }
  }

  return { routes, presentations };
}

/** The only authored entity shape: schemaVersion 3, behaviour in operations and interfaces. */
