// SPDX-License-Identifier: BUSL-1.1
/**
 * The authoring rules of a schemaVersion 3 entity, checked once at load:
 * the version, at least one Operation, explicit interfaces, no reserved or
 * presentational field keys, every Operation's own rules, and the web
 * interface's references and renderer keys.
 */
import type { CoreEntity } from "./types.js";
import { CORE_ENTITY_SCHEMA_VERSION, operationByAction, operationEntries, projectedActions } from "./entity-model.js";
import { assertOperationAuthoring } from "./operation-authoring.js";

const RESERVED_MUTATION_CONTROL_FIELD_KEYS = new Set([
  "expectedVersion",
  "leaseToken",
  "confirmed",
  "confirmationToken",
  "confirmationAnswer",
]);

const WEB_RENDERER_KEY = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export function assertEntityAuthoring(entity: CoreEntity, origin: string): void {
  if (entity.schemaVersion !== CORE_ENTITY_SCHEMA_VERSION) {
    throw new Error(`${origin} must be schemaVersion ${CORE_ENTITY_SCHEMA_VERSION}; there is no migration path from an older authoring shape.`);
  }
  if (!entity.operations || (Object.keys(entity.operations).length === 0 &&
    entity.baseEntity === false && !entity.fields.some(field => field.key === "id"))) {
    throw new Error(`${origin} must declare at least one operation.`);
  }
  operationByAction(entity);
  if (!entity.interfaces) {
    throw new Error(`${origin} requires explicit interface declarations.`);
  }
  if (entity.hardDelete?.requireNeverPublished && !entity.versioning) {
    throw new Error(`${origin} hardDelete.requireNeverPublished requires durable publishedSnapshot versioning.`);
  }

  const fieldsByKey = new Map(entity.fields.map((field) => [field.key, field]));
  for (const field of entity.fields) {
    if (RESERVED_MUTATION_CONTROL_FIELD_KEYS.has(field.key)) {
      throw new Error(
        `${origin} field "${field.key}" uses a reserved platform ` +
          "mutation-control name. Rename the entity field so REST and MCP can " +
          "project canonical controls without stripping or reinterpreting entity data.",
      );
    }
  }


  for (const [operationKey, operation] of operationEntries(entity)) {
    assertOperationAuthoring(operationKey, operation, { entity, origin, fieldsByKey });
  }

  const visitFields = (fields: readonly CoreEntity["fields"][number][]) => {
    for (const field of fields) {
      if (field.render !== undefined) {
        throw new Error(
          `${origin} field "${field.key}" declares render. ` +
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

  const web = entity.interfaces?.web;
  if (web) {
    const variableSources = web.views?.record?.variableSources ?? [];
    if (new Set(variableSources.map(source => source.key)).size !== variableSources.length) throw new Error(`${origin} duplicate Web variable source key.`);
    for (const source of variableSources) {
      if (source.params?.sourceField && !fieldsByKey.has(String(source.params.sourceField))) throw new Error(`${origin} Web variable source ${source.key} references unknown sourceField.`);
    }
    const paths = new Set<string>();
    const visitPaths = (fields: readonly CoreEntity["fields"][number][], parent = "") => {
      for (const field of fields) {
        const path = parent ? `${parent}.${field.key}` : field.key;
        paths.add(path);
        visitPaths(field.children ?? field.shape ?? [], path);
        if (field.item) visitPaths([field.item], path);
      }
    };
    visitPaths(entity.fields);
    for (const key of Object.keys(web.fields ?? {})) {
      if (!paths.has(key)) throw new Error(`${origin} Web presentation refers to unknown field ${key}.`);
    }
    for (const key of web.views?.record?.badges ?? []) {
      if (!fieldsByKey.has(key)) throw new Error(`${origin} badge refers to unknown field ${key}.`);
    }
    for (const [scope, renderer] of [
      ["collection", web.views?.collection.renderer],
      ["record", web.views?.record?.renderer],
    ] as const) {
      if (renderer !== undefined &&
        (renderer.length > 128 || !WEB_RENDERER_KEY.test(renderer))) {
        throw new Error(
          `${origin} interfaces.web.views.${scope}.renderer must be a non-empty ` +
            "opaque registry key of at most 128 lowercase letters, digits, dots, underscores or hyphens.",
        );
      }
    }
    const actionLists = [
      ["collection", web.views?.collection.actions ?? []],
      ["record", web.views?.record?.actions ?? []],
    ] as const;
    for (const [scope, operationKeys] of actionLists) {
      for (const operationKey of operationKeys) {
        const operation = entity.operations[operationKey];
        if (!operation) {
          throw new Error(
            `${origin} interfaces.web.views.${scope}.actions references unknown operation ` +
              `"${operationKey}".`,
          );
        }
        if (web.operations?.[operationKey] === false) {
          throw new Error(
            `${origin} interfaces.web.views.${scope}.actions operation "${operationKey}" ` +
              "must also be projected by interfaces.web.operations.",
          );
        }
        if (scope === "collection" &&
          (operation.implementation.type !== "plugin" || operation.implementation.action ||
            operation.target?.scope !== "collection")) {
          throw new Error(
            `${origin} interfaces.web.views.collection.actions operation "${operationKey}" ` +
              "must be a collection-scoped plugin Operation.",
          );
        }
      }
    }
  }
}
