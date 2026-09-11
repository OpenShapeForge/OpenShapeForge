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
  CompiledEntityOperation,
  CompiledField,
  CompiledFormVariant,
  CompiledViewContext,
  CompiledViewGroup,
  LocalizedText as CompiledLocalizedText,
} from "./types.js";
import type {
  LocalizedText as WebLocalizedText,
  WebCollectionView,
  WebEntityInterface,
  WebFieldGroup,
  WebFieldProjection,
  WebManifestOptions,
  WebManifestV1,
  WebOperationIntent,
  WebOperationRef,
  WebRecordTab,
  WebRelationshipProjection,
  WebViewMode,
} from "@openshapeforge/interface-web";
export type * from "@openshapeforge/interface-web";

const technicalFields = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "externalId",
  "sourceAuthority",
  "sourceOrganization",
  "sourceAdministration",
]);

function localized(
  value: string | Partial<CompiledLocalizedText> | undefined,
  fallback: string,
): WebLocalizedText {
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
  source: CompiledEntityOperation | undefined,
): WebOperationRef | undefined {
  return source ? { id: source.id, intent: source.intent } : undefined;
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

function projectTabGroups(tab: CompiledViewGroup): WebFieldGroup[] {
  const ownFields = fieldKeys(tab);
  return [
    ...(ownFields.length > 0
      ? [{ id: tab.id, title: localized(tab.title ?? tab.label, tab.id), fields: ownFields }]
      : []),
    ...projectGroups(tab.groups),
  ];
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
  slug: string,
  context: CompiledViewContext | undefined,
  routeLocale: "en" | "nl",
): string {
  const fallback = `/${contract.rest?.basePath ?? slug}`;
  const route = context?.routes?.list;
  if (typeof route === "string") return route;
  if (route && typeof route === "object") {
    return route[routeLocale] ?? route.en ?? route.nl ?? fallback;
  }
  return fallback;
}

function collectionFor(
  entityName: string,
  contract: CompiledEntityContract,
  view: CompiledViewContext | undefined,
  route: string,
  listOperation: WebOperationRef,
  createOperation: WebOperationRef | undefined,
): WebCollectionView {
  const list = view?.list;
  const fieldByKey = new Map(contract.model.fields.map((field) => [field.key, field]));
  const columnKeys = list?.columns.map(({ key }) => key) ?? defaultColumnKeys(contract);
  if (columnKeys.length === 0) columnKeys.push("id");
  const title = localized(list?.title ?? contract.entity.labels, contract.entity.title);
  return {
    id: `${entityName}.collection`,
    kind: "collection",
    renderer: "entity.collection",
    modes: ["read"],
    route,
    operations: {
      read: listOperation,
      ...(createOperation ? { create: createOperation } : {}),
    },
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
    if (!contract.entityOperations.list) return [];
    const view = contextFor(contract, options.context);
    const operations = Object.fromEntries(
      (["list", "get", "create", "update", "delete"] as const)
        .map((intent) => [
          intent,
          operation(contract.entityOperations[intent]),
        ])
        .filter((entry): entry is [WebOperationIntent, WebOperationRef] => Boolean(entry[1])),
    );
    return [{
      slug,
      contract,
      ...(view ? { view } : {}),
      route: routeFor(contract, slug, view, options.routeLocale),
      operations,
      collection: collectionFor(
        contract.entity.name,
        contract,
        view,
        routeFor(contract, slug, view, options.routeLocale),
        operations.list!,
        operations.create,
      ),
    }];
  }).sort((left, right) => left.contract.entity.name.localeCompare(right.contract.entity.name));
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
    const projected: WebFieldProjection = {
      id: `${entityName}.${field.key}`,
      key: field.key,
      label: localized(field.label, field.key),
      description: localized(field.description, ""),
      valueType: field.valueType,
      ...(field.semanticType ? { semanticType: field.semanticType } : {}),
      ...(field.variables ? { variables: field.variables } : {}),
      ...(field.suggestions ? { suggestions: field.suggestions } : {}),
      ...(field.options?.items?.length
        ? {
            options: field.options.items.map(({ value, label }) => ({
              value,
              label: localized(label, value),
            })),
          }
        : {}),
      cardinality: field.cardinality === "collection" ? "many" : "one",
      required: field.required,
      supports: {
        read: true,
        create: !field.readOnly && createFields.has(field.key),
        update: !field.readOnly && !field.immutable && updateFields.has(field.key),
      },
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
      groups: projectTabGroups(tab),
      ...(relationshipId ? { relationshipId } : {}),
    }];
  });
  const overview = tabs.find(({ relationshipId }) => !relationshipId);
  const detail = view?.detail;
  const modes: WebViewMode[] = [
    ...(operations.get && detail ? ["read" as const] : []),
    ...(operations.create && createVariant ? ["create" as const] : []),
    ...(operations.update && updateVariant ? ["update" as const] : []),
  ];
  const fallbackGroups = updateGroups.length > 0 ? updateGroups : createGroups;
  const recordTabs = tabs.length > 0
    ? tabs
    : fallbackGroups.length > 0
      ? [{ id: "main", label: localized(undefined, "Details"), groups: fallbackGroups }]
      : [];
  const record = modes.length > 0 ? {
    id: `${entityName}.record`,
    kind: "record" as const,
    renderer: "entity.record" as const,
    preset: "inbox-main-context" as const,
    modes,
    routes: {
      ...(modes.includes("read") ? { read: `${source.route}/:id` } : {}),
      ...(modes.includes("create") ? { create: `${source.route}/new` } : {}),
    },
    operations: {
      ...(modes.includes("read") ? { read: operations.get } : {}),
      ...(modes.includes("create") ? { create: operations.create } : {}),
      ...(modes.includes("update") ? { update: operations.update } : {}),
      ...(operations.delete && detail?.actions?.some(({ mutation }) => mutation === "delete")
        ? { delete: operations.delete }
        : {}),
    },
    titleTemplate: detail?.header.title ?? `{{${source.collection.displayField}}}`,
    ...(detail?.header.subtitle ? { subtitleTemplate: detail.header.subtitle } : {}),
    layout: {
      tabs: recordTabs,
      context: {
        groups: overview?.groups.slice(0, 1) ?? fallbackGroups.slice(0, 1),
        relationships: Object.values(relationships)
          .filter(({ kind }) => kind === "belongsTo")
          .map(({ key }) => key),
      },
    },
    ...(view?.form?.variableSources?.length
      ? { variableSources: view.form.variableSources }
      : {}),
    labels: {
      ...(createVariant
        ? {
            createTitle: localized(createVariant.title, `${entityName} create`),
            createSubmit: localized(createVariant.submit.label, "Create"),
          }
        : {}),
      ...(updateVariant
        ? {
            updateTitle: localized(updateVariant.title, `${entityName} update`),
            updateSubmit: localized(updateVariant.submit.label, "Save"),
          }
        : {}),
    },
  } : undefined;

  return {
    entityId: entityName,
    entitySlug: source.slug,
    title: source.collection.title,
    fields,
    operations,
    views: {
      collection: source.collection,
      ...(record ? { record } : {}),
    },
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
