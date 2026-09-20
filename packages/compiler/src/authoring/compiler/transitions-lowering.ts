// SPDX-License-Identifier: BUSL-1.1
/**
 * Per-entity lowering of one status-transition rule: the Operation it
 * becomes, the offer clause that describes when it fires, and the local
 * half of `agreesOn` / referenced preconditions. Corpus-wide checks live
 * in transitions-corpus.ts; the entity walk is withStatusTransitions.
 */
import type {
  CoreEntity,
  EntityOperationDefinition,
  Field,
  LocalizedText,
} from "../types.js";
import type {
  FieldDefinitionTransitionPrecondition,
  FieldDefinitionTransitionRule,
  FieldDefinitionTransitionWrite,
} from "../types/field-definition.js";
import { fieldCardinality } from "./helpers.js";
import { COMPARABLE_BASE_TYPES } from "./transitions-corpus.js";

export const TRANSITIONS_PLUGIN = "osf-transitions";

/** Every write in its object form: a bare key is optional input with no constraint. */
export function ruleWrites(rule: Pick<FieldDefinitionTransitionRule, "writes">): FieldDefinitionTransitionWrite[] {
  return (rule.writes ?? []).map((write) => (typeof write === "string" ? { field: write } : write));
}

export function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export function text(value: LocalizedText | string | undefined, fallback: string): LocalizedText {
  if (typeof value === "string") return { en: value, nl: value };
  return { en: value?.en ?? fallback, nl: value?.nl ?? value?.en ?? fallback };
}

export function fail(entity: CoreEntity, field: Field, message: string): never {
  throw new Error(`[${entity.entity}] transitions on "${field.key}": ${message}`);
}

function referencedField(precondition: FieldDefinitionTransitionPrecondition): string {
  return "via" in precondition && precondition.via
    ? `${precondition.via}.${precondition.field}`
    : precondition.field;
}

/**
 * Per-entity half of a precondition: a row-level `field` must be persisted
 * here; a `via` must be a persisted single entity reference. That the
 * referenced entity carries `field` is the corpus-wide check.
 */
export function assertPrecondition(
  entity: CoreEntity,
  field: Field,
  where: string,
  precondition: FieldDefinitionTransitionPrecondition,
  fields: Map<string, Field>,
): void {
  const hasPresent = "present" in precondition && precondition.present !== undefined;
  const hasIn = "in" in precondition && precondition.in !== undefined;
  if (hasPresent === hasIn) {
    fail(entity, field, `${where} precondition on "${referencedField(precondition)}" must set present or in, not both.`);
  }
  if ("via" in precondition && precondition.via) {
    const via = fields.get(precondition.via);
    if (!via?.persisted || !via.relationship || fieldCardinality(via) !== "single") {
      fail(entity, field, `${where} precondition via "${precondition.via}" is not a persisted single entity reference.`);
    }
    if (hasIn && (!Array.isArray(precondition.in) || precondition.in.length === 0)) {
      fail(entity, field, `${where} precondition on "${referencedField(precondition)}" in is empty.`);
    }
    return;
  }
  if (hasIn) {
    fail(entity, field, `${where} precondition in requires via.`);
  }
  const target = fields.get(precondition.field);
  if (!target?.persisted) fail(entity, field, `${where} precondition names "${precondition.field}", which is not a persisted field.`);
}

/** How the Operation description names the offer window, including preconditions. */
function offerClause(status: string, rule: FieldDefinitionTransitionRule): LocalizedText {
  const from = rule.from.join(" or ");
  const fromNl = rule.from.join(" of ");
  const parts = (rule.preconditions ?? []).map((entry) => {
    const name = referencedField(entry);
    if ("in" in entry && entry.in) {
      const listed = entry.in.map((value) => String(value));
      return { en: `${name} is ${listed.join(" or ")}`, nl: `${name} ${listed.join(" of ")} is` };
    }
    const present = "present" in entry && entry.present;
    return {
      en: `${name} is ${present ? "set" : "empty"}`,
      nl: `${name} ${present ? "ingevuld" : "leeg"} is`,
    };
  });
  return {
    en: `offered only while ${status} is ${from}${parts.map((part) => ` and ${part.en}`).join("")}.`,
    nl: `alleen aangeboden zolang ${status} ${fromNl} is${parts.map((part) => ` en ${part.nl}`).join("")}.`,
  };
}

/**
 * `agreesOn` names fields the referenced record must share with this one:
 * the written field must be a single entity reference, and every named field
 * must be a persisted single scalar here. That the target entity carries the
 * same field with the same base type is checked across the corpus by
 * `assertTransitionAgreements`, and bound to typed columns by the runtime.
 */
export function assertAgreesOn(entity: CoreEntity, field: Field, where: string, target: Field, agreesOn: string[], fields: Map<string, Field>): void {
  if (!target.relationship || fieldCardinality(target) !== "single") {
    fail(entity, field, `${where} constrains "${target.key}" with agreesOn, but it is not a single entity reference.`);
  }
  for (const key of agreesOn) {
    const local = fields.get(key);
    if (!local?.persisted || fieldCardinality(local) !== "single" || !COMPARABLE_BASE_TYPES.has(local.baseType ?? "")) {
      fail(entity, field, `${where} agreesOn "${key}", which is not a persisted single comparable field of ${entity.entity}.`);
    }
  }
}

/** How `actor` lands in a field: the session's linked Relation for a Relation reference, else the user id. */
export function stampActor(field: Field): "relation" | "user" | undefined {
  if (field.osfType === "Relation") return "relation";
  if (field.baseType === "string" && !field.relationship && !field.options) return "user";
  return undefined;
}

function idSchema(entity: CoreEntity): Record<string, unknown> {
  return {
    type: "string",
    format: "uuid",
    "x-osf-reference": { entity: entity.entity },
    "x-osf-i18n": { title: text(entity.labels, entity.title) },
  };
}

function statusSchema(field: Field, values: string[]): Record<string, unknown> {
  const items = field.options?.type === "static" ? field.options.items ?? [] : [];
  return {
    type: "string",
    enum: values,
    "x-osf-i18n": {
      title: text(field.label, field.key),
      enum: Object.fromEntries(items.map((item) => [item.value, text(item.label, item.value)])),
    },
  };
}

/** `edit` on an entity with record-level permissions; nothing on one without. */
export function ruleRecordPermission(entity: CoreEntity, _rule: FieldDefinitionTransitionRule): "edit" | undefined {
  return entity.authorization?.rowAccess?.recordPermissions ? "edit" : undefined;
}

export function ruleOperation(
  entity: CoreEntity,
  field: Field,
  rule: FieldDefinitionTransitionRule,
  values: string[],
  writes: Record<string, Record<string, unknown>>,
): EntityOperationDefinition {
  const recordPermission = ruleRecordPermission(entity, rule);
  const requiredWrites = new Set(ruleWrites(rule).filter((write) => write.required).map((write) => write.field));
  const required = ["id", ...Object.keys(writes).filter((key) => requiredWrites.has(key) || entity.fields.find((entry) => entry.key === key)?.required)];
  const label = text(rule.label, rule.key);
  const summary = text(rule.description, "");
  const path = `${field.key}: ${rule.from.join(" | ")} -> ${rule.to}`;
  const offered = offerClause(field.key, rule);
  return {
    id: `${entity.entity}.${rule.key}`,
    name: label,
    description: {
      en: `${summary.en || `${label.en} this ${text(entity.labels, entity.title).en!.toLowerCase()}`}. Moves ${path}; ${offered.en}`,
      nl: `${summary.nl || label.nl}. Zet ${path}; ${offered.nl}`,
    },
    implementation: { type: "plugin", plugin: TRANSITIONS_PLUGIN, handler: `transition${entity.entity}${rule.key[0]!.toUpperCase()}${rule.key.slice(1)}` },
    target: { scope: "record", inputField: "id" },
    input: { schema: { type: "object", additionalProperties: false, required, properties: { id: idSchema(entity), ...writes } } },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        required: ["id", field.key],
        properties: {
          id: idSchema(entity),
          [field.key]: statusSchema(field, values),
        },
      },
    },
    errors: [
      { status: 400, code: "VALIDATION", description: "The transition input is invalid." },
      { status: 403, code: "FORBIDDEN", description: "The caller may not perform this transition." },
      { status: 404, code: "NOT_FOUND", description: `The ${entity.entity} does not exist.` },
      { status: 409, code: "INVALID_STATE", description: `The ${entity.entity} is not ${rule.from.join(" or ")}, or a precondition of ${rule.key} does not hold.` },
      { status: 409, code: "VERSION_CONFLICT", description: "The record changed since it was loaded." },
    ],
    auth: {
      mode: "session",
      roles: [...(rule.auth?.roles ?? entity.authorization?.roles?.update ?? [])],
      ...(recordPermission ? { recordPermission } : {}),
    },
    tenancy: { mode: "required" },
    effects: { data: "write", external: "none" },
    reliability: { idempotency: { mode: "none" } },
    concurrency: { version: { mode: "required", field: "updatedAt" } },
    confirmation: rule.confirmation ?? { mode: "none" },
  };
}
