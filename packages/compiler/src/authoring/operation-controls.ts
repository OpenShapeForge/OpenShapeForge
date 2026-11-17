// SPDX-License-Identifier: BUSL-1.1
/**
 * The mutation controls an authored Operation may carry — secure input,
 * version concurrency, edit leases, confirmation challenges, idempotency —
 * and where each is admissible.
 */
import type { CrudOperationKey, EntityOperationDefinition } from "./types.js";
import type { OperationAuthoringContext } from "./operation-authoring.js";
import { fieldCardinality } from "./compiler/helpers.js";
import { operationByAction } from "./entity-model.js";

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
    const fail = (message: string): never => {
      throw new Error(`${origin} operation "${operationKey}" ${message}`);
    };
    const sourced = secureInput.sourceField !== undefined || secureInput.sourceEntity !== undefined ||
      secureInput.definitionsField !== undefined;
    const createInteraction = operationByAction(entity).create?.[1].interaction;
    if (action === "update") {
      // Rotation re-collects the static create fields; it never declares its own.
      if (sourced || secureInput.fields || secureInput.resolve) {
        fail(sourced
          ? `declares source-form secureInput for entity action "${operationKind}"; a source entity is supported only on create.`
          : "secureInput on update names only `into`; the fields are those of the create Operation.");
      }
      if (!createInteraction?.fields || createInteraction.into !== secureInput.into) {
        fail(`secureInput on update requires the create Operation to declare static secureInput fields into "${secureInput.into}".`);
      }
      if (version?.mode !== "required" || editLease || operation.confirmation.mode !== "none") {
        fail("secureInput on update requires version concurrency, no edit lease and no confirmation.");
      }
    } else if (action !== "create") {
      fail(`declares secureInput for entity action "${operationKind}"; secure input is supported only on create and update.`);
    }
    const required: (readonly [string, string | undefined])[] = [["into", secureInput.into]];
    if (action === "create" && !secureInput.fields) required.push(["sourceField", secureInput.sourceField]);
    for (const [option, fieldKey] of required) {
      const field = fieldKey === undefined ? undefined : fieldsByKey.get(fieldKey);
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
    if (action === "create" && secureInput.fields) {
      if (sourced) fail("secureInput declares either static fields or a source entity, not both.");
      const keys = new Set<string>();
      for (const field of secureInput.fields) {
        if (keys.has(field.key)) fail(`secureInput declares field "${field.key}" twice.`);
        keys.add(field.key);
      }
      const resolve = secureInput.resolve;
      if (resolve) {
        if (!secureInput.fields.some((field) => field.classification?.sensitivity === "confidential")) {
          fail("secureInput resolve requires at least one confidential field.");
        }
        const urlField = fieldsByKey.get(resolve.egress.urlField);
        if (!urlField || !urlField.persisted || urlField.required !== true ||
          resolve.egress.urlField === secureInput.into ||
          !["string", "url", "webUrl"].includes(String(urlField.osfType)) || fieldCardinality(urlField) !== "single") {
          fail(`secureInput resolve egress urlField "${resolve.egress.urlField}" must name a required, persisted, single string or url field other than the target.`);
        }
        for (const id of resolve.operations) {
          // An id owned by another declaration is checked against the whole catalog.
          if (!id.startsWith(`${entity.entity}.`)) continue;
          const candidate = Object.entries(entity.operations ?? {})
            .find(([key, definition]) => (definition.id ?? `${entity.entity}.${key}`) === id)?.[1];
          if (!candidate || candidate.implementation.type !== "plugin") {
            fail(`secureInput resolve names "${id}", which is not a plugin Operation of this entity.`);
          }
        }
      }
    } else if (action === "create") {
      if (secureInput.resolve) fail("secureInput resolve is supported only with static fields.");
      if (secureInput.sourceField === secureInput.into) {
        throw new Error(
          `${origin} operation "${operationKey}" secureInput sourceField and into ` +
            "must name different fields.",
        );
      }
      if (!secureInput.sourceEntity || !secureInput.definitionsField) {
        throw new Error(
          `${origin} operation "${operationKey}" secureInput needs sourceEntity and ` +
            "definitionsField naming where the secure field definitions live, or static fields.",
        );
      }
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
