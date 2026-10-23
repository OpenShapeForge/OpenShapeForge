// SPDX-License-Identifier: BUSL-1.1
/**
 * Entity subtypes: `kind: entitySubtype` composes a scoped projection of one
 * base `coreEntity` after every layer's entityPatch has been applied to that
 * base. The subtype shares the base's table and record identities; it adds no
 * field, relationship or storage. It may restate names and text, narrow
 * authorization and validation, choose its own interface routes and
 * presentation, and hide base fields from its public contract. Everything
 * else is inherited verbatim.
 *
 * The composed result is an ordinary CoreEntity carrying `subtype`, so the
 * compiler and every generator treat it as one more entity; only the backend
 * manifest binds it to the base table instead of emitting a second one.
 */
import type {
  AuthorizationConfig,
  CoreEntity,
  EntityInterfacesDefinition,
  EntitySubtypeDocument,
  EntitySubtypeFieldOverride,
  EntitySubtypeScopeValue,
  Field,
  OsfTypeDefinition,
} from "./types.js";
import { assertEntitySecurityOnlyNarrows, strategicMerge } from "./layers.js";
import { fieldCardinality } from "./compiler/helpers.js";

export const ENTITY_SUBTYPE_KIND = "entitySubtype";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const FIELD_KEY = /^[a-z][A-Za-z0-9]*$/;
const ENTITY_NAME = /^[A-Z][A-Za-z0-9]*$/;

const DOCUMENT_KEYS = new Set([
  "schemaVersion", "kind", "entity", "extends", "scope", "title", "description", "language", "labels",
  "pluralLabels", "displayTemplate", "filterField", "domains", "fields", "authorization", "operations", "interfaces",
]);
const FIELD_OVERRIDE_KEYS = new Set(["key", "hidden", "label", "description", "help", "required", "validation", "permissions", "authorization"]);
const OPERATION_OVERRIDE_KEYS = new Set(["name", "description", "guidance"]);
/**
 * Base properties a subtype never inherits: a second blueprint Operation set,
 * the audit timeline composition and the lowered UI are the base's own.
 * Retention, hooks and hard-delete rules stay: they guard the shared rows and
 * the runtime reads them from the table the subtype is served from.
 */
const BASE_KEYS_NOT_INHERITED = ["blueprint", "audit", "workerAccess", "versioning", "ui"] as const;
const INTRINSIC_FIELDS = new Set(["id", "tenantId", "createdAt", "updatedAt"]);
/** Validation constraints a subtype may only tighten, with the direction that tightens them. */
const NARROWING_RULES: Record<string, "raise" | "lower"> = {
  minLength: "raise", minItems: "raise", min: "raise",
  maxLength: "lower", max: "lower",
};

export function isEntitySubtypeDocument(document: unknown): document is EntitySubtypeDocument {
  return typeof document === "object" && document !== null && !Array.isArray(document) &&
    (document as { kind?: unknown }).kind === ENTITY_SUBTYPE_KIND;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(origin: string, message: string): never {
  throw new Error(`${origin}: ${message}`);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, origin: string, where: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    fail(origin, `${where} carries unsupported key${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. ` +
      "A subtype inherits the base contract; it may only restate text, narrow authorization and validation, hide fields and choose its interfaces.");
  }
}

function isScopeValue(value: unknown): value is EntitySubtypeScopeValue {
  return typeof value === "string" ? value.length > 0
    : typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

/** The structural rules of the document itself, independent of the base it extends. */
export function assertEntitySubtypeDocument(document: unknown, origin: string): asserts document is EntitySubtypeDocument {
  if (!isEntitySubtypeDocument(document)) fail(origin, "is not a kind: entitySubtype document.");
  const subtype = document as unknown as Record<string, unknown>;
  assertKnownKeys(subtype, DOCUMENT_KEYS, origin, "the subtype");
  if (subtype.schemaVersion !== 3) fail(origin, "must be schemaVersion 3.");
  if (typeof subtype.entity !== "string" || !ENTITY_NAME.test(subtype.entity)) fail(origin, "entity must be a PascalCase entity name.");
  if (typeof subtype.extends !== "string" || !ENTITY_NAME.test(subtype.extends)) fail(origin, "extends must name the base entity (PascalCase).");
  if (subtype.extends === subtype.entity) fail(origin, "a subtype cannot extend itself.");
  if (!isPlainObject(subtype.scope) || Object.keys(subtype.scope).length === 0) {
    fail(origin, "scope must fix at least one base field to one value, for example scope: { groupType: team }.");
  }
  for (const [key, value] of Object.entries(subtype.scope)) {
    if (!FIELD_KEY.test(key)) fail(origin, `scope key "${key}" is not a field key.`);
    if (!isScopeValue(value)) fail(origin, `scope.${key} must be a non-empty string, a finite number or a boolean.`);
  }
  if (subtype.fields !== undefined) {
    if (!Array.isArray(subtype.fields)) fail(origin, "fields must be an array of overrides.");
    const seen = new Set<string>();
    for (const override of subtype.fields) {
      if (!isPlainObject(override) || typeof override.key !== "string" || !FIELD_KEY.test(override.key)) {
        fail(origin, "every field override needs a key naming a base field.");
      }
      assertKnownKeys(override, FIELD_OVERRIDE_KEYS, origin, `field override "${override.key}"`);
      if (seen.has(override.key)) fail(origin, `field "${override.key}" is overridden twice.`);
      seen.add(override.key);
      if (override.hidden !== undefined && override.hidden !== true) fail(origin, `fields.${override.key}.hidden accepts only true.`);
      if (override.required !== undefined && override.required !== true) {
        fail(origin, `fields.${override.key}.required accepts only true: a subtype may require a value the base leaves optional, never the reverse.`);
      }
      for (const key of ["validation", "permissions", "authorization", "label", "description", "help"] as const) {
        if (override[key] !== undefined && !isPlainObject(override[key])) fail(origin, `fields.${override.key}.${key} must be an object.`);
      }
    }
  }
  if (subtype.operations !== undefined) {
    if (!isPlainObject(subtype.operations)) fail(origin, "operations must map Operation keys to text overrides.");
    for (const [key, override] of Object.entries(subtype.operations)) {
      if (!isPlainObject(override)) fail(origin, `operations.${key} must be an object.`);
      assertKnownKeys(override, OPERATION_OVERRIDE_KEYS, origin, `operations.${key}`);
    }
  }
  for (const key of ["authorization", "interfaces", "labels", "pluralLabels"] as const) {
    if (subtype[key] !== undefined && !isPlainObject(subtype[key])) fail(origin, `${key} must be an object.`);
  }
  // Row policy is the base table's row-level security; a subtype cannot add
  // an axis the physical policy would not enforce, so it inherits the policy
  // exactly and may narrow roles and field rights only.
  if (isPlainObject(subtype.authorization) && subtype.authorization.rowAccess !== undefined) {
    fail(origin, "authorization.rowAccess is inherited from the base exactly; a subtype may narrow authorization.roles and field permissions, not the row policy.");
  }
}

function ruleValue(value: unknown): unknown {
  return isPlainObject(value) && "value" in value ? value.value : value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Every base constraint survives and only becomes stricter. */
function assertValidationOnlyNarrows(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined, path: string, origin: string): void {
  for (const [rule, prior] of Object.entries(before ?? {})) {
    const next = after?.[rule];
    if (next === undefined) fail(origin, `${path}.${rule} is declared by the base and cannot be removed.`);
    const direction = NARROWING_RULES[rule];
    const priorValue = ruleValue(prior);
    const nextValue = ruleValue(next);
    if (direction && typeof priorValue === "number" && typeof nextValue === "number") {
      if (direction === "raise" ? nextValue < priorValue : nextValue > priorValue) {
        fail(origin, `${path}.${rule} widens the base constraint (${priorValue} -> ${nextValue}).`);
      }
      continue;
    }
    if (!sameJson(priorValue, nextValue)) {
      fail(origin, `${path}.${rule} changes a base constraint that cannot be ordered; a subtype may only add constraints or tighten numeric bounds.`);
    }
  }
}

/** Template placeholders `{{key}}` or `{{key.rest}}` naming a field. */
function templateFieldKeys(template: string | undefined): string[] {
  if (!template) return [];
  return [...template.matchAll(/\{\{\s*([A-Za-z0-9_]+)/g)].map((match) => match[1]!);
}

/** Keys under which a string (or `key`/`name`-carrying object) names a field or relationship. */
const REFERENCE_LIST_KEYS = new Set(["fields", "badges", "relationships", "columns", "sortFields", "filters", "filterFields", "include", "createRequires"]);
const REFERENCE_VALUE_KEYS = new Set([
  "relationship", "filterField", "tabLabel", "rowField", "columnField", "valueField", "field", "sourceField", "iconField",
  "titleField", "timestampField", "descriptionField", "relatedField", "channelField", "preferredChannelField", "through",
  "via", "inverse", "definitionField", "documentField", "groupsFrom", "displayField", "status",
]);
const TEMPLATE_KEYS = new Set(["title", "subtitle", "displayTemplate"]);

/**
 * Find a hidden field named by the subtype's OWN configuration: an explicit
 * leak the author must resolve, unlike an inherited reference the composer
 * prunes. Walks reference-bearing keys only, so prose never trips it.
 */
function findExplicitHiddenReference(value: unknown, hidden: ReadonlySet<string>, path: string): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findExplicitHiddenReference(item, hidden, `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (REFERENCE_LIST_KEYS.has(key) && Array.isArray(child)) {
      for (const item of child) {
        const name = typeof item === "string" ? item : isPlainObject(item) ? (item.key ?? item.name ?? item.relationship) : undefined;
        if (typeof name === "string" && hidden.has(name)) return `${childPath} (${name})`;
      }
    }
    if (REFERENCE_VALUE_KEYS.has(key)) {
      const name = typeof child === "string" ? child : isPlainObject(child) ? (child.name ?? child.key ?? child.field) : undefined;
      if (typeof name === "string" && hidden.has(name)) return `${childPath} (${name})`;
    }
    if ((key === "defaultSort" || key === "sort") && isPlainObject(child) && typeof child.key === "string" && hidden.has(child.key)) {
      return `${childPath} (${child.key})`;
    }
    if (TEMPLATE_KEYS.has(key) && typeof child === "string") {
      const leaked = templateFieldKeys(child).find((name) => hidden.has(name));
      if (leaked) return `${childPath} ({{${leaked}}})`;
    }
    if (key === "fields" && isPlainObject(child)) {
      const leaked = Object.keys(child).find((name) => hidden.has(name));
      if (leaked) return `${childPath}.${leaked}`;
    }
    const found = findExplicitHiddenReference(child, hidden, childPath);
    if (found) return found;
  }
  return undefined;
}

function fieldEntryKey(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (isPlainObject(entry) && typeof entry.key === "string") return entry.key;
  return undefined;
}

function relationshipUsageName(usage: unknown): string | undefined {
  if (typeof usage === "string") return usage;
  if (isPlainObject(usage) && typeof usage.name === "string") return usage.name;
  return undefined;
}

/** Drop inherited presentation of hidden fields: columns, groups, placements and context. */
function pruneGroups(groups: unknown, hidden: ReadonlySet<string>): unknown {
  if (!Array.isArray(groups)) return groups;
  return groups.flatMap((group) => {
    if (!isPlainObject(group)) return [group];
    const next: Record<string, unknown> = { ...group };
    let hadContent = false;
    let dropped = false;
    if (Array.isArray(group.fields)) {
      hadContent = true;
      next.fields = group.fields.filter((entry) => { const key = fieldEntryKey(entry); return key === undefined || !hidden.has(key); });
    }
    if (Array.isArray(group.relationships)) {
      hadContent = true;
      next.relationships = group.relationships.filter((usage) => { const name = relationshipUsageName(usage); return name === undefined || !hidden.has(name); });
    }
    if (group.relationship !== undefined) {
      hadContent = true;
      const name = relationshipUsageName(group.relationship);
      if (name !== undefined && hidden.has(name)) dropped = true;
    }
    if (isPlainObject(group.bindings)) {
      next.bindings = Object.fromEntries(Object.entries(group.bindings).filter(([, field]) => typeof field !== "string" || !hidden.has(field)));
    }
    if (isPlainObject(group.timeline) && Array.isArray(group.timeline.include)) {
      next.timeline = { ...group.timeline, include: group.timeline.include.filter((item) =>
        !(isPlainObject(item) && typeof item.relationship === "string" && hidden.has(item.relationship))) };
    }
    if (Array.isArray(group.groups)) {
      hadContent = true;
      next.groups = pruneGroups(group.groups, hidden);
    }
    if (dropped) return [];
    const empty = hadContent &&
      (!Array.isArray(next.fields) || next.fields.length === 0) &&
      (!Array.isArray(next.relationships) || next.relationships.length === 0) &&
      next.relationship === undefined &&
      (!Array.isArray(next.groups) || next.groups.length === 0) &&
      next.render === undefined && next.groupsFrom === undefined;
    return empty ? [] : [next];
  });
}

function pruneInheritedInterfaces(interfaces: Record<string, unknown>, hidden: ReadonlySet<string>): Record<string, unknown> {
  const web = isPlainObject(interfaces.web) ? { ...interfaces.web } : undefined;
  if (!web) return interfaces;
  if (isPlainObject(web.fields)) {
    web.fields = Object.fromEntries(Object.entries(web.fields).filter(([key]) => !hidden.has(key)));
  }
  if (isPlainObject(web.views)) {
    const views: Record<string, unknown> = { ...web.views };
    if (isPlainObject(views.collection)) {
      const collection = { ...views.collection };
      if (Array.isArray(collection.columns)) collection.columns = collection.columns.filter((column) => { const key = fieldEntryKey(column); return key === undefined || !hidden.has(key); });
      if (isPlainObject(collection.defaultSort) && typeof collection.defaultSort.key === "string" && hidden.has(collection.defaultSort.key)) delete collection.defaultSort;
      views.collection = collection;
    }
    if (isPlainObject(views.record)) {
      const record = { ...views.record };
      if (Array.isArray(record.badges)) record.badges = record.badges.filter((key) => typeof key !== "string" || !hidden.has(key));
      if (isPlainObject(record.layout)) {
        const layout = { ...record.layout };
        layout.tabs = pruneGroups(layout.tabs, hidden);
        if (isPlainObject(layout.context)) {
          const context = { ...layout.context };
          if (Array.isArray(context.fields)) context.fields = context.fields.filter((key) => typeof key !== "string" || !hidden.has(key));
          if (Array.isArray(context.relationships)) context.relationships = context.relationships.filter((key) => typeof key !== "string" || !hidden.has(key));
          layout.context = context;
        }
        record.layout = layout;
      }
      if (isPlainObject(record.modes)) {
        const modes: Record<string, unknown> = {};
        for (const [mode, definition] of Object.entries(record.modes)) {
          modes[mode] = isPlainObject(definition) && Array.isArray(definition.groups)
            ? { ...definition, groups: pruneGroups(definition.groups, hidden) }
            : definition;
        }
        record.modes = modes;
      }
      views.record = record;
    }
    const pruneNamed = (name: string, view: unknown): unknown => {
      if (!isPlainObject(view)) return view;
      if (view.kind === "record" && Array.isArray(view.fields)) return { ...view, fields: view.fields.filter((key) => typeof key !== "string" || !hidden.has(key)) };
      if (view.kind === "record" && isPlainObject(view.layout)) {
        const layout: Record<string, unknown> = { ...view.layout, tabs: pruneGroups(view.layout.tabs, hidden) };
        const context = isPlainObject(layout.context) ? layout.context : undefined;
        if (context && Array.isArray(context.fields)) {
          layout.context = { ...context, fields: context.fields.filter((key: unknown) => typeof key !== "string" || !hidden.has(key)) };
        }
        return { ...view, layout };
      }
      return view;
    };
    for (const [name, view] of Object.entries(views)) {
      if (name === "collection" || name === "record") continue;
      if (name === "named" && isPlainObject(view)) {
        views.named = Object.fromEntries(Object.entries(view).map(([inner, definition]) => [inner, pruneNamed(inner, definition)]));
      } else {
        views[name] = pruneNamed(name, view);
      }
    }
    web.views = views;
  }
  return { ...interfaces, web };
}

export type EntitySubtypeCompositionContext = {
  /** The subtype file, for messages. */
  origin: string;
  /** The base entity's file, for messages. */
  baseOrigin: string;
  /** The base entity's file stem. */
  baseSlug: string;
};

/**
 * Compose the subtype onto the base entity (already carrying its `_base.yaml`
 * meta fields and every layer's patches). The result is a CoreEntity named
 * after the subtype, with `subtype` recording what the manifest and runtime
 * need to bind it to the base table.
 */
export function composeEntitySubtype(
  subtype: EntitySubtypeDocument,
  base: CoreEntity,
  context: EntitySubtypeCompositionContext,
): CoreEntity {
  const { origin } = context;
  assertEntitySubtypeDocument(subtype, origin);
  if ((base as { kind?: string }).kind === ENTITY_SUBTYPE_KIND || base.subtype !== undefined) {
    fail(origin, `extends ${subtype.extends}, which is itself a subtype; subtype chains are not supported.`);
  }
  if (base.kind !== "coreEntity") fail(origin, `extends ${subtype.extends}, which is not a coreEntity (${context.baseOrigin}).`);
  if (base.entity !== subtype.extends) fail(origin, `extends ${subtype.extends} but ${context.baseOrigin} declares entity ${base.entity}.`);
  if (base.source) fail(origin, `extends ${base.entity}, an Operation-backed entity without storage; only stored entities can be subtyped.`);
  if (base.baseEntity === false) fail(origin, `extends ${base.entity}, which has no record identity; only stored entities can be subtyped.`);
  if (base.versioning) fail(origin, `extends ${base.entity}, which declares versioning; versioned bases are not supported for subtypes.`);
  if (base.workerAccess) fail(origin, `extends ${base.entity}, which grants workerAccess; such bases are not supported for subtypes.`);
  for (const field of base.fields) {
    if (field.transitions) fail(origin, `extends ${base.entity}, whose field ${field.key} is a state machine; bases with transitions are not supported for subtypes.`);
  }
  // Canonical entity Operations and the native collection Operations the
  // compiler implements are inherited; the runtime scopes both through the
  // subtype's table. An arbitrary plugin handler is not: nothing holds it to
  // the subtype's scope.
  for (const [key, operation] of Object.entries(base.operations ?? {})) {
    if (operation.implementation.type !== "entity" && operation.implementation.type !== "collection") {
      fail(origin, `extends ${base.entity}, whose Operation ${key} is ${operation.implementation.type}-implemented; a subtype inherits canonical entity and native collection Operations only.`);
    }
  }

  const baseFields = new Map(base.fields.map((field) => [field.key, field]));
  const hidden = new Set<string>();
  for (const override of subtype.fields ?? []) {
    if (!baseFields.has(override.key)) fail(origin, `fields.${override.key} does not exist on ${base.entity}; a subtype adds no fields or relationships.`);
    if (override.hidden) hidden.add(override.key);
  }
  for (const key of Object.keys(subtype.scope)) {
    const field = baseFields.get(key);
    if (!field) fail(origin, `scope.${key} does not exist on ${base.entity}.`);
    if (!field.persisted) fail(origin, `scope.${key} must be a persisted field.`);
    if (field.relationship || ENTITY_NAME.test(field.osfType) || fieldCardinality(field) === "collection") {
      fail(origin, `scope.${key} must be a single scalar field, not a relationship or collection.`);
    }
    if (field.computed || field.deriveOnCreate || field.writtenBy?.length || field.typedBy || field.entityValue || field.defaultTemplate !== undefined) {
      fail(origin, `scope.${key} is already server-derived or Operation-written on ${base.entity}; it cannot double as a scope discriminator.`);
    }
    if (INTRINSIC_FIELDS.has(key)) fail(origin, `scope.${key} is an intrinsic identity field.`);
  }

  // Inherit the whole base minus what describes its table or a second Operation set.
  const inherited: Record<string, unknown> = { ...base };
  for (const key of BASE_KEYS_NOT_INHERITED) delete inherited[key];
  const merged: Record<string, unknown> = { ...inherited };
  for (const key of ["title", "description", "language", "labels", "pluralLabels", "displayTemplate", "filterField", "domains"] as const) {
    if (subtype[key] !== undefined) merged[key] = subtype[key];
  }

  merged.fields = base.fields.map((field) => {
    const override = subtype.fields?.find((candidate) => candidate.key === field.key);
    if (!override) return field;
    const { key: _key, hidden: _hidden, ...changes } = override;
    if (changes.required === true && field.required !== true) changes.required = true;
    const next = strategicMerge(field as unknown as JsonValue, changes as unknown as JsonValue) as unknown as Field;
    assertValidationOnlyNarrows(
      field.validation as Record<string, unknown> | undefined,
      next.validation as Record<string, unknown> | undefined,
      `fields.${field.key}.validation`,
      origin,
    );
    return next;
  });

  if (subtype.authorization) {
    merged.authorization = strategicMerge(
      (base.authorization ?? {}) as unknown as JsonValue,
      subtype.authorization as unknown as JsonValue,
    ) as unknown as AuthorizationConfig;
  }
  if (subtype.operations) {
    const operations: Record<string, unknown> = { ...(base.operations ?? {}) };
    for (const [key, override] of Object.entries(subtype.operations)) {
      if (!operations[key]) fail(origin, `operations.${key} does not exist on ${base.entity}; a subtype adds no Operations.`);
      operations[key] = strategicMerge(operations[key] as JsonValue, override as unknown as JsonValue);
    }
    merged.operations = operations;
  }
  if (subtype.interfaces) {
    merged.interfaces = strategicMerge(
      (base.interfaces ?? {}) as unknown as JsonValue,
      subtype.interfaces as unknown as JsonValue,
    ) as unknown as EntityInterfacesDefinition;
  }

  assertEntitySecurityOnlyNarrows(base as unknown as JsonObject, merged as unknown as JsonObject, origin);

  if (hidden.size > 0) {
    // A hidden collection takes its native collection Operations with it:
    // an insert or update endpoint on a field the subtype does not have
    // would reveal and change what "hidden" promises is absent. The base
    // keeps those Operations. Done after the narrowing check above, which
    // rightly refuses a patch that removes an Operation.
    const operations = { ...(merged.operations as Record<string, Record<string, unknown>> | undefined) };
    const removed = Object.entries(operations)
      .filter(([, operation]) => {
        const implementation = isPlainObject(operation.implementation) ? operation.implementation : undefined;
        return implementation?.type === "collection" && typeof implementation.field === "string" && hidden.has(implementation.field);
      })
      .map(([key]) => key);
    for (const key of removed) delete operations[key];
    merged.operations = operations;
    const interfaces = isPlainObject(merged.interfaces) ? { ...merged.interfaces } : undefined;
    for (const name of ["rest", "graphql", "mcp", "web"] as const) {
      const projection = interfaces && isPlainObject(interfaces[name]) ? { ...interfaces[name] } : undefined;
      if (!projection || !isPlainObject(projection.operations)) continue;
      projection.operations = Object.fromEntries(Object.entries(projection.operations).filter(([key]) => !removed.includes(key)));
      interfaces![name] = projection;
    }
    if (interfaces) merged.interfaces = interfaces;
    const leaked = findExplicitHiddenReference(
      { interfaces: subtype.interfaces, operations: subtype.operations, displayTemplate: subtype.displayTemplate, filterField: subtype.filterField },
      hidden,
      "",
    );
    if (leaked) fail(origin, `hidden field is referenced by the subtype's own configuration at ${leaked.replace(/^\./, "")}; hidden fields are absent from every interface.`);
    if (isPlainObject(merged.interfaces)) merged.interfaces = pruneInheritedInterfaces(merged.interfaces, hidden);
    assertInheritedContractOmitsHidden(merged, hidden, base, origin);
  }

  const scopeEntity = subtype.entity;
  merged.fields = (merged.fields as Field[]).map((field) =>
    Object.hasOwn(subtype.scope, field.key)
      ? { ...field, readOnly: true, writtenBy: [`${scopeEntity}.create`] }
      : field);

  return {
    ...(merged as unknown as CoreEntity),
    kind: "coreEntity",
    entity: subtype.entity,
    subtype: {
      base: base.entity,
      baseSlug: context.baseSlug,
      scope: { ...subtype.scope },
      hidden: [...hidden].sort(),
    },
  };
}

/** Inherited contract pieces that cannot be pruned and must not name a hidden field. */
function assertInheritedContractOmitsHidden(merged: Record<string, unknown>, hidden: ReadonlySet<string>, base: CoreEntity, origin: string): void {
  const naming = (what: string, key: string): never =>
    fail(origin, `hides ${key}, but ${what} of ${base.entity} refers to it; restate that part on the subtype without the hidden field.`);
  for (const key of templateFieldKeys(merged.displayTemplate as string | undefined)) if (hidden.has(key)) naming("displayTemplate", key);
  if (typeof merged.filterField === "string" && hidden.has(merged.filterField)) naming("filterField", merged.filterField);
  const web = isPlainObject(merged.interfaces) && isPlainObject(merged.interfaces.web) ? merged.interfaces.web : undefined;
  const record = web && isPlainObject(web.views) && isPlainObject(web.views.record) ? web.views.record : undefined;
  for (const templateKey of ["title", "subtitle"] as const) {
    for (const key of templateFieldKeys(record?.[templateKey] as string | undefined)) if (hidden.has(key)) naming(`interfaces.web.views.record.${templateKey}`, key);
  }
  const leakedView = web ? findExplicitHiddenReference({ views: web.views }, hidden, "interfaces.web") : undefined;
  if (leakedView) naming(leakedView, leakedView);
  const authorization = isPlainObject(merged.authorization) ? merged.authorization : undefined;
  const rowAccess = authorization && isPlainObject(authorization.rowAccess) ? authorization.rowAccess : undefined;
  if (rowAccess) {
    const acl = isPlainObject(rowAccess.recordPermissions) ? rowAccess.recordPermissions : undefined;
    if (acl && typeof acl.field === "string" && hidden.has(acl.field)) naming("authorization.rowAccess.recordPermissions.field", acl.field);
    for (const axis of ["owner", "group"] as const) {
      const policy = isPlainObject(rowAccess[axis]) ? rowAccess[axis] : undefined;
      if (policy && typeof policy.field === "string" && hidden.has(policy.field)) naming(`authorization.rowAccess.${axis}.field`, policy.field);
    }
  }
  for (const [key, operation] of Object.entries((merged.operations ?? {}) as Record<string, Record<string, unknown>>)) {
    const confirmation = isPlainObject(operation.confirmation) ? operation.confirmation : undefined;
    const challenge = confirmation && isPlainObject(confirmation.challenge) ? confirmation.challenge : undefined;
    if (challenge && typeof challenge.field === "string" && hidden.has(challenge.field)) naming(`operations.${key}.confirmation.challenge.field`, challenge.field);
    const concurrency = isPlainObject(operation.concurrency) ? operation.concurrency : undefined;
    const version = concurrency && isPlainObject(concurrency.version) ? concurrency.version : undefined;
    if (version && typeof version.field === "string" && hidden.has(version.field)) naming(`operations.${key}.concurrency.version.field`, version.field);
  }
  for (const field of merged.fields as Field[]) {
    if (hidden.has(field.key)) continue;
    const definition = field.typedBy?.definitionField ?? field.entityValue?.definitionField;
    if (definition && hidden.has(definition)) naming(`field ${field.key}`, definition);
    // The Document carrier of a typed value, where the field model declares
    // one: read structurally, so a compiler whose `typedBy` has no such
    // property composes the same subtypes without losing the guard here.
    const typedBy: unknown = field.typedBy;
    const documentField = isPlainObject(typedBy) ? typedBy.documentField : undefined;
    if (typeof documentField === "string" && hidden.has(documentField)) naming(`field ${field.key}`, documentField);
  }
}

const SCALAR_SCOPE_TYPES = new Set(["string", "integer", "number", "boolean"]);

/**
 * The typed rules, checked once the fields are normalized: a scope value fits
 * its field, and a hidden required column still has a value the server can
 * supply, so hiding a field never makes a create impossible.
 */
export function assertEntitySubtypeModel(entity: CoreEntity, _osfTypes: Record<string, OsfTypeDefinition>, origin: string): void {
  const subtype = entity.subtype;
  if (!subtype) return;
  const fields = new Map(entity.fields.map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(subtype.scope)) {
    const field = fields.get(key);
    if (!field) fail(origin, `scope.${key} does not exist on ${subtype.base}.`);
    const baseType = field.baseType;
    if (!baseType || !SCALAR_SCOPE_TYPES.has(baseType) || fieldCardinality(field) !== "single" || field.relationship) {
      fail(origin, `scope.${key} must be a single string, integer, number or boolean field; ${baseType ?? field.osfType} is not.`);
    }
    const fits = baseType === "string" ? typeof value === "string"
      : baseType === "boolean" ? typeof value === "boolean"
        : baseType === "integer" ? Number.isInteger(value)
          : typeof value === "number";
    if (!fits) fail(origin, `scope.${key} value ${JSON.stringify(value)} does not fit the ${baseType} field.`);
    const options = field.options;
    if (options?.type === "static" && Array.isArray(options.items) && !options.items.some((item) => item.value === value)) {
      fail(origin, `scope.${key} value ${JSON.stringify(value)} is not one of the field's static options.`);
    }
  }
  for (const key of subtype.hidden) {
    const field = fields.get(key);
    if (!field) fail(origin, `hidden field ${key} does not exist on ${subtype.base}.`);
    if (!field.persisted || !field.required) continue;
    const serverOwned = Object.hasOwn(subtype.scope, key) || field.defaultValue !== undefined || field.defaultTemplate !== undefined ||
      Boolean(field.writtenBy?.length) || field.computed !== undefined || field.deriveOnCreate !== undefined || INTRINSIC_FIELDS.has(key);
    if (!serverOwned) {
      fail(origin, `hides required field ${key}, which has no server-owned value (scope, defaultValue, defaultTemplate, writtenBy or derivation); a create through this subtype could never satisfy it.`);
    }
  }
}
