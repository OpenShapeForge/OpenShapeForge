// SPDX-License-Identifier: BUSL-1.1
/**
 * What one authored Operation must satisfy: its implementation (entity,
 * plugin or collection), prerequisites, and the schemas and targets a plugin
 * handler declares. The mutation controls (secure input, version, edit lease,
 * challenge, idempotency) are checked in operation-controls.ts.
 */
import type { CoreEntity, EntityOperationDefinition } from "./types.js";
import { fieldCardinality } from "./compiler/helpers.js";
import { operationAction } from "./entity-model.js";
import { assertOperationControls } from "./operation-controls.js";

export type OperationAuthoringContext = {
  entity: CoreEntity;
  origin: string;
  fieldsByKey: ReadonlyMap<string, CoreEntity["fields"][number]>;
};

/** Everything an authored Operation must satisfy; a collection Operation has its own, fixed contract. */
export function assertOperationAuthoring(
  operationKey: string,
  operation: EntityOperationDefinition,
  context: OperationAuthoringContext,
): void {
  const { entity, origin, fieldsByKey } = context;
  for (const [inputKey, property] of Object.entries(operation.input?.schema?.properties ?? {})) {
    if (!property || typeof property !== "object" || Array.isArray(property) || !("x-osf-inputFields" in property)) continue;
    const source = (property as Record<string, unknown>)["x-osf-inputFields"];
    const field = typeof source === "string" ? fieldsByKey.get(source) : undefined;
    if (operation.target?.scope !== "record" || !field || field.osfType !== "fieldDefinition" || fieldCardinality(field) !== "collection") {
      throw new Error(`${origin} Operation ${operationKey} input ${inputKey}: x-osf-inputFields must reference a fieldDefinition collection on its target record.`);
    }
  }
  if (operation.implementation.type === "collection") {
    const implementation = operation.implementation;
    if (!["insert", "move", "update", "remove"].includes(implementation.action) ||
      !/^[a-z][A-Za-z0-9]*$/.test(implementation.field) || Object.keys(implementation).some((key) => !["type", "action", "field"].includes(key))) {
      throw new Error(`${origin} ${operationKey}: collection implementation requires field and action insert|move|update|remove.`);
    }
    if (["input", "output", "target", "auth", "tenancy", "errors", "interaction", "prerequisites"].some((key) => Reflect.get(operation, key) !== undefined)) {
      throw new Error(`${origin} ${operationKey}: collection schemas, target, auth and tenancy are compiler-derived; custom controls are unsupported.`);
    }
    if (operation.effects.data !== "write" || operation.effects.external !== "none" || operation.confirmation.mode !== "none" ||
      operation.reliability.idempotency.mode !== "none" || Object.keys(operation.reliability.idempotency).some((key) => key !== "mode") ||
      (operation.concurrency && (operation.concurrency.editLease || operation.concurrency.version?.mode !== "required" || operation.concurrency.version.field !== "updatedAt"))) {
      throw new Error(`${origin} ${operationKey}: collection Operations require write/no external, idempotency none, confirmation none and required updatedAt without leases.`);
    }
    return;
  }
  const action = operationAction(operation);
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
          "supported only on canonical entity create Operations.",
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
      !operation.errors) {
      throw new Error(
        `${origin} plugin operation "${operationKey}" must declare target, input, ` +
          "output and errors.",
      );
    }
    if (action) {
      if (operation.auth || operation.tenancy) {
        throw new Error(
          `${origin} plugin-backed entity ${action} Operation "${operationKey}" ` +
            "derives authorization and tenancy from the entity; remove duplicate auth or tenancy.",
        );
      }
      const expectedScope = action === "create" ? "collection" : "record";
      if (operation.target.scope !== expectedScope) {
        throw new Error(
          `${origin} plugin-backed entity ${action} Operation "${operationKey}" ` +
            `must use a ${expectedScope}-scoped target.`,
        );
      }
      const expectedDataEffect = action === "delete" ? "delete" : "write";
      if (operation.effects.data !== expectedDataEffect) {
        throw new Error(
          `${origin} plugin-backed entity ${action} Operation "${operationKey}" ` +
            `must declare ${expectedDataEffect} data effects.`,
        );
      }
      const inputProperties = operation.input.schema.properties;
      if (!inputProperties || typeof inputProperties !== "object" ||
        Array.isArray(inputProperties)) {
        throw new Error(
          `${origin} plugin-backed entity ${action} Operation "${operationKey}" ` +
            "must use an object input schema with declared properties.",
        );
      }
      const entityFields = new Set(entity.fields.map((field) => field.key));
      for (const [inputKey, inputProperty] of Object.entries(inputProperties)) {
        if (!inputProperty || typeof inputProperty !== "object" ||
          Array.isArray(inputProperty) ||
          !("x-osf-sourceField" in inputProperty)) continue;
        const sourceField = (inputProperty as Record<string, unknown>)["x-osf-sourceField"];
        if (typeof sourceField !== "string" || !entityFields.has(sourceField)) {
          throw new Error(
            `${origin} plugin-backed entity ${action} Operation "${operationKey}" ` +
              `input property "${inputKey}" references unknown entity field ` +
              `"${String(sourceField)}" through x-osf-sourceField.`,
          );
        }
      }
      const outputProperties = operation.output.schema.properties;
      const outputRequired = operation.output.schema.required;
      const outputId = outputProperties && typeof outputProperties === "object" &&
          !Array.isArray(outputProperties)
        ? (outputProperties as Record<string, unknown>).id
        : undefined;
      if (action === "delete") {
        const outputDeleted = outputProperties && typeof outputProperties === "object" &&
            !Array.isArray(outputProperties)
          ? (outputProperties as Record<string, unknown>).deleted
          : undefined;
        if (
          operation.output.schema.type !== "object" ||
          !outputDeleted || typeof outputDeleted !== "object" || Array.isArray(outputDeleted) ||
          (outputDeleted as { type?: unknown }).type !== "boolean" ||
          !Array.isArray(outputRequired) || !outputRequired.includes("deleted")
        ) {
          throw new Error(
            `${origin} plugin-backed entity delete Operation "${operationKey}" ` +
              "must return an object schema with a required boolean deleted result.",
          );
        }
      } else if (
        operation.output.schema.type !== "object" ||
        !outputId || typeof outputId !== "object" || Array.isArray(outputId) ||
        (outputId as { type?: unknown }).type !== "string" ||
        !Array.isArray(outputRequired) || !outputRequired.includes("id")
      ) {
        throw new Error(
          `${origin} plugin-backed entity ${action} Operation "${operationKey}" ` +
            "must return an object schema with a required string id for the canonical entity head.",
        );
      }
    } else if (!operation.auth || !operation.tenancy) {
      throw new Error(
        `${origin} invoke plugin operation "${operationKey}" must declare auth and tenancy.`,
      );
    }

    const restProjection = entity.interfaces?.rest?.operations?.[operationKey];
    if (action && restProjection && restProjection.method) {
      const allowed = action === "create"
        ? ["POST"]
        : action === "delete"
          ? ["DELETE"]
          : ["PATCH", "PUT"];
      if (!allowed.includes(restProjection.method)) {
        throw new Error(
          `${origin} plugin-backed entity ${action} Operation "${operationKey}" ` +
            `cannot project REST method ${restProjection.method}; use ${allowed.join(" or ")}.`,
        );
      }
    }
    if (action && restProjection && restProjection.response?.kind &&
      restProjection.response.kind !== "json") {
      throw new Error(
        `${origin} plugin-backed entity ${action} Operation "${operationKey}" ` +
          "must project a JSON REST response for the canonical entity envelope.",
      );
    }
    if (action && restProjection && restProjection.path) {
      const parameters = [...restProjection.path.matchAll(
        /:([_A-Za-z][_0-9A-Za-z]*)/g,
      )].map((match) => match[1]!);
      if (action === "create" && parameters.length > 0) {
        throw new Error(
          `${origin} plugin-backed entity create Operation "${operationKey}" ` +
            "cannot bind record parameters in its collection REST path.",
        );
      }
      const recordInputField = operation.target.scope === "record"
        ? operation.target.inputField
        : undefined;
      if ((action === "update" || action === "delete") &&
        (recordInputField === undefined || parameters.length !== 1 ||
          parameters[0] !== recordInputField)) {
        throw new Error(
          `${origin} plugin-backed entity ${action} Operation "${operationKey}" ` +
            `REST path must bind exactly :${recordInputField ?? "recordId"}.`,
        );
      }
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
    const operationAuth = operation.auth;
    if (!action &&
      operationAuth?.mode === "session" &&
      operationAuth.recordPermission !== undefined
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
  assertOperationControls(operationKey, operation, context, { action, operationKind, mutableExistingTarget });
}
