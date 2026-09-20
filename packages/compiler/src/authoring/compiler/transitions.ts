// SPDX-License-Identifier: BUSL-1.1
/**
 * Status fields as declared state machines.
 *
 * A field authored with `transitions` is lowered here, before the rest of the
 * compiler runs, into ordinary building blocks the compiler already knows:
 * one plugin-implemented record Operation per rule (bound at runtime to the
 * core `osf-transitions` handler), `writtenBy` on the status field and on
 * every `writes` field, a REST projection under the entity's own resource and
 * a web record action. Nothing downstream is transition-aware except the
 * generic runtime handler and the interface manifests, which carry the rules
 * so a renderer can show them and a tool description can name them.
 */
import type {
  ComponentCatalog,
  CoreEntity,
  EntityOperationDefinition,
  Field,
  LocalizedText,
  OsfTypeDefinition,
} from "../types.js";
import type {
  FieldDefinitionTransitionPrecondition,
  FieldDefinitionTransitionRule,
  FieldDefinitionTransitionWrite,
} from "../types/field-definition.js";
import type { CompiledTransitionField } from "../types/compiled.js";
import { compiledFieldSchemaWithoutDefinitions } from "../../field-json-schema.js";
import { resolveModelFields } from "./model.js";
import { deriveTableName } from "./helpers.js";
import { fieldCardinality } from "./helpers.js";
import { COMPARABLE_BASE_TYPES } from "./transitions-corpus.js";

export const TRANSITIONS_PLUGIN = "osf-transitions";

const RULE_KEY = /^[a-z][A-Za-z0-9]*$/;
const CRUD_KEYS = new Set(["list", "get", "create", "update", "delete"]);

function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function text(value: LocalizedText | string | undefined, fallback: string): LocalizedText {
  if (typeof value === "string") return { en: value, nl: value };
  return { en: value?.en ?? fallback, nl: value?.nl ?? value?.en ?? fallback };
}

function fail(entity: CoreEntity, field: Field, message: string): never {
  throw new Error(`[${entity.entity}] transitions on "${field.key}": ${message}`);
}

/** Every write in its object form: a bare key is optional input with no constraint. */
export function ruleWrites(rule: Pick<FieldDefinitionTransitionRule, "writes">): FieldDefinitionTransitionWrite[] {
  return (rule.writes ?? []).map((write) => (typeof write === "string" ? { field: write } : write));
}

function optionValues(entity: CoreEntity, field: Field): string[] {
  const options = field.options;
  if (options?.type !== "static" || !options.items?.length) {
    fail(entity, field, "requires options.type: static with items — the states of a state machine are part of the entity contract, not a code table.");
  }
  return options.items.map((item) => item.value);
}

function assertStatusField(entity: CoreEntity, field: Field, values: string[]): void {
  const transitions = field.transitions!;
  if (!field.persisted) fail(entity, field, "the field must be persisted.");
  if (field.baseType !== "string" || fieldCardinality(field) !== "single") {
    fail(entity, field, "the field must be a single string.");
  }
  if (field.writtenBy?.length || field.immutable || field.deriveOnCreate || field.computed) {
    fail(entity, field, "the field must not be otherwise writable or written; the transitions are its only writers.");
  }
  if (!values.includes(transitions.initial)) {
    fail(entity, field, `initial "${transitions.initial}" is not one of the options.`);
  }
  if (field.defaultValue !== undefined && field.defaultValue !== transitions.initial) {
    fail(entity, field, `defaultValue must equal initial "${transitions.initial}".`);
  }
  assertNotInForms(entity, field, field.key, "only its transitions write it");
}

/** A field written only by a transition has no place in a create or update form. */
function assertNotInForms(entity: CoreEntity, field: Field, key: string, why: string): void {
  const modes = entity.interfaces?.web?.views?.record?.modes ?? {};
  for (const [mode, definition] of Object.entries(modes)) {
    const listed = (definition?.groups ?? []).some((group) =>
      (group.fields ?? []).some((entry) => (typeof entry === "string" ? entry : entry.key) === key));
    if (listed) fail(entity, field, `"${key}" cannot be edited in the ${mode} form; ${why}.`);
  }
}

function assertRule(
  entity: CoreEntity,
  field: Field,
  rule: FieldDefinitionTransitionRule,
  values: string[],
  seen: Map<string, string>,
): void {
  const where = `rule "${rule.key}"`;
  if (!RULE_KEY.test(rule.key)) fail(entity, field, `${where} must match ${RULE_KEY}.`);
  if (CRUD_KEYS.has(rule.key) || entity.operations?.[rule.key] || seen.has(rule.key)) {
    fail(entity, field, `${where} collides with another operation of ${entity.entity}.`);
  }
  for (const state of [...rule.from, rule.to]) {
    if (!values.includes(state)) fail(entity, field, `${where} names state "${state}", which is not an option.`);
  }
  const fields = new Map(entity.fields.map((entry) => [entry.key, entry]));
  for (const precondition of rule.preconditions ?? []) {
    assertPrecondition(entity, field, where, precondition, fields);
  }
  const permission = rule.auth?.recordPermission;
  if (permission && !entity.authorization?.rowAccess?.recordPermissions) {
    fail(entity, field, `${where} names auth.recordPermission, but ${entity.entity} has no record-level permissions.`);
  }
  // A transition is a write, and the write path asserts edit; a weaker or
  // different permission on the offer would promise what the write refuses.
  if (permission && permission !== "edit") {
    fail(entity, field, `${where} names auth.recordPermission ${permission}; a transition writes the record and requires edit.`);
  }
  const written: Array<{ key: string; how: "writes" | "stamps"; value?: "now" | "actor"; agreesOn?: string[] }> = [
    ...ruleWrites(rule).map((write) => ({ key: write.field, how: "writes" as const, ...(write.agreesOn ? { agreesOn: write.agreesOn } : {}) })),
    ...(rule.stamps ?? []).map((stamp) => ({ key: stamp.field, how: "stamps" as const, value: stamp.value })),
  ];
  for (const { key, how, value, agreesOn } of written) {
    const target = fields.get(key);
    if (!target?.persisted || key === field.key || fieldCardinality(target) !== "single") {
      fail(entity, field, `${where} ${how} "${key}", which is not a persisted single field other than the status.`);
    }
    if (target.writtenBy?.length || target.immutable || target.deriveOnCreate || target.computed || target.transitions) {
      fail(entity, field, `${where} ${how} "${key}", but that field is already written elsewhere.`);
    }
    // writtenBy removes the field from generic create while storage stays
    // NOT NULL: without a default no record could ever be created.
    if (target.required && target.defaultValue === undefined) {
      fail(entity, field, `${where} ${how} "${key}", which is required without a defaultValue, so no record could be created.`);
    }
    if (value === "now" && target.baseType !== "datetime") {
      fail(entity, field, `${where} stamps "${key}" with now, but it is not a datetime field.`);
    }
    if (value === "actor" && !stampActor(target)) {
      fail(entity, field, `${where} stamps "${key}" with actor, but it is neither a Relation reference nor a string field.`);
    }
    if (agreesOn) assertAgreesOn(entity, field, where, target, agreesOn, fields);
    assertNotInForms(entity, field, key, `${where} ${how} it`);
    const writer = seen.get(`writes:${key}`);
    if (writer) fail(entity, field, `${where} ${how} "${key}", which rule "${writer}" already writes.`);
    seen.set(`writes:${key}`, rule.key);
  }
  seen.set(rule.key, rule.key);
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
function assertPrecondition(
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
      nl: `${name} ${present ? "gezet" : "leeg"} is`,
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
function assertAgreesOn(entity: CoreEntity, field: Field, where: string, target: Field, agreesOn: string[], fields: Map<string, Field>): void {
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
function stampActor(field: Field): "relation" | "user" | undefined {
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
function ruleRecordPermission(entity: CoreEntity, _rule: FieldDefinitionTransitionRule): "edit" | undefined {
  return entity.authorization?.rowAccess?.recordPermissions ? "edit" : undefined;
}

function ruleOperation(
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

export type TransitionCatalogs = {
  componentCatalog: ComponentCatalog;
  osfTypes?: Record<string, OsfTypeDefinition>;
};

/**
 * Lower every `transitions` field of the entity. Returns the entity with the
 * synthesized Operations, projections and `writtenBy` marks, plus the compiled
 * rule table the manifests and the runtime handler read.
 */
export function withStatusTransitions(
  entity: CoreEntity,
  catalogs: TransitionCatalogs,
): { entity: CoreEntity; transitions: CompiledTransitionField[] } {
  const statusFields = entity.fields.filter((field) => field.transitions);
  if (statusFields.length === 0) return { entity, transitions: [] };
  if (!entity.authorization) {
    throw new Error(`[${entity.entity}] transitions require a tenant-scoped entity with authorization roles.`);
  }
  if (entity.schemaVersion < 2) {
    throw new Error(`[${entity.entity}] transitions require schemaVersion 2 or later.`);
  }
  const seen = new Map<string, string>();
  const writtenBy = new Map<string, string[]>();
  const operations: Record<string, EntityOperationDefinition> = {};
  const compiled: CompiledTransitionField[] = [];
  const basePath = entity.interfaces?.rest?.basePath ?? deriveTableName(entity.entity).replace(/_/g, "-");
  const rest: Record<string, { method: "POST"; path: string }> = {};
  for (const field of statusFields) {
    const values = optionValues(entity, field);
    assertStatusField(entity, field, values);
    const rules = field.transitions!.rules;
    for (const rule of rules) assertRule(entity, field, rule, values, seen);
    writtenBy.set(field.key, rules.map((rule) => `${entity.entity}.${rule.key}`));
    for (const rule of rules) {
      const id = `${entity.entity}.${rule.key}`;
      const writeKeys = ruleWrites(rule).map((write) => write.field);
      const writeFields = entity.fields.filter((entry) => writeKeys.includes(entry.key));
      const writes = Object.fromEntries(
        resolveModelFields(writeFields, catalogs.componentCatalog, catalogs.osfTypes)
          .map((compiledField) => [compiledField.key, compiledFieldSchemaWithoutDefinitions(compiledField)]),
      );
      for (const key of writeKeys) writtenBy.set(key, [id]);
      for (const stamp of rule.stamps ?? []) writtenBy.set(stamp.field, [id]);
      operations[rule.key] = ruleOperation(entity, field, rule, values, writes);
      rest[rule.key] = { method: "POST", path: `/api/rest/v1/${basePath}/:id/${kebab(rule.key)}` };
    }
    compiled.push({
      field: field.key,
      initial: field.transitions!.initial,
      rules: rules.map((rule) => ({
        key: rule.key,
        operation: `${entity.entity}.${rule.key}`,
        from: [...rule.from],
        to: rule.to,
        label: text(rule.label, rule.key),
        ...(() => { const permission = ruleRecordPermission(entity, rule); return permission ? { recordPermission: permission } : {}; })(),
        ...(rule.preconditions?.length ? { preconditions: rule.preconditions.map((entry) => ({ ...entry })) } : {}),
        ...(rule.writes?.length
          ? { writes: ruleWrites(rule).map((write) => ({
              field: write.field,
              required: write.required === true,
              ...(write.agreesOn?.length ? { agreesOn: [...write.agreesOn] } : {}),
            })) }
          : {}),
        ...(rule.stamps?.length
          ? { stamps: rule.stamps.map((stamp) => ({
              field: stamp.field,
              value: stamp.value,
              ...(stamp.value === "actor" ? { actor: stampActor(entity.fields.find((entry) => entry.key === stamp.field)!)! } : {}),
            })) }
          : {}),
      })),
    });
  }
  const fields = entity.fields.map((field) => {
    const writers = writtenBy.get(field.key);
    if (!writers) return field;
    const defaulted = field.transitions ? { defaultValue: field.transitions.initial } : {};
    return { ...field, ...defaulted, writtenBy: writers };
  });
  const views = entity.interfaces?.web?.views;
  const ruleKeys = Object.keys(operations);
  return {
    transitions: compiled,
    entity: {
      ...entity,
      fields,
      operations: { ...(entity.operations ?? {}), ...operations },
      interfaces: {
        ...entity.interfaces,
        ...(entity.interfaces?.rest
          ? { rest: { ...entity.interfaces.rest, operations: { ...rest, ...(entity.interfaces.rest.operations ?? {}) } } }
          : {}),
        ...(views?.record
          ? {
              web: {
                ...entity.interfaces!.web,
                views: {
                  ...views,
                  record: { ...views.record, actions: [...new Set([...(views.record.actions ?? []), ...ruleKeys])] },
                },
              },
            }
          : {}),
      },
    },
  };
}
