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
    if (entry[1].implementation.type !== "entity") continue;
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

export function v2PluginOperations(entity: CoreEntity) {
  if (!isCoreEntityV2(entity)) return [];
  return v2OperationEntries(entity).flatMap(([key, definition]) => {
    if (definition.implementation.type !== "plugin") return [];
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
        ...(entity.interfaces?.web ? { web: projection("web") } : {}),
      },
    }];
  });
}

function projectedActions(
  entity: CoreEntity,
  interfaceName: "rest" | "mcp" | "web" | "graphql",
): Partial<Record<CrudOperationKey, boolean>> {
  const operations = entity.interfaces?.[interfaceName]?.operations ?? {};
  const definitions = entity.operations ?? {};
  const result: Partial<Record<CrudOperationKey, boolean>> = {};
  for (const definition of Object.values(definitions)) {
    if (definition.implementation.type !== "entity") continue;
    result[definition.implementation.action] = true;
  }
  for (const operationKey of Object.keys(operations)) {
    const definition = definitions[operationKey];
    if (!definition) {
      throw new Error(
        `[${entity.entity}] interfaces.${interfaceName}.operations.${operationKey} ` +
          "does not reference a canonical operation.",
      );
    }
    if (definition.implementation.type === "entity") {
      result[definition.implementation.action] = operations[operationKey] !== false;
    }
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

function fixedDurationSeconds(value: string): number | undefined {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match) return undefined;
  const seconds =
    Number(match[1] ?? 0) * 86_400 +
    Number(match[2] ?? 0) * 3_600 +
    Number(match[3] ?? 0) * 60 +
    Number(match[4] ?? 0);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

const RESERVED_MUTATION_CONTROL_FIELD_KEYS = new Set([
  "expectedVersion",
  "leaseToken",
  "confirmed",
  "confirmationToken",
  "confirmationAnswer",
]);

const WEB_RENDERER_KEY = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export function v2RestConfig(entity: CoreEntity): RestConfig | undefined {
  if (!entity.interfaces?.rest) return undefined;
  return { operations: completeProjectedActions(entity, "rest") };
}

export function v2McpConfig(entity: CoreEntity): McpConfig | undefined {
  const mcp = entity.interfaces?.mcp;
  if (!mcp) return undefined;
  return {
    ...(mcp.tools ? { tools: mcp.tools } : {}),
    operations: completeProjectedActions(entity, "mcp"),
    ...(mcp.resource ? { resource: mcp.resource } : {}),
    ...(() => {
      const secureInput = v2OperationByAction(entity).create?.[1].interaction;
      if (!secureInput) return {};
      const { type: _type, ...elicitOnCreate } = secureInput;
      return { elicitOnCreate };
    })(),
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
      actions: (record.actions ?? []).map((key) => {
        const implementation = entity.operations![key]!.implementation;
        if (implementation.type === "plugin") return { key, route: key };
        const action = implementation.action;
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

  const fieldsByKey = new Map(entity.fields.map((field) => [field.key, field]));
  for (const field of entity.fields) {
    if (RESERVED_MUTATION_CONTROL_FIELD_KEYS.has(field.key)) {
      throw new Error(
        `${origin} schemaVersion 2 field "${field.key}" uses a reserved platform ` +
          "mutation-control name. Rename the entity field so REST and MCP can " +
          "project canonical controls without stripping or reinterpreting entity data.",
      );
    }
  }

  for (const [operationKey, operation] of v2OperationEntries(entity)) {
    const action = operation.implementation.type === "entity"
      ? operation.implementation.action
      : undefined;
    const operationKind = action ?? "plugin";
    const version = operation.concurrency?.version;
    const editLease = operation.concurrency?.editLease;
    const secureInput = operation.interaction;
    const mutableExistingTarget = action === "update" || action === "delete" ||
      (operation.implementation.type === "plugin" &&
        operation.target?.scope === "record" &&
        operation.effects.data !== "read");
    if (operation.prerequisites) {
      if (action !== "create") {
        throw new Error(
          `${origin} operation "${operationKey}" declares prerequisites for ` +
            `operation kind "${operationKind}"; prerequisites are currently ` +
            "supported only on generated entity create Operations.",
        );
      }
      const sourceIds = new Set<string>();
      for (const prerequisite of operation.prerequisites) {
        if (sourceIds.has(prerequisite.operation)) {
          throw new Error(
            `${origin} operation "${operationKey}" repeats prerequisite ` +
              `"${prerequisite.operation}".`,
          );
        }
        sourceIds.add(prerequisite.operation);
      }
    }
    if (operation.implementation.type === "plugin") {
      if (!operation.target || !operation.input || !operation.output ||
        !operation.errors || !operation.auth || !operation.tenancy) {
        throw new Error(
          `${origin} plugin operation "${operationKey}" must declare target, input, ` +
            "output, errors, auth and tenancy.",
        );
      }
      if (operation.target.scope === "record") {
        const properties = operation.input.schema.properties;
        const required = operation.input.schema.required;
        if (!properties || typeof properties !== "object" || Array.isArray(properties) ||
          !(operation.target.inputField in properties) ||
          !Array.isArray(required) || !required.includes(operation.target.inputField)) {
          throw new Error(
            `${origin} plugin operation "${operationKey}" target inputField ` +
              `"${operation.target.inputField}" must be a required input.schema property.`,
          );
        }
      }
      if (
        operation.auth.mode === "session" &&
        operation.auth.recordPermission !== undefined
      ) {
        if (operation.target.scope !== "record") {
          throw new Error(
            `${origin} plugin operation "${operationKey}" recordPermission requires a record target.`,
          );
        }
        if (!entity.authorization?.rowAccess?.recordPermissions) {
          throw new Error(
            `${origin} plugin operation "${operationKey}" declares recordPermission, but the entity has no authorization.rowAccess.recordPermissions policy.`,
          );
        }
      }
      if (operation.interaction) {
        throw new Error(
          `${origin} plugin operation "${operationKey}" cannot declare entity secureInput; ` +
            "a plugin handler must use a server-authored Operation interaction.",
        );
      }
    }
    if (secureInput) {
      if (action !== "create") {
        throw new Error(
          `${origin} operation "${operationKey}" declares secureInput for entity ` +
            `action "${operationKind}"; secure input is currently supported only on create.`,
        );
      }
      for (const [option, fieldKey] of [
        ["sourceField", secureInput.sourceField],
        ["into", secureInput.into],
      ] as const) {
        const field = fieldsByKey.get(fieldKey);
        if (!field) {
          throw new Error(
            `${origin} operation "${operationKey}" secureInput ${option} ` +
              `"${fieldKey}" does not name an authored field.`,
          );
        }
        if (!field.persisted) {
          throw new Error(
            `${origin} operation "${operationKey}" secureInput ${option} ` +
              `"${fieldKey}" must resolve to a persisted runtime column.`,
          );
        }
      }
      if (secureInput.sourceField === secureInput.into) {
        throw new Error(
          `${origin} operation "${operationKey}" secureInput sourceField and into ` +
            "must name different fields.",
        );
      }
      if (!secureInput.sourceEntity || !secureInput.definitionsField) {
        throw new Error(
          `${origin} operation "${operationKey}" secureInput needs sourceEntity and ` +
            "definitionsField naming where the secure field definitions live.",
        );
      }
    }
    if (
      (action === "list" || action === "get" ||
        (operation.implementation.type === "plugin" && operation.effects.data === "read")) &&
      (operation.concurrency || operation.confirmation.mode !== "none")
    ) {
      throw new Error(
        `${origin} operation "${operationKey}" declares concurrency or confirmation ` +
          `for read action "${action}"; read operations cannot require mutation controls.`,
      );
    }
    if (version) {
      if (!mutableExistingTarget) {
        throw new Error(
          `${origin} operation "${operationKey}" declares version concurrency for ` +
            `operation kind "${operationKind}"; version concurrency requires a mutable record target.`,
        );
      }
      if (version.field !== "updatedAt") {
        throw new Error(
          `${origin} operation "${operationKey}" uses concurrency version field ` +
            `"${version.field}"; generated entity operations currently support only ` +
            'the automatically advanced "updatedAt" field.',
        );
      }
      const field = fieldsByKey.get(version.field);
      if (!field) {
        throw new Error(
          `${origin} operation "${operationKey}" uses concurrency version field ` +
            `"${version.field}", but that field does not exist.`,
        );
      }
      if (!field.persisted) {
        throw new Error(
          `${origin} operation "${operationKey}" uses concurrency version field ` +
            `"${version.field}", which must resolve to a persisted runtime column.`,
        );
      }
      if (field.valueType !== "datetime" || field.readOnly !== true) {
        throw new Error(
          `${origin} operation "${operationKey}" uses concurrency version field ` +
            `"${version.field}", which must be a readOnly datetime field.`,
        );
      }
    }
    if (editLease) {
      if (!mutableExistingTarget) {
        throw new Error(
          `${origin} operation "${operationKey}" declares editLease for entity action ` +
            `"${operationKind}"; editLease requires a mutable record target.`,
        );
      }
      if (!version) {
        throw new Error(
          `${origin} operation "${operationKey}" declares editLease without required ` +
            "version concurrency.",
        );
      }
      const inactivitySeconds = fixedDurationSeconds(
        editLease.expiresAfterInactivity,
      );
      if (
        inactivitySeconds === undefined ||
        inactivitySeconds < 30 ||
        inactivitySeconds > 86_400
      ) {
        throw new Error(
          `${origin} operation "${operationKey}" editLease expiresAfterInactivity ` +
            `must be a fixed ISO-8601 duration between PT30S and P1D; received ` +
            `${JSON.stringify(editLease.expiresAfterInactivity)}.`,
        );
      }
    }
    if (operation.confirmation.mode === "challenge") {
      if (!mutableExistingTarget) {
        throw new Error(
          `${origin} operation "${operationKey}" declares a confirmation challenge for ` +
            `operation kind "${operationKind}"; challenges require a mutable record target.`,
        );
      }
      const challengeField = fieldsByKey.get(
        operation.confirmation.challenge.field,
      );
      if (!challengeField) {
        throw new Error(
          `${origin} operation "${operationKey}" confirmation challenge field ` +
            `"${operation.confirmation.challenge.field}" does not exist.`,
        );
      }
      if (!challengeField.persisted) {
        throw new Error(
          `${origin} operation "${operationKey}" confirmation challenge field ` +
            `"${challengeField.key}" must resolve to a persisted runtime column.`,
        );
      }
      const challengeCardinality = challengeField.cardinality;
      if (
        challengeField.valueType === "object" ||
        (challengeCardinality !== undefined && challengeCardinality !== "single") ||
        challengeField.children !== undefined ||
        challengeField.shape !== undefined ||
        challengeField.item !== undefined
      ) {
        throw new Error(
          `${origin} operation "${operationKey}" confirmation challenge field ` +
            `"${challengeField.key}" must be a single scalar field; object and ` +
            "collection values cannot be compared as an exact current-field answer.",
        );
      }
      const operationRoles: string[] | undefined = operation.implementation.type === "plugin"
        ? operation.auth?.mode === "session" ? operation.auth.roles : []
        : entity.authorization?.roles[action as "update" | "delete"] ?? [];
      const entityReadRoles = entity.authorization?.roles.read ?? [];
      const fieldReadRoles = challengeField.authorization?.roles.read ?? [];
      const effectiveReadRoles = fieldReadRoles.length > 0
        ? entityReadRoles.filter((role) => fieldReadRoles.includes(role))
        : entityReadRoles;
      if (operationRoles === undefined) {
        throw new Error(
          `${origin} operation "${operationKey}" uses a current-field confirmation ` +
            "challenge with unrestricted session roles; declare roles so challenge-field read access can be proven.",
        );
      }
      const rolesWithoutChallengeRead = operationRoles.filter(
        (role) => !effectiveReadRoles.includes(role),
      );
      if (rolesWithoutChallengeRead.length > 0) {
        throw new Error(
          `${origin} operation "${operationKey}" exposes confirmation challenge field ` +
            `"${challengeField.key}" to operation role(s) that cannot read it: ` +
            `${rolesWithoutChallengeRead.map((role) => JSON.stringify(role)).join(", ")}. ` +
            "Every operation role must also be present in authorization.roles.read " +
            "and, when declared, the field authorization.roles.read allow-list.",
        );
      }
      if (!version) {
        throw new Error(
          `${origin} operation "${operationKey}" has a target.version-bound challenge ` +
            "without required version concurrency.",
        );
      }
      const challengeSeconds = fixedDurationSeconds(
        operation.confirmation.challenge.expiresAfter,
      );
      if (
        challengeSeconds === undefined ||
        challengeSeconds < 30 ||
        challengeSeconds > 900
      ) {
        throw new Error(
          `${origin} operation "${operationKey}" confirmation challenge expiresAfter ` +
            `must be a fixed ISO-8601 duration between PT30S and PT15M; received ` +
            `${JSON.stringify(operation.confirmation.challenge.expiresAfter)}.`,
        );
      }
    }
    if (
      operation.implementation.type === "entity" &&
      operation.reliability.idempotency.mode === "keyed"
    ) {
      throw new Error(
        `${origin} operation "${operationKey}" declares keyed idempotency. The contract ` +
          "is reserved, but server-side key enforcement must land before it can compile.",
      );
    }
    if (operation.implementation.type === "plugin" &&
      operation.reliability.idempotency.mode === "keyed") {
      const field = operation.reliability.idempotency.inputField;
      const properties = operation.input?.schema.properties;
      const required = operation.input?.schema.required;
      if (!field || !properties || typeof properties !== "object" ||
        Array.isArray(properties) || !(field in properties) ||
        !Array.isArray(required) || !required.includes(field)) {
        throw new Error(
          `${origin} plugin operation "${operationKey}" keyed idempotency inputField ` +
            "must name a required input.schema property.",
        );
      }
    }
    const expectedIdempotency = action && ["list", "get", "delete"].includes(action)
      ? "natural"
      : "none";
    if (action && operation.reliability.idempotency.mode !== expectedIdempotency) {
      throw new Error(
        `${origin} operation "${operationKey}" declares ` +
          `idempotency "${operation.reliability.idempotency.mode}", but generated entity ` +
          `action "${action}" currently requires ` +
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

  const web = entity.interfaces?.web;
  if (web) {
    for (const [scope, renderer] of [
      ["collection", web.views.collection.renderer],
      ["record", web.views.record?.renderer],
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
      ["collection", web.views.collection.actions ?? []],
      ["record", web.views.record?.actions ?? []],
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
          (operation.implementation.type !== "plugin" || operation.target?.scope !== "collection")) {
          throw new Error(
            `${origin} interfaces.web.views.collection.actions operation "${operationKey}" ` +
              "must be a collection-scoped plugin Operation.",
          );
        }
      }
    }
  }
}
