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
  OsfTypeDefinition,
} from "../types.js";
import type { FieldDefinitionTransitionRule } from "../types/field-definition.js";
import type { CompiledTransitionField } from "../types/compiled.js";
import { compiledFieldSchemaWithoutDefinitions } from "../../field-json-schema.js";
import { resolveModelFields } from "./model.js";
import { deriveTableName } from "./helpers.js";
import { fieldCardinality } from "./helpers.js";
import {
  assertAgreesOn,
  assertPrecondition,
  fail,
  kebab,
  ruleOperation,
  ruleRecordPermission,
  ruleWrites,
  stampActor,
  text,
} from "./transitions-lowering.js";

export { TRANSITIONS_PLUGIN, ruleWrites } from "./transitions-lowering.js";

const RULE_KEY = /^[a-z][A-Za-z0-9]*$/;
const CRUD_KEYS = new Set(["list", "get", "create", "update", "delete"]);

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
