// SPDX-License-Identifier: BUSL-1.1
/**
 * The mutation controls of an Operation, described once.
 *
 * `expectedVersion`, `leaseToken`, `confirmed`, `confirmationToken` and
 * `confirmationAnswer` are the platform's own input properties: the shared
 * executor enforces them, whatever transport carried them. Every projection —
 * the canonical Operation catalogue, REST bodies, MCP tool inputs, the web
 * manifest — reads its properties from here, so one control has one
 * description and one pair of labels everywhere.
 */
import type {
  OperationConcurrency,
  OperationConfirmation,
} from "@openshapeforge/operations";

export type JsonObject = Record<string, unknown>;

export type OperationControlPolicy = {
  concurrency?: OperationConcurrency | undefined;
  confirmation: OperationConfirmation;
};

export type OperationControlSchema = {
  properties: JsonObject;
  required: string[];
  dependentRequired?: Record<string, string[]>;
};

const titled = (schema: JsonObject, en: string, nl: string): JsonObject => ({
  ...schema,
  "x-osf-i18n": { title: { en, nl } },
});

export function operationControlProperties(policy: OperationControlPolicy): OperationControlSchema {
  const properties: JsonObject = {};
  const required: string[] = [];
  let dependentRequired: Record<string, string[]> | undefined;
  if (policy.concurrency?.version) {
    properties.expectedVersion = titled({
      type: "string",
      format: "date-time",
      description: `Version from the record's ${policy.concurrency.version.field} field.`,
    }, "Expected version", "Verwachte versie");
    required.push("expectedVersion");
  }
  if (policy.concurrency?.editLease) {
    properties.leaseToken = titled({
      type: "string",
      minLength: 1,
      description: "Opaque edit-lease token issued by the server for this Operation and record.",
    }, "Edit lease", "Bewerkingslease");
    required.push("leaseToken");
  }
  if (policy.confirmation.mode === "acknowledgement") {
    properties.confirmed = titled({
      type: "boolean",
      description:
        "Set to true after the user explicitly acknowledges this Operation; " +
        "this is not a server-issued security proof.",
    }, "Confirmed", "Bevestigd");
  }
  if (policy.confirmation.mode === "challenge") {
    properties.confirmationToken = titled({
      type: "string",
      minLength: 1,
      description: "Opaque, single-use confirmation challenge token issued by the server.",
    }, "Confirmation token", "Bevestigingstoken");
    properties.confirmationAnswer = titled({
      type: "string",
      minLength: 1,
      description: `Exact current value requested for ${policy.confirmation.challenge.field}.`,
    }, "Confirmation answer", "Bevestigingsantwoord");
    dependentRequired = {
      confirmationToken: ["confirmationAnswer"],
      confirmationAnswer: ["confirmationToken"],
    };
  }
  return { properties, required, ...(dependentRequired ? { dependentRequired } : {}) };
}

/** `schema` with the controls merged in, keeping its own required and dependent keys. */
export function withOperationControlProperties(
  schema: JsonObject,
  policy: OperationControlPolicy,
): JsonObject {
  const controls = operationControlProperties(policy);
  const required = [
    ...new Set([
      ...(Array.isArray(schema.required) ? (schema.required as string[]) : []),
      ...controls.required,
    ]),
  ];
  const dependentRequired = {
    ...((schema.dependentRequired ?? {}) as Record<string, string[]>),
    ...(controls.dependentRequired ?? {}),
  };
  return {
    ...schema,
    properties: { ...((schema.properties ?? {}) as JsonObject), ...controls.properties },
    ...(required.length > 0 || Array.isArray(schema.required) ? { required } : {}),
    ...(Object.keys(dependentRequired).length > 0 ? { dependentRequired } : {}),
  };
}
