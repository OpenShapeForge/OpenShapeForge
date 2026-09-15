// SPDX-License-Identifier: BUSL-1.1
/** Repository cutover tooling, not a runtime compatibility layer. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const requireCompiler = createRequire(new URL("../packages/compiler/package.json", import.meta.url));
export const yaml = requireCompiler("yaml");
export type EntityDocument = Record<string, any>;
export type CorpusEntry = { path: string; document: EntityDocument };

/** Backfill interface metadata when resuming a partially applied cutover. */
export function restoreInterfaceMetadata(original: EntityDocument, migrated: EntityDocument): EntityDocument {
  const result = structuredClone(migrated);
  if (original.workflow && !result.interfaces?.workflow) (result.interfaces ??= {}).workflow = structuredClone(original.workflow);
  const visit = (fields: any[], prefix = "") => {
    for (const field of fields ?? []) {
      const path = prefix ? `${prefix}.${field.key}` : field.key;
      if (field.render) {
        const overrides = (((result.interfaces ??= {}).web ??= {}).fields ??= {});
        overrides[path] ??= { render: structuredClone(field.render) };
      }
      visit(field.children, path);
      if (field.item) visit([field.item], path);
    }
  };
  visit(original.fields);
  return result;
}

export function planMetadataRestoration(root: string, corpus: CorpusEntry[]): CorpusEntry[] {
  const changes: CorpusEntry[] = [];
  for (const entry of corpus) {
    if (entry.document?.kind !== "coreEntity" || entry.document.schemaVersion !== 3 || /^(Block|Template)/.test(entry.document.entity)) continue;
    let original: EntityDocument;
    try { original = yaml.parse(execFileSync("git", ["show", `HEAD:${entry.path}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }
    catch { continue; }
    if (![1, 2].includes(original.schemaVersion)) continue;
    const document = restoreInterfaceMetadata(original, entry.document);
    if (JSON.stringify(document) !== JSON.stringify(entry.document)) changes.push({ path: entry.path, document });
  }
  return changes;
}

/** Track both checked-in and newly authored examples/fixtures, irrespective of directory naming. */
export function readYamlCorpus(root: string): CorpusEntry[] {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
  return [...new Set(files.split("\0"))].filter(path => /\.ya?ml$/.test(path) && existsSync(join(root, path)))
    .sort().flatMap(path => {
      const source = readFileSync(join(root, path), "utf8");
      // Helm templates are not YAML until rendered. Never use that exception
      // for a source declaring an authoring coreEntity.
      if (path.includes("/templates/") && source.includes("{{-") && !source.includes("coreEntity")) return [];
      return yaml.parseAllDocuments(source).map(document => {
        if (document.errors.length) throw new Error(`${path}: ${document.errors[0]!.message}`);
        return { path, document: document.toJS() };
      });
    });
}

// No directory-wide legacy exemption: only genuine, individually documented
// legacy rejection fixtures may be added here. Production can never opt out.
export const LEGACY_REJECTION_FIXTURES: Readonly<Record<string, string>> = Object.freeze({});

export function checkCoreEntityV3(corpus: CorpusEntry[], exceptions = LEGACY_REJECTION_FIXTURES) {
  const failures: string[] = [];
  const entities = corpus.filter(entry => entry.document?.kind === "coreEntity");
  const isExempt = (path: string) => Object.hasOwn(exceptions, path) && path.includes("/__fixtures__/legacy-rejection/") && Boolean(exceptions[path]?.trim());
  for (const [path, reason] of Object.entries(exceptions)) {
    if (!path.includes("/__fixtures__/legacy-rejection/") || !reason.trim()) failures.push(`Invalid legacy rejection exemption: ${path}`);
    if (!entities.some(entry => entry.path === path && entry.document.schemaVersion !== 3)) failures.push(`Stale legacy rejection exemption: ${path}`);
  }
  for (const { path, document } of entities) {
    if (isExempt(path)) continue;
    if (document.schemaVersion !== 3) failures.push(`${path}: ${document.entity} uses schemaVersion ${document.schemaVersion}; require 3`);
    if (Object.hasOwn(document, "relationships")) failures.push(`${path}: ${document.entity} has legacy top-level relationships; use fields`);
  }
  return { total: entities.length, old: entities.filter(entry => entry.document.schemaVersion !== 3 && !isExempt(entry.path)).length, failures };
}

const slug = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const actions = ["list", "get", "create", "update", "delete"];

function migrateLegacyWeb(entity: EntityDocument, fail: (message: string) => never) {
  const ui = entity.ui;
  if (!ui) return;
  const { list, detail, form } = ui.presentations ?? {};
  if (!list || !ui.routes?.list) fail("Web collection route/columns are missing");
  const relationshipTabs: any[] = [];
  const extractRelationships = (groups: any[]) => {
    for (const group of groups ?? []) {
      for (const relation of group.relationships ?? []) {
        if (!relation.name || Object.keys(relation).some(key => key !== "name")) fail("Web relationship section needs an explicit layout mapping");
        relationshipTabs.push({ id: relation.name, relationship: relation.name });
      }
      delete group.relationships;
      extractRelationships(group.groups);
    }
  };
  extractRelationships(detail?.groups);
  const assertGroups = (groups: any[]) => {
    for (const group of groups ?? []) {
      if (Object.keys(group).some(key => !["id", "title", "label", "fields", "relationship", "groups"].includes(key))) fail("Web group contains unsupported presentation metadata");
      assertGroups(group.groups);
    }
  };
  assertGroups(detail?.groups); assertGroups(form?.variants?.create?.groups); assertGroups(form?.variants?.edit?.groups);
  const collection = { route: ui.routes.list, columns: list.columns, ...(list.title ? { title: list.title } : {}), ...(list.defaultSort ? { defaultSort: list.defaultSort } : {}) };
  if (list.rowLink && JSON.stringify(list.rowLink) !== JSON.stringify(ui.routes.detail)) fail("custom list rowLink is not the record route");
  const views: any = { collection };
  if (detail) {
    const opKeys: string[] = [];
    for (const action of detail.actions ?? []) {
      const key = action.route === "edit" ? "update" : action.mutation === "delete" ? "delete" : undefined;
      if (!key) fail(`custom Web action ${action.key} needs a canonical binding`);
      if (!entity.operations[key!]) continue; // CRUD-disabled actions were never exposed.
      const operation = entity.operations[key!];
      if (action.label) operation.name = action.label;
      if (action.confirm) {
        operation.confirmation = { mode: "acknowledgement" };
        operation.description = action.confirm;
      }
      opKeys.push(key!);
    }
    views.record = { routes: { ...(ui.routes.detail ? { read: ui.routes.detail } : {}), ...(ui.routes.create ? { create: ui.routes.create } : {}) },
      title: detail.header?.title ?? entity.displayTemplate, ...(detail.header?.subtitle ? { subtitle: detail.header.subtitle } : {}),
      ...(detail.header?.badges ? { badges: detail.header.badges } : {}),
      ...(form?.variableSources ? { variableSources: form.variableSources } : {}),
      actions: opKeys, layout: { tabs: [...(detail.groups ?? []), ...relationshipTabs] } };
    const modes: any = {};
    for (const [oldKey, newKey] of [["create", "create"], ["edit", "update"]]) {
      const variant = form?.variants?.[oldKey!];
      if (!variant) continue;
      if (variant.extends && variant.extends !== "create") fail(`unsupported form inheritance ${variant.extends}`);
      modes[newKey!] = { title: variant.title, ...(variant.groups ? { groups: variant.groups } : {}) };
    }
    if (Object.keys(modes).length) views.record.modes = modes;
  } else if (form) fail("form without record presentation needs explicit v3 layout");
  entity.interfaces.web = { views };
  delete entity.ui;
}

function migrateFieldPresentation(field: any, semanticTypes: Record<string, any>, fail: (message: string) => never, saved = false) {
  if (!field.render) return;
  const { component, props = {} } = field.render;
  if (component === "ReferenceSelect" && Object.keys(props).every(key => ["referentieGroep", "clearable"].includes(key))) {
    if (props.referentieGroep) {
      const options = { type: "referentiedata", referentieGroep: props.referentieGroep };
      if (field.options && JSON.stringify(field.options) !== JSON.stringify(options)) fail(`${field.key}: conflicting reference options`);
      field.options = options;
    }
    if (!field.semanticType) field.semanticType = "referenceDataCode";
  } else if (["Textarea", "InputMultiline"].includes(component) && Object.keys(props).every(key => ["rows", "maxLength"].includes(key))) {
    if (props.maxLength && field.validation?.maxLength !== props.maxLength) fail(`${field.key}: renderer maxLength differs from canonical validation`);
    if (!field.semanticType) field.semanticType = "multilineText";
  } else if ((component === "DatePicker" && field.valueType === "date" || component === "DateTimePicker" && field.valueType === "datetime") && !Object.keys(props).length) {
    // These are already the base-type registry defaults.
  } else if (component === "ListSelect" && field.options?.type === "static" && !Object.keys(props).length) {
    // Static field options select the canonical picker on every interface.
  } else if (component === "OptionVariablePicker" && semanticTypes[field.semanticType]?.kind === "entityId" && field.options?.type === "remote" && JSON.stringify(props) === JSON.stringify({ valueMode: "selectId" })) {
    // Existing entity-reference options already select an ID; the derived
    // entity semantic type supplies the canonical entity picker.
  } else if (semanticTypes[field.semanticType]?.render?.input === component && !Object.keys(props).length) {
    // Explicit default is redundant with the existing semantic catalog.
  } else if (!saved && !(component === "JsonFieldEditor" && field.valueType === "object" && !Object.keys(props).length)) fail(`${field.key}.render ${component} requires explicit semantic/interface mapping`);
  delete field.render;
}

/** Refuse lossy changes. Unsupported features are blockers, not deleted metadata. */
export function migrateCoreEntity(source: EntityDocument, corpus: EntityDocument[], semanticTypes: Record<string, any> = {}): EntityDocument {
  if (source.kind !== "coreEntity" || source.schemaVersion === 3) return structuredClone(source);
  const entity = structuredClone(source);
  const fail = (message: string): never => { throw new Error(`${entity.entity}: ${message}`); };
  if (![1, 2].includes(entity.schemaVersion)) fail("unknown authoring version");
  const byName = new Map(corpus.map(item => [item.entity, item]));
  const bySlug = new Map(corpus.map(item => [slug(item.entity), item]));
  const originalFields = (definition: EntityDocument) => definition.fields ?? [];
  const renamedRelationships = new Map<string, string>();
  const relationFieldKey = (definition: EntityDocument, relation: any) => originalFields(definition).find((field: any) => field.persisted?.column === relation.foreignKey)?.key ?? `${relation.key}Id`;
  if (entity.schemaVersion === 1) {
    for (const key of ["hooks", "permissions"]) if (entity[key] !== undefined) fail(`${key} needs an explicit, lossless v3 projection before migration`);
    const workflow = entity.workflow;
    delete entity.workflow;
    const enabled = actions.filter(action => entity.crud !== false && entity.crud?.enabled !== false && entity.crud?.operations?.[action] !== false);
    entity.operations = Object.fromEntries(enabled.map(action => [action, {
      name: `${action[0].toUpperCase()}${action.slice(1)} ${entity.title ?? entity.entity}`,
      description: `${action[0].toUpperCase()}${action.slice(1)} ${entity.entity} records.`,
      implementation: { type: "entity", action },
      effects: { data: ["list", "get"].includes(action) ? "read" : action === "delete" ? "delete" : "write", external: "none" },
      reliability: { idempotency: { mode: ["list", "get", "delete"].includes(action) ? "natural" : "none" } },
      confirmation: { mode: "none" },
    }]));
    // Legacy GraphQL is on by default; REST and MCP are explicit opt-ins.
    entity.interfaces = { graphql: {}, ...(workflow ? { workflow } : {}) };
    for (const name of ["rest", "mcp"]) {
      const old = entity[name];
      if (old && old.enabled !== false) {
        if (typeof old === "object" && Object.keys(old).some(key => !["enabled", "operations", "tools", "resource", ...(name === "mcp" ? ["elicitOnCreate"] : ["basePath"])].includes(key))) fail(`${name} has custom metadata without a lossless migration`);
        entity.interfaces[name] = typeof old === "object" ? Object.fromEntries(Object.entries(old).filter(([key]) => !["enabled", "elicitOnCreate"].includes(key))) : {};
        if (old.elicitOnCreate) {
          if (!entity.operations.create) fail("secure input requires an existing create operation");
          entity.operations.create.interaction = { type: "secureInput", ...old.elicitOnCreate };
        }
      }
      delete entity[name];
    }
    delete entity.crud;
    migrateLegacyWeb(entity, fail);
  }
  const visit = (fields: any[], prefix = "") => {
    for (const field of fields) {
      const path = prefix ? `${prefix}.${field.key}` : field.key;
      const presentation = field.render;
      if (presentation) ((entity.interfaces.web ??= {}).fields ??= {})[path] = { render: structuredClone(field.render) };
      migrateFieldPresentation(field, semanticTypes, fail, Boolean(presentation));
      const semantic = semanticTypes[field.semanticType];
      if (semantic?.kind === "entityId" && field.key !== "id" && !prefix) {
        const target = byName.get(semantic.entity) ?? bySlug.get(semantic.entity);
        if (!target) fail(`${field.key} references missing semantic entity ${semantic.entity}`);
        field.semanticType = target!.entity;
        // Do not weaken effective policy/validation inherited from the old alias.
        for (const key of ["classification", "audit", "authorization", "permissions", "immutable", "writtenBy"]) if (semantic[key] !== undefined && field[key] === undefined) field[key] = structuredClone(semantic[key]);
        if (semantic.validation) field.validation = { ...semantic.validation, ...field.validation };
      }
      if (field.children) visit(field.children, path);
      if (field.item) visit([field.item], path);
    }
  };
  visit(entity.fields ?? []);
  for (const relation of entity.relationships ?? []) {
    if (Object.keys(relation).some(key => !["key", "kind", "target", "foreignKey", "label", "via"].includes(key))) fail(`${relation.key}: unrecognized relationship metadata`);
    const target = byName.get(relation.target);
    if (!target) fail(`${relation.key}: missing target ${relation.target}`);
    if (relation.kind === "belongsTo") {
      const key = relationFieldKey(entity, relation);
      let field = entity.fields.find((field: any) => field.key === key);
      if (!field) {
        field = { key, ...(relation.label ? { label: relation.label } : {}), persisted: { column: relation.foreignKey, storageClass: "core" } };
        entity.fields.push(field);
      }
      field.semanticType = relation.target;
      delete field.valueType;
      field.relationship = { ownership: "reference" };
      if (relation.foreignKey === "tenant_id" && entity.authorization) field.readOnly = true;
      renamedRelationships.set(relation.key, key);
    } else if (relation.kind === "hasMany") {
      if (entity.fields.some((field: any) => field.key === relation.key)) fail(`${relation.key}: field/relationship collision`);
      const localRelation = relation.via ? source.relationships?.find((local: any) => local.key === relation.via && local.kind === "belongsTo") : undefined;
      if (relation.via && !localRelation) fail(`${relation.key}: via must identify a local single relationship`);
      const inverseRelation = target!.relationships?.find((inverse: any) => inverse.kind === "belongsTo" && inverse.foreignKey === relation.foreignKey && inverse.target === (localRelation?.target ?? entity.entity));
      const inverseField = target!.fields?.find((field: any) => field.persisted?.column === relation.foreignKey);
      const inverse = inverseRelation ? relationFieldKey(target!, inverseRelation) : inverseField?.key;
      if (!inverse) fail(`${relation.key}: missing inverse on ${relation.target}`);
      // All members of a connected collection pair must be migrated together.
      entity.fields.push({ key: relation.key, ...(relation.label ? { label: relation.label } : {}), semanticType: relation.target, cardinality: "collection", relationship: { inverse, ownership: "reference", ...(localRelation ? { via: relationFieldKey(entity, localRelation) } : {}) } });
    } else fail(`${relation.key}: unsupported relationship kind ${relation.kind}`);
  }
  delete entity.relationships;
  const rewriteRelationshipUses = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (typeof node.relationship === "string" && renamedRelationships.has(node.relationship)) node.relationship = renamedRelationships.get(node.relationship);
    if (Array.isArray(node.relationships)) node.relationships = node.relationships.map((key: any) => typeof key === "string" ? renamedRelationships.get(key) ?? key : key);
    for (const value of Object.values(node)) rewriteRelationshipUses(value);
  };
  rewriteRelationshipUses(entity.interfaces);
  entity.schemaVersion = 3;
  return entity;
}

export function planCoreEntityMigration(corpus: CorpusEntry[], semanticTypes: Record<string, any>) {
  const entities = corpus.filter(entry => entry.document?.kind === "coreEntity");
  const planned = new Map<string, CorpusEntry>();
  const blockers = new Map<string, string>();
  for (const entry of entities) {
    if (entry.document.schemaVersion === 3) continue;
    // These are concurrently owned by the main task, even if their version changes.
    if (/^(Block|Template)/.test(entry.document.entity)) { blockers.set(entry.path, "Main-owned Block/Template corpus"); continue; }
    try { planned.set(entry.path, { path: entry.path, document: migrateCoreEntity(entry.document, entities.map(item => item.document), semanticTypes) }); }
    catch (error) { blockers.set(entry.path, (error as Error).message); }
  }
  let removed: boolean;
  do {
    removed = false;
    const effective = new Map(entities.map(entry => [entry.document.entity, planned.get(entry.path)?.document ?? entry.document]));
    for (const [path, entry] of planned) {
      for (const field of entry.document.fields) {
        const inverse = field.relationship?.inverse;
        if (!inverse) continue;
        const target = effective.get(field.semanticType);
        const targetField = target?.fields?.find((item: any) => item.key === inverse);
        const inverseTarget = field.relationship?.via ? entry.document.fields.find((local: any) => local.key === field.relationship.via)?.semanticType : entry.document.entity;
        if (targetField?.semanticType !== inverseTarget) {
          blockers.set(path, `${entry.document.entity}.${field.key}: inverse ${field.semanticType}.${inverse} is not yet a canonical entity field`);
          planned.delete(path); removed = true; break;
        }
      }
    }
  } while (removed);
  return { planned: [...planned.values()], blockers: [...blockers].map(([path, reason]) => ({ path, reason })) };
}

/** Physical equivalence ignores compiler provenance, never columns/FKs/indexes. */
export function physicalTables(manifest: { tables: any[] }) {
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  return manifest.tables.map(({ source, ...table }) => canonical({ ...table,
    columns: table.columns.map(({ sourceField, ...column }: any) => column).sort((a: any, b: any) => a.name.localeCompare(b.name)),
    indexes: [...(table.indexes ?? [])].sort((a: any, b: any) => a.name.localeCompare(b.name)),
  })).sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`));
}
