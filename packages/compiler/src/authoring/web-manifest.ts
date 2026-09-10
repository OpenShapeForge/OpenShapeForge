// SPDX-License-Identifier: BUSL-1.1
/**
 * Web interface projection.
 *
 * This module turns resolved entity contracts into a transport-free manifest.
 * Browser applications consume the manifest through their own component and
 * operation adapters; API paths and design-system component names deliberately
 * do not cross this boundary.
 */
import type { CompiledEntityInfo } from "../plugins.js";
import type {
  CompiledEntityContract,
  CompiledField,
  CompiledFormVariant,
  CompiledViewContext,
  CompiledViewGroup,
  LocalizedText,
} from "./types.js";
import type {
  WebCollectionView,
  WebEntityInterface,
  WebFieldGroup,
  WebFieldProjection,
  WebFormView,
  WebManifestOptions,
  WebManifestV1,
  WebOperationIntent,
  WebOperationRef,
  WebRecordTab,
  WebRelationshipProjection,
  WebRendererKey,
} from "./web-manifest-contract.js";
export type * from "./web-manifest-contract.js";

const technicalFields = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "externalId",
  "sourceAuthority",
  "sourceOrganization",
  "sourceAdministration",
]);

function localized(value: string | Partial<LocalizedText> | undefined, fallback: string): LocalizedText {
  if (typeof value === "string") return { en: value, nl: value };
  return {
    en: value?.en ?? value?.nl ?? fallback,
    nl: value?.nl ?? value?.en ?? fallback,
  };
}

function contextFor(contract: CompiledEntityContract, preferred: string): CompiledViewContext | undefined {
  return contract.views[preferred]
    ?? Object.entries(contract.views).sort(([left], [right]) => left.localeCompare(right))[0]?.[1];
}

function operation(
  entity: string,
  intent: WebOperationIntent,
  enabled: boolean | undefined,
): WebOperationRef | undefined {
  return enabled ? { id: `${entity}.${intent}`, intent } : undefined;
}

function displayRenderer(field: CompiledField): WebRendererKey {
  if (field.key.toLocaleLowerCase("en").includes("status")) return "status";
  if (field.valueType === "boolean") return "boolean";
  if (["integer", "number"].includes(field.valueType)) return "number";
  if (field.valueType === "date") return "date";
  if (field.valueType === "datetime") return "datetime";
  return "text";
}

function editableRenderer(field: CompiledField): WebRendererKey {
  if (field.render.component === "Textarea") return "textarea";
  if (["ReferenceSelect", "EntityReferenceSelect"].includes(field.render.component)) return "reference";
  return displayRenderer(field) === "status" ? "text" : displayRenderer(field);
}

function fieldKeys(group: CompiledViewGroup): string[] {
  return (group.fields ?? []).flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    return entry.fieldDisplayMode === "hidden" ? [] : [entry.key];
  });
}

function projectGroups(groups: readonly CompiledViewGroup[] | undefined): WebFieldGroup[] {
  return (groups ?? []).flatMap((group) => {
    const projected = fieldKeys(group).length > 0
      ? [{ id: group.id, title: localized(group.title ?? group.label, group.id), fields: fieldKeys(group) }]
      : [];
    return [...projected, ...projectGroups(group.groups)];
  });
}

function formGroups(
  variant: CompiledFormVariant | undefined,
  fallback?: CompiledFormVariant,
): WebFieldGroup[] {
  if (!variant) return [];
  const groups = variant.groups.length > 0 ? variant.groups : fallback?.groups;
  return projectGroups(groups);
}

function defaultColumnKeys(contract: CompiledEntityContract): string[] {
  const candidates = contract.model.fields.filter(({ key }) => !technicalFields.has(key));
  const displayField = contract.entity.filterField;
  return [
    ...(displayField && candidates.some(({ key }) => key === displayField) ? [displayField] : []),
    ...candidates.map(({ key }) => key).filter((key) => key !== displayField),
  ].slice(0, 4);
}

function routeFor(
  contract: CompiledEntityContract,
  context: CompiledViewContext | undefined,
  routeLocale: "en" | "nl",
): string {
  const route = context?.routes.list;
  if (typeof route === "string") return route;
  if (route && typeof route === "object") {
    return route[routeLocale] ?? route.en ?? route.nl ?? `/${contract.rest!.basePath}`;
  }
  return `/${contract.rest!.basePath}`;
}

function collectionFor(
  entityName: string,
  contract: CompiledEntityContract,
  view: CompiledViewContext | undefined,
  listOperation: WebOperationRef,
): WebCollectionView {
  const list = view?.list;
  const fieldByKey = new Map(contract.model.fields.map((field) => [field.key, field]));
  const columnKeys = list?.columns.map(({ key }) => key) ?? defaultColumnKeys(contract);
  if (columnKeys.length === 0) columnKeys.push("id");
  const title = localized(list?.title ?? contract.entity.labels, contract.entity.title);
  return {
    id: `${entityName}.collection`,
    kind: "collection",
    operation: listOperation,
    title,
    searchPlaceholder: localized(
      list?.search.placeholder ?? { en: "Search...", nl: "Zoeken..." },
      "Search...",
    ),
    displayField: contract.entity.filterField ?? columnKeys[0]!,
    columns: columnKeys.map((key) => ({
      fieldId: `${entityName}.${key}`,
      key,
      label: localized(fieldByKey.get(key)?.label, key),
    })),
    ...(list?.defaultSort ? { defaultSort: list.defaultSort } : {}),
  };
}

type ProjectableEntity = {
  slug: string;
  contract: CompiledEntityContract;
  view?: CompiledViewContext;
  route: string;
  operations: Partial<Record<WebOperationIntent, WebOperationRef>>;
  collection: WebCollectionView;
};

function projectableEntities(
  entities: readonly Pick<CompiledEntityInfo, "slug" | "contract">[],
  options: Required<WebManifestOptions>,
): ProjectableEntity[] {
  return entities.flatMap(({ slug, contract }) => {
    if (!contract.rest?.operations.list) return [];
    const view = contextFor(contract, options.context);
    const operations = Object.fromEntries(
      (["list", "get", "create", "update", "delete"] as const)
        .map((intent) => [intent, operation(contract.entity.name, intent, contract.rest?.operations[intent])])
        .filter((entry): entry is [WebOperationIntent, WebOperationRef] => Boolean(entry[1])),
    );
    return [{
      slug,
      contract,
      ...(view ? { view } : {}),
      route: routeFor(contract, view, options.routeLocale),
      operations,
      collection: collectionFor(contract.entity.name, contract, view, operations.list!),
    }];
  }).sort((left, right) => left.contract.entity.name.localeCompare(right.contract.entity.name));
}

function projectForm(
  entityName: string,
  intent: "create" | "update",
  variant: CompiledFormVariant | undefined,
  groups: WebFieldGroup[],
  operationRef: WebOperationRef | undefined,
): WebFormView | undefined {
  if (!variant || !operationRef) return undefined;
  return {
    id: `${entityName}.${intent}.form`,
    kind: "form",
    intent,
    operation: operationRef,
    title: localized(variant.title, `${entityName} ${intent}`),
    groups,
    submitLabel: localized(variant.submit.label, intent === "create" ? "Create" : "Save"),
  };
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function projectEntity(
  source: ProjectableEntity,
  all: ReadonlyMap<string, ProjectableEntity>,
): WebEntityInterface {
  const { contract, view, operations } = source;
  const entityName = contract.entity.name;
  const createVariant = view?.form?.variants.create;
  const updateVariant = view?.form?.variants.edit;
  const createGroups = formGroups(createVariant);
  const updateGroups = formGroups(updateVariant, createVariant);
  const createFields = new Set(createGroups.flatMap(({ fields }) => fields));
  const updateFields = new Set(updateGroups.flatMap(({ fields }) => fields));
  const fields = Object.fromEntries(contract.model.fields.map((field) => {
    const display = displayRenderer(field);
    const projected: WebFieldProjection = {
      id: `${entityName}.${field.key}`,
      key: field.key,
      label: localized(field.label, field.key),
      description: localized(field.description, ""),
      valueType: field.valueType,
      ...(field.semanticType ? { semanticType: field.semanticType } : {}),
      cardinality: field.cardinality === "collection" ? "many" : "one",
      required: field.required,
      access: {
        read: true,
        create: !field.readOnly && createFields.has(field.key),
        update: !field.readOnly && !field.immutable && updateFields.has(field.key),
      },
      renderers: { display, readonly: display, editable: editableRenderer(field) },
      ...(field.render.props ? { rendererProps: field.render.props } : {}),
    };
    return [field.key, projected];
  }));

  const relationships = Object.fromEntries(contract.model.relationships.flatMap((relationship) => {
    const target = all.get(relationship.target);
    if (!target || !relationship.foreignKey) return [];
    const list = target.operations.list;
    const get = target.operations.get;
    const create = target.operations.create;
    const projected: WebRelationshipProjection = {
      id: `${entityName}.${relationship.key}`,
      key: relationship.key,
      label: localized(relationship.label, relationship.key),
      kind: relationship.kind,
      targetEntityId: target.contract.entity.name,
      targetRoute: target.route,
      foreignKey: relationship.foreignKey,
      recordField: snakeToCamel(relationship.foreignKey),
      operations: { ...(list ? { list } : {}), ...(get ? { get } : {}), ...(create ? { create } : {}) },
      ...(list ? { collection: { ...target.collection, id: `${target.contract.entity.name}.relationship.collection` } } : {}),
    };
    return [[relationship.key, projected]];
  }));

  const tabs: WebRecordTab[] = (view?.detail?.groups.items ?? []).flatMap((tab) => {
    const relationshipId = tab.relationship?.name;
    if (relationshipId && !relationships[relationshipId]) return [];
    return [{
      id: tab.id,
      label: localized(tab.label ?? tab.title, tab.id),
      groups: projectGroups(tab.groups),
      ...(relationshipId ? { relationshipId } : {}),
    }];
  });
  const overview = tabs.find(({ relationshipId }) => !relationshipId);
  const detail = view?.detail;
  const record = operations.get && detail ? {
    id: `${entityName}.record`,
    kind: "record" as const,
    preset: "inbox-main-context" as const,
    load: operations.get,
    titleTemplate: detail.header.title ?? `{{${source.collection.displayField}}}`,
    ...(detail.header.subtitle ? { subtitleTemplate: detail.header.subtitle } : {}),
    tabs,
    context: {
      groups: overview?.groups.slice(0, 1) ?? [],
      relationships: Object.values(relationships)
        .filter(({ kind }) => kind === "belongsTo")
        .map(({ key }) => key),
    },
    actions: {
      ...(operations.update && detail.actions?.some(({ key }) => key === "edit")
        ? { update: operations.update }
        : {}),
      ...(operations.delete && detail.actions?.some(({ mutation }) => mutation === "delete")
        ? { delete: operations.delete }
        : {}),
    },
  } : undefined;
  const create = projectForm(entityName, "create", createVariant, createGroups, operations.create);
  const update = projectForm(entityName, "update", updateVariant, updateGroups, operations.update);

  return {
    entityId: entityName,
    entitySlug: source.slug,
    route: source.route,
    title: source.collection.title,
    fields,
    operations,
    collection: source.collection,
    ...(record ? { record } : {}),
    ...(create ? { create } : {}),
    ...(update ? { update } : {}),
    relationships,
  };
}

/** Project resolved entity contracts into the versioned browser interface contract. */
export function buildWebManifest(
  entities: readonly Pick<CompiledEntityInfo, "slug" | "contract">[],
  options: WebManifestOptions = {},
): WebManifestV1 {
  const resolved: Required<WebManifestOptions> = {
    locale: options.locale ?? "en",
    context: options.context ?? "core",
    routeLocale: options.routeLocale ?? options.locale ?? "en",
  };
  const projectable = projectableEntities(entities, resolved);
  const byName = new Map(projectable.map((entity) => [entity.contract.entity.name, entity]));
  const projected = projectable.map((entity) => projectEntity(entity, byName));
  return {
    contract: "openshapeforge.web-manifest",
    version: 1,
    locale: resolved.locale,
    entities: Object.fromEntries(projected.map((entity) => [entity.entityId, entity])),
  };
}

/** Stable JSON representation for generated artifacts and deterministic checks. */
export function renderWebManifest(manifest: WebManifestV1): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
