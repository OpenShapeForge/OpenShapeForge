// SPDX-License-Identifier: BUSL-1.1
/**
 * The mutation controls an authored Operation may carry — secure input,
 * version concurrency, edit leases, confirmation challenges, idempotency —
 * and where each is admissible.
 */
import type { CrudOperationKey, EntityOperationDefinition } from "./types.js";
import type { OperationAuthoringContext } from "./operation-authoring.js";

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

export function assertOperationControls(
  operationKey: string,
  operation: EntityOperationDefinition,
  context: OperationAuthoringContext,
  resolved: { action: CrudOperationKey | undefined; operationKind: string; mutableExistingTarget: boolean },
): void {
  const { entity, origin, fieldsByKey } = context;
  const { action, operationKind, mutableExistingTarget } = resolved;
  const version = operation.concurrency?.version;
  const editLease = operation.concurrency?.editLease;
  const secureInput = operation.interaction;
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
    if (field.baseType !== "datetime" || field.readOnly !== true) {
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
      challengeField.baseType === "object" ||
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
    const operationRoles: string[] | undefined = action
      ? entity.authorization?.roles[action as "update" | "delete"] ?? []
      : operation.auth?.mode === "session"
        ? operation.auth.roles === undefined && operation.auth.roleGroups === undefined
          ? undefined
          : [...new Set([...(operation.auth.roles ?? []), ...(operation.auth.roleGroups?.flat() ?? [])])]
        : [];
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
  if (operation.implementation.type === "entity" &&
    operation.reliability.idempotency.mode === "keyed") {
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
  const expectedIdempotency = action && operation.implementation.type === "entity" &&
      ["list", "get", "delete"].includes(action)
    ? "natural"
    : "none";
  if (action && operation.implementation.type === "entity" &&
    operation.reliability.idempotency.mode !== expectedIdempotency) {
    throw new Error(
      `${origin} operation "${operationKey}" declares ` +
        `idempotency "${operation.reliability.idempotency.mode}", but generated entity ` +
        `action "${action}" currently requires ` +
        `"${expectedIdempotency}" so interface metadata stays truthful.`,
    );
  }
}
