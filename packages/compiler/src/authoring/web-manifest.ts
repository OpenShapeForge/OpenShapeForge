// SPDX-License-Identifier: BUSL-1.1
import { collectBlueprintOperations } from "../blueprint-operations.js";
/**
 * Web interface projection.
 *
 * This module turns resolved entity contracts into a transport-free manifest.
 * Browser applications consume the manifest through their own component and
 * operation adapters; API paths and design-system component names deliberately
 * do not cross this boundary.
 */
import { missingLocalizedMetadata, missingSchemaUiTranslations, missingUiTranslations } from "@openshapeforge/interface-web";
import type { CompiledEntityInfo, CompiledPluginOperation } from "../plugins.js";
import { moduleOperationId } from "./operation-catalog.js";
import type { CoreReferentiedataSnapshot } from "../core-referentiedata-artifacts.js";
import { assertEntityValueDefinition } from "./entity-values.js";
import { materializeCollectionOperations } from "./collection-operations.js";
import { constrainedReferenceCreateOperationId } from "../generate-operations.js";
import { fieldOptionSource } from "./web-field-options.js";
import type {
  CompiledEntityContract,
  CompiledEntityOperation,
  CompiledField,
  CompiledFormVariant,
  CompiledViewContext,
  CompiledViewGroup,
  LocalizedText as CompiledLocalizedText,
  OperationCatalogDefinition,
} from "./types.js";
import type {
  LocalizedText as WebLocalizedText,
  WebCollectionQueryContract,
  WebCollectionView,
  WebCustomOperationRef,
  WebEntityInterface,
  WebFieldGroup,
  WebFieldProjection,
  WebManifestOptions,
  WebManifestV1,
  WebOperationIntent,
  WebOperationRef,
  WebPage,
  WebRecordTab,
  WebRelationshipProjection,
  WebStandaloneOperationRef,
  WebViewMode,
} from "@openshapeforge/interface-web";
export type * from "@openshapeforge/interface-web";

/**
 * Standalone Operation catalogs as authored, paired with the contracts the
 * compiler lowered them to. Both halves are needed: the authored side holds
 * the bilingual names, the business input schema and the page placement; the
 * compiled side holds the resolved REST address and the auth the runtime
 * enforces, so the manifest cannot drift from what the API actually serves.
 */
export type WebStandaloneOperationsInput = {
  catalogs: readonly OperationCatalogDefinition[];
  operations: readonly CompiledPluginOperation[];
};

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
  contract: CompiledEntityContract,
): WebOperationRef | undefined {
  if (!source) return undefined;
  if (source.implementation.type === "entity") {
    if (source.intent === "list") {
      if (source.input.kind !== "collection-query") {
        throw new Error(
          `Entity list Operation "${source.id}" has no collection-query input.`,
        );
      }
      const secureInputTarget = contract.entityOperations.create
        ?.interaction.secureInput?.into;
      const queryFields = contract.model.fields
        .filter((field) =>
          field.key !== secureInputTarget &&
          field.cardinality !== "collection" &&
          field.baseType !== "object"
        )
        .map((field) => field.key);
      for (const relationship of contract.model.relationships) {
        if (relationship.kind !== "belongsTo" || !relationship.foreignKey) continue;
        const column = contract.storage.columns.find(
          (candidate) => candidate.column === relationship.foreignKey,
        );
        const key = column?.field ?? snakeToCamel(relationship.foreignKey);
        if (!queryFields.includes(key)) queryFields.push(key);
      }
      return {
        id: source.id,
        intent: "list",
        input: {
          kind: "collection-query",
          filterFields: queryFields,
          sortFields: queryFields,
          pagination: source.input.pagination,
        },
      };
    }
    return {
      id: source.id,
      intent: source.intent,
      ...(source.concurrency ? { concurrency: source.concurrency } : {}),
      ...(source.prerequisites ? { prerequisites: source.prerequisites } : {}),
    };
  }
  if (
    (source.intent !== "create" && source.intent !== "update" && source.intent !== "delete") ||
    source.input.kind !== "json-schema" || source.output.kind !== "json-schema" ||
    !source.target
  ) {
    throw new Error(
      `Plugin-backed entity Operation "${source.id}" has an incomplete Web contract.`,
    );
  }
  const rest = source.interfaces?.rest;
  return {
    id: source.id,
    intent: source.intent,
    key: source.key,
    name: localized(source.name, source.key),
    description: localized(source.description, ""),
    implementation: source.implementation,
    target: source.target,
    input: source.input,
    output: source.output,
    effects: source.effects,
    reliability: source.reliability,
    ...(source.concurrency ? { concurrency: source.concurrency } : {}),
    ...(source.prerequisites ? { prerequisites: source.prerequisites } : {}),
    confirmation: source.interaction.confirmation,
    ...(rest !== false && rest?.path
      ? {
          rest: {
            method: rest.method ?? (source.intent === "create"
              ? "POST"
              : source.intent === "delete"
                ? "DELETE"
                : "PATCH"),
            path: rest.path,
            response: rest.response ?? { kind: "json" },
          },
        }
      : {}),
  };
}

function kebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function customOperation(
  source: NonNullable<CompiledEntityContract["pluginOperations"]>[number],
): WebCustomOperationRef | undefined {
  if (source.interfaces.web === false) return undefined;
  const definition = source.definition;
  if ((definition.implementation.type !== "plugin" && definition.implementation.type !== "collection") || !definition.target ||
    !definition.input || !definition.output) return undefined;
  const rest = source.interfaces.rest;
  return {
    id: source.id,
    intent: "invoke",
    key: source.key,
    name: localized(definition.name, source.key),
    description: localized(definition.description, ""),
    target: {
      entityId: source.entityId,
      entityName: source.entityName,
      scope: definition.target.scope,
      ...(definition.target.scope === "record"
        ? { inputField: definition.target.inputField }
        : {}),
    },
    input: { kind: "json-schema", schema: definition.input.schema },
    output: { kind: "json-schema", schema: definition.output.schema },
    ...(source.interfaces.web?.resultRenderer ? { resultRenderer: source.interfaces.web.resultRenderer } : {}),
    effects: definition.effects,
    reliability: {
      idempotency: {
        mode: definition.reliability.idempotency.mode,
        ...(definition.reliability.idempotency.inputField
          ? { inputField: definition.reliability.idempotency.inputField }
          : {}),
      },
    },
    ...(definition.concurrency ? { concurrency: definition.concurrency } : {}),
    confirmation: definition.confirmation,
    ...(rest !== false && rest !== undefined
      ? {
          rest: {
            method: rest.method ?? (definition.effects.data === "read" ? "GET" : "POST"),
            path: rest.path ??
              `/api/${definition.implementation.type === "collection" ? "core" : definition.implementation.plugin}/${kebab(source.entityName)}` +
                `${definition.target.scope === "record" ? `/:${definition.target.inputField}` : ""}` +
                `/${kebab(source.key)}`,
            response: rest.response ?? { kind: "json" as const },
          },
        }
      : {}),
  };
}

function fieldKeys(
  group: CompiledViewGroup,
  excluded: ReadonlySet<string> = new Set(),
): string[] {
  return (group.fields ?? []).flatMap((entry) => {
    if (typeof entry === "string") return excluded.has(entry) ? [] : [entry];
    return entry.fieldDisplayMode === "hidden" || excluded.has(entry.key)
      ? []
      : [entry.key];
  });
}

function projectGroups(
  groups: readonly CompiledViewGroup[] | undefined,
  excluded: ReadonlySet<string> = new Set(),
): WebFieldGroup[] {
  return (groups ?? []).flatMap((group) => {
    const keys = fieldKeys(group, excluded);
    const projected = keys.length > 0
      ? [{ id: group.id, title: localized(group.title ?? group.label, group.id), fields: keys }]
      : [];
    return [...projected, ...projectGroups(group.groups, excluded)];
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
  excluded: ReadonlySet<string> = new Set(),
): WebFieldGroup[] {
  if (!variant) return [];
  const groups = variant.groups.length > 0 ? variant.groups : fallback?.groups;
  return projectGroups(groups, excluded);
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

function projectedRoute(
  route: string | Partial<CompiledLocalizedText> | undefined,
  routeLocale: "en" | "nl",
  fallback: string,
): string {
  if (typeof route === "string") return route;
  return route?.[routeLocale] ?? route?.en ?? route?.nl ?? fallback;
}

function collectionFor(
  entityName: string,
  contract: CompiledEntityContract,
  view: CompiledViewContext | undefined,
  route: string,
  listOperation: WebOperationRef,
  createOperation: WebOperationRef | undefined,
  customOperations: Readonly<Record<string, WebCustomOperationRef>> = {},
  actionKeys: readonly string[] = [],
): WebCollectionView {
  const list = view?.list;
  const fieldByKey = new Map(contract.model.fields.map((field) => [field.key, field]));
  const columnKeys = list?.columns.map(({ key }) => key) ?? defaultColumnKeys(contract);
  if (columnKeys.length === 0) columnKeys.push("id");
  const title = localized(list?.title ?? contract.entity.labels, contract.entity.title);
  return {
    id: `${entityName}.collection`,
    kind: "collection",
    renderer: contract.interfaces?.web?.renderers?.collection ?? "entity.collection",
    modes: ["read"],
    route,
    operations: {
      read: listOperation,
      ...(createOperation ? { create: createOperation } : {}),
      ...(actionKeys.length > 0
        ? {
            actions: actionKeys.flatMap((key) =>
              customOperations[key] ? [customOperations[key]!] : []
            ),
          }
        : {}),
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
      label: localized(list?.columns.find(column => column.key === key)?.label ?? fieldByKey.get(key)?.label, key),
    })),
    ...(list?.defaultSort ? { defaultSort: list.defaultSort } : {}),
  };
}

type ProjectableEntity = {
  slug: string;
  contract: CompiledEntityContract;
  view?: CompiledViewContext;
  route: string;
  routeLocale: "en" | "nl";
  operations: Partial<Record<WebOperationIntent, WebOperationRef>>;
  customOperations: Record<string, WebCustomOperationRef>;
  collection: WebCollectionView;
};

function projectableEntities(
  entities: readonly Pick<CompiledEntityInfo, "slug" | "contract">[],
  options: Required<WebManifestOptions>,
): ProjectableEntity[] {
  return entities.flatMap(({ slug, contract }) => {
    if (contract.entity.valueDefinition) return [];
    if (contract.authoringVersion === 1 && !contract.rest) return [];
    const exposed = contract.authoringVersion >= 2
      ? contract.interfaces?.web?.operations
      : undefined;
    if (!contract.entityOperations.list || (contract.authoringVersion >= 2 && !exposed?.list)) return [];
    const view = contextFor(contract, options.context);
    const operations = Object.fromEntries(
      (["list", "get", "create", "update", "delete"] as const)
        .map((intent) => [
          intent,
          operation(
            exposed && exposed[intent] !== true
              ? undefined
              : contract.entityOperations[intent],
            contract,
          ),
        ])
        .filter((entry): entry is [WebOperationIntent, WebOperationRef] => Boolean(entry[1])),
    );
    const customOperations = Object.fromEntries(
      (contract.pluginOperations ?? []).flatMap((source) => {
        const projected = customOperation(source);
        return projected ? [[source.key, projected]] : [];
      }),
    );
    return [{
      slug,
      contract,
      ...(view ? { view } : {}),
      route: routeFor(contract, slug, view, options.routeLocale),
      routeLocale: options.routeLocale,
      operations,
      customOperations,
      collection: collectionFor(
        contract.entity.name,
        contract,
        view,
        routeFor(contract, slug, view, options.routeLocale),
        operations.list!,
        operations.create,
        customOperations,
        contract.interfaces?.web?.collectionActions,
      ),
    }];
  }).sort((left, right) => left.contract.entity.name.localeCompare(right.contract.entity.name));
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function projectedTextLength(field: CompiledField): { maxLength?: number } {
  const rule = field.validation?.maxLength;
  const value = typeof rule === "object" ? rule.value : rule;
  return typeof value === "number" ? { maxLength: value } : {};
}

/** Logical fields shared by record screens and collection-scoped value editors. */
function projectField(
  field: CompiledField,
  parent: string,
  supports: WebFieldProjection["supports"],
  editNested = false,
  presentations: Record<string, { render: NonNullable<WebFieldProjection["presentation"]> }> = {},
): WebFieldProjection {
  const nestedSupports = editNested ? supports : { read: true, create: false, update: false };
  const presentation = presentations[`${parent}.${field.key}`.split(".").slice(1).join(".")]?.render;
  const optionSource = fieldOptionSource(field);
  return {
    id: `${parent}.${field.key}`, key: field.key,
    label: localized(field.label, field.key), description: localized(field.description, ""),
    osfType: field.osfType,
    baseType: field.baseType,
    cardinality: field.cardinality === "collection" ? "many" : "one",
    required: field.required,
    ...(presentation ? { presentation } : {}),
    ...projectedTextLength(field),
    ...(field.relationship?.target ? { relationship: {
      targetEntityId: field.relationship.target,
      ...(field.relationship.constraints ? { constraints: structuredClone(field.relationship.constraints) } : {}),
      ...(field.relationship.constraints
        ? { createOperation: { id: constrainedReferenceCreateOperationId(parent.split(".")[0]!, field.key), intent: "invoke" as const } }
        : {}),
    } } : {}),
    ...(field.variables ? { variables: field.variables } : {}),
    ...(field.suggestions ? { suggestions: field.suggestions } : {}),
    ...(field.visibility ? { visibility: field.visibility } : {}),
    ...(field.entityValue ? { entityValue: { ...field.entityValue } } : {}),
    ...(field.allowedDefinitions ? { allowedDefinitions: [...field.allowedDefinitions].sort() } : {}),
    ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
    ...(field.options?.items?.length ? { options: field.options.items.map(({ value, label }) => ({ value, label: localized(label, value) })) } : {}),
    ...(optionSource ? { optionSource } : {}),
    ...(field.children ? { children: field.children.map((child) => projectField(child, `${parent}.${field.key}`, nestedSupports, editNested, presentations)) } : {}),
    ...(field.item ? { item: projectField(field.item, `${parent}.${field.key}`, nestedSupports, editNested, presentations) } : {}),
    supports: {
      read: supports.read,
      create: supports.create && !field.readOnly && !field.deriveOnCreate,
      update: supports.update && !field.readOnly && !field.immutable && !field.deriveOnCreate,
    },
  };
}

function unsupportedGenericCreate(source: ProjectableEntity, all: ReadonlyMap<string, ProjectableEntity>): boolean {
  const { contract } = source;
  if (contract.entityOperations.create?.implementation.type !== "entity") return false;
  if (contract.model.relationships.some((relationship) => relationship.fieldKey && relationship.kind !== "belongsTo" &&
    relationship.ownership === "owned" &&
    typeof relationship.cardinality === "object" && (relationship.cardinality.min ?? 0) > 0)) return true;
  return [...all.values()].some((owner) => owner.contract.model.relationships.some((relationship) =>
    relationship.fieldKey && !relationship.through && relationship.kind === "hasMany" && relationship.target === contract.entity.name &&
    relationship.ownership === "owned" &&
    (relationship.sortable || contract.storage.columns.some((column) => column.column === relationship.foreignKey && !column.nullable))));
}

function withoutCreate<T extends { create?: unknown }>(operations: T): Omit<T, "create"> {
  const { create: _create, ...rest } = operations;
  return rest;
}

/**
 * A relationship whose target is provider-backed: nothing is joined, the
 * target's list/get Operations run with the bound record fields as input.
 */
function projectProviderRelationship(
  entityName: string,
  relationship: CompiledEntityContract["model"]["relationships"][number],
  providers: ReadonlyMap<string, WebEntityInterface>,
  fields: Record<string, unknown>,
): [string, WebRelationshipProjection][] {
  const origin = `${entityName}.${relationship.key}`;
  const provider = providers.get(relationship.target);
  if (!provider) throw new Error(`${origin}: provider entity ${relationship.target} is not projected to the web.`);
  const bindings = relationship.provider!.bindings;
  const list = provider.views.collection.operations.read;
  const get = provider.views.record?.operations.read;
  const input = objectProperties("input" in list && list.input?.kind === "json-schema" ? list.input.schema : undefined);
  for (const [inputField, ownField] of Object.entries(bindings)) {
    if (!input[inputField]) throw new Error(`${origin}: provider.bindings.${inputField} is not an input of ${list.id}.`);
    if (!fields[ownField]) throw new Error(`${origin}: provider.bindings.${inputField} names unknown field ${entityName}.${ownField}.`);
  }
  return [[relationship.key, {
    id: origin,
    key: relationship.key,
    label: localized(relationship.label, relationship.key),
    kind: relationship.kind,
    targetEntityId: provider.entityId,
    targetRoute: provider.views.collection.route,
    ...(relationship.fieldKey ? { fieldKey: relationship.fieldKey } : {}),
    ...(relationship.cardinality ? { cardinality: relationship.cardinality } : {}),
    source: { kind: "provider", bindings: { ...bindings } },
    operations: { list, ...(get ? { get } : {}) },
    collection: { ...provider.views.collection, id: `${provider.entityId}.relationship.collection` },
  }]];
}

function projectEntity(
  source: ProjectableEntity,
  all: ReadonlyMap<string, ProjectableEntity>,
  providers: ReadonlyMap<string, WebEntityInterface> = new Map(),
): WebEntityInterface {
  const { contract, view, customOperations } = source;
  const createUnsupported = unsupportedGenericCreate(source, all);
  const operations: ProjectableEntity["operations"] = createUnsupported ? withoutCreate(source.operations) : source.operations;
  const entityName = contract.entity.name;
  const createVariant = view?.form?.variants.create;
  const updateVariant = view?.form?.variants.edit;
  const serverOwnedFields = new Set(
    contract.entityOperations.create?.interaction.secureInput?.into
      ? [contract.entityOperations.create.interaction.secureInput.into]
      : [],
  );
  for (const field of contract.model.fields) {
    if (field.deriveOnCreate) serverOwnedFields.add(field.key);
  }
  for (const relationship of contract.model.relationships) {
    if (relationship.fieldKey && relationship.kind !== "belongsTo") serverOwnedFields.add(relationship.fieldKey);
  }
  for (const owner of all.values()) {
    for (const relationship of owner.contract.model.relationships) {
      if (!relationship.fieldKey || relationship.through || relationship.kind !== "hasMany" ||
        relationship.target !== entityName || relationship.ownership !== "owned") continue;
      const inverse = contract.storage.columns.find((column) => column.column === relationship.foreignKey);
      if (inverse) serverOwnedFields.add(inverse.field);
    }
  }
  const createGroups = createUnsupported ? [] : formGroups(createVariant, undefined, serverOwnedFields);
  const authoredCreateGroups = formGroups(createVariant, undefined, serverOwnedFields);
  const updateGroups = formGroups(updateVariant, createVariant, serverOwnedFields);
  const createFields = new Set(createGroups.flatMap(({ fields }) => fields));
  const updateFields = new Set(updateGroups.flatMap(({ fields }) => fields));
  // A provider-backed reference is only a relationship: it has no value of its
  // own to read or write, so it is not a field on any interface.
  const providerFieldKeys = new Set(contract.model.relationships.flatMap((relationship) => relationship.provider && relationship.fieldKey ? [relationship.fieldKey] : []));
  const explicitFields = contract.model.fields.filter((field) => !providerFieldKeys.has(field.key)).map((field) => {
    const projected = projectField(field, entityName, {
        read: true,
        create: !field.readOnly && !field.deriveOnCreate && createFields.has(field.key),
        update: !field.readOnly && !field.immutable && !field.deriveOnCreate && updateFields.has(field.key),
    }, false, contract.interfaces?.web?.fields);
    return [field.key, projected] as const;
  });
  // Every single entity reference is an authored field, so its writability and
  // presentation are projected above; relationships add no implicit fields.
  const fields = Object.fromEntries(explicitFields);

  const relationships = Object.fromEntries(contract.model.relationships.flatMap((relationship) => {
    if (relationship.provider) return projectProviderRelationship(entityName, relationship, providers, fields);
    const target = all.get(relationship.target);
    if (!target || (!relationship.foreignKey && !relationship.via)) return [];
    const list = target.operations.list;
    const get = target.operations.get;
    const create = target.operations.create;
    const definitions = contract.model.fields.find((field) => field.key === (relationship.fieldKey ?? relationship.key))?.allowedDefinitions;
    const nativeOperations: Pick<WebRelationshipProjection["operations"], "insert" | "move" | "update" | "remove"> = {};
    for (const operation of contract.pluginOperations ?? []) {
      const binding = operation.definition.implementation;
      const projectedOperation = customOperations[operation.key];
      if (binding.type === "collection" && binding.field === relationship.fieldKey && projectedOperation) {
        nativeOperations[binding.action] = projectedOperation;
      }
    }
    const projected: WebRelationshipProjection = {
      id: `${entityName}.${relationship.key}`,
      key: relationship.key,
      label: localized(relationship.label, relationship.key),
      kind: relationship.kind,
      targetEntityId: target.contract.entity.name,
      targetRoute: target.route,
      ...(relationship.foreignKey ? {
        foreignKey: relationship.foreignKey,
        recordField: (relationship.kind === "belongsTo" ? contract : target.contract).storage.columns.find((column) => column.column === relationship.foreignKey)?.field ?? snakeToCamel(relationship.foreignKey),
      } : {}),
      ...(relationship.fieldKey ? { fieldKey: relationship.fieldKey } : {}),
      ...(definitions ? { allowedDefinitions: [...definitions].sort() } : {}),
      ...(relationship.constraints ? { constraints: structuredClone(relationship.constraints) } : {}),
      ...(relationship.inverse ? { inverse: relationship.inverse } : {}),
      ...(relationship.ownership ? { ownership: relationship.ownership } : {}),
      ...(relationship.cardinality ? { cardinality: relationship.cardinality } : {}),
      ...(relationship.sortable ? { sortable: true, positionColumn: `${relationship.foreignKey}_position` } : {}),
      ...(relationship.via ? { via: relationship.via } : {}),
      ...(relationship.through ? { through: relationship.through } : {}),
      ...(relationship.fieldKey && relationship.kind !== "belongsTo" ? { mutationSupport: Object.keys(nativeOperations).length ? "atomic" as const : "unsupported" as const } : {}),
      operations: { ...(list ? { list } : {}), ...(get ? { get } : {}), ...(create && !relationship.fieldKey ? { create } : {}), ...nativeOperations },
      ...(list ? { collection: { ...target.collection,
        ...((relationship.fieldKey || unsupportedGenericCreate(target, all)) ? { operations: withoutCreate(target.collection.operations) } : {}),
        id: `${target.contract.entity.name}.relationship.collection` } } : {}),
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
  const authoredContext = contract.interfaces?.web?.recordContext;
  for (const key of authoredContext?.fields ?? []) {
    if (!fields[key]?.supports.read) throw new Error(`${entityName}: context field ${key} is not readable.`);
  }
  for (const key of authoredContext?.relationships ?? []) {
    if (!contract.model.relationships.some((relationship) => relationship.key === key)) {
      throw new Error(`${entityName}: context relationship ${key} must reference a belongsTo or hasMany relationship.`);
    }
    if (relationships[key]?.kind === "hasMany" && !tabs.some(tab => tab.relationshipId === key)) {
      throw new Error(`${entityName}: collection context relationship ${key} requires a matching detail tab.`);
    }
  }
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
    renderer: contract.interfaces?.web?.renderers?.record ?? "entity.record",
    preset: "inbox-main-context" as const,
    formGroups: { create: authoredCreateGroups, update: updateGroups },
    modes,
    routes: {
      ...(modes.includes("read")
        ? {
            read: projectedRoute(
              view?.routes.detail,
              source.routeLocale,
              `${source.route}/:id`,
            ),
          }
        : {}),
      ...(modes.includes("create")
        ? {
            create: projectedRoute(
              view?.routes.create,
              source.routeLocale,
              `${source.route}/new`,
            ),
          }
        : {}),
    },
    operations: {
      ...(modes.includes("read") ? { read: operations.get } : {}),
      ...(modes.includes("create") ? { create: operations.create } : {}),
      ...(modes.includes("update") ? { update: operations.update } : {}),
      ...(operations.delete && detail?.actions?.some(({ mutation }) => mutation === "delete")
        ? { delete: operations.delete }
        : {}),
      ...(detail?.actions
        ? {
            actions: detail.actions.flatMap(({ key }) =>
              customOperations[key] ? [customOperations[key]!] : []
            ),
          }
        : {}),
    },
    titleTemplate: detail?.header.title ?? `{{${source.collection.displayField}}}`,
    ...(detail?.header.subtitle ? { subtitleTemplate: detail.header.subtitle } : {}),
    ...(detail?.header.badges?.items.length ? { badges: detail.header.badges.items } : {}),
    layout: {
      tabs: recordTabs,
      context: {
        groups: authoredContext?.fields.length
          ? [{ id: "summary", title: localized(undefined, "Key facts"), fields: authoredContext.fields }]
          : [],
        relationships: authoredContext?.relationships?.filter((key) => relationships[key]) ?? [],
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
    ...(contract.blueprint ? { blueprint: contract.blueprint } : {}),
    entityId: entityName,
    ...(contract.entity.displayTemplate ? { displayTemplate: contract.entity.displayTemplate } : {}),
    entitySlug: source.slug,
    title: source.collection.title,
    fields,
    operations: { ...operations, ...customOperations, ...Object.fromEntries(
      collectBlueprintOperations([{ contract, slug: source.slug }]).map((operation) => [operation.id, {
        id: operation.id, key: operation.key, intent: "invoke" as const,
        name: localized(operation.title, operation.title), description: localized(operation.description, operation.description),
        target: operation.target!, input: { kind: "json-schema" as const, schema: operation.inputSchema },
        output: { kind: "json-schema" as const, schema: operation.outputSchema }, effects: operation.effects!,
        reliability: { idempotency: { mode: operation.idempotency.mode === "intrinsic" ? "natural" as const : "none" as const } },
        ...(operation.concurrency ? { concurrency: operation.concurrency } : {}),
        confirmation: operation.confirmation!, rest: operation.transports.rest,
      }]),
    ) },
    ...(createUnsupported ? { unsupportedOperations: { create: {
      code: "RELATION_COLLECTION_MUTATION_UNSUPPORTED",
      message: "Generic create requires an atomic collection Operation and is currently unsupported.",
    } } } : {}),
    views: {
      collection: createUnsupported ? { ...source.collection, operations: withoutCreate(source.collection.operations) } : source.collection,
      ...(record ? { record } : {}),
    },
    relationships,
  };
}

function standaloneAuth(
  operation: CompiledPluginOperation,
): WebStandaloneOperationRef["auth"] {
  const auth = operation.auth;
  switch (auth.mode) {
    case "public":
      return { mode: "public" };
    case "control":
      return { mode: "control", roles: auth.roles };
    case "session":
      return {
        mode: "session",
        ...(auth.roles ? { roles: auth.roles } : {}),
        ...(auth.scopes ? { scopes: auth.scopes } : {}),
      };
    case "custom":
      // The browser holds a session or a control bearer, never a plugin's own
      // API key, so a custom-scheme Operation cannot be offered on a page.
      throw new Error(
        `Standalone Operation "${operation.key}" uses custom auth and cannot be projected to a web page.`,
      );
  }
}

/**
 * Display order inside a page: authored `order` first (unordered last), then
 * canonical id so two equal orders still render the same way every build. The
 * landing operation, when there is one, always leads because its result is
 * what the page opens with.
 */
function pageOperationOrder(
  refs: readonly WebStandaloneOperationRef[],
): string[] {
  return [...refs]
    .sort((left, right) =>
      Number(Boolean(right.landing)) - Number(Boolean(left.landing)) ||
      (left.order ?? Number.POSITIVE_INFINITY) - (right.order ?? Number.POSITIVE_INFINITY) ||
      left.id.localeCompare(right.id),
    )
    .map((ref) => ref.id);
}

type ProjectedStandalone = {
  operations: Record<string, WebStandaloneOperationRef>;
  pages: Record<string, WebPage>;
  entities: Record<string, WebEntityInterface>;
  /** Authored copy the strict-host translation check inspects. */
  metadata: { path: string; value: unknown }[];
};

type OperationEntityCollectionQuery = {
  input: WebCollectionQueryContract;
  nextCursorField: string;
  totalCountField: string;
  defaultSort?: { key: string; direction: "asc" | "desc" };
};

function objectProperties(schema: unknown): Record<string, Record<string, unknown>> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  const properties = (schema as { properties?: unknown }).properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? properties as Record<string, Record<string, unknown>>
    : {};
}

/**
 * A module list Operation opts into the same query contract as generated CRUD
 * by declaring the standard first/after/sortField/sortDirection schema. The
 * Operation remains authoritative: only entity fields accepted by its input
 * and sort enum are offered to Web, and pagination is projected only when the
 * Operation also returns the standard cursor and count fields.
 */
function operationEntityCollectionQuery(
  operationId: string,
  inputSchema: unknown,
  outputSchema: unknown,
  fields: readonly string[],
): OperationEntityCollectionQuery | undefined {
  const input = objectProperties(inputSchema);
  const reserved = ["first", "after", "sortField", "sortDirection"] as const;
  if (!reserved.some((key) => key in input)) return undefined;
  const missing = reserved.filter((key) => !(key in input));
  if (missing.length) {
    throw new Error(`Operation-backed list "${operationId}" has an incomplete collection query; missing ${missing.join(", ")}.`);
  }
  const first = input.first!;
  const defaultLimit = first.default;
  const maxLimit = first.maximum;
  if (!Number.isInteger(defaultLimit) || !Number.isInteger(maxLimit) || Number(defaultLimit) < 1 || Number(maxLimit) < Number(defaultLimit)) {
    throw new Error(`Operation-backed list "${operationId}" must declare integer first.default and first.maximum bounds.`);
  }
  const allowedFields = new Set(fields);
  const filterFields = fields.filter((field) => field in input);
  const sortFields = Array.isArray(input.sortField!.enum)
    ? input.sortField!.enum.filter((field): field is string => typeof field === "string" && allowedFields.has(field))
    : [];
  if (sortFields.length === 0) {
    throw new Error(`Operation-backed list "${operationId}" must offer at least one entity field in sortField.enum.`);
  }
  const output = objectProperties(outputSchema);
  if (!("nextCursor" in output) || !("totalCount" in output)) {
    throw new Error(`Operation-backed list "${operationId}" must return nextCursor and totalCount for collection pagination.`);
  }
  const defaultSortField = input.sortField!.default;
  const defaultSortDirection = input.sortDirection!.default;
  const defaultSort: OperationEntityCollectionQuery["defaultSort"] = typeof defaultSortField === "string" && sortFields.includes(defaultSortField)
    && (defaultSortDirection === "asc" || defaultSortDirection === "desc")
    ? { key: defaultSortField, direction: defaultSortDirection }
    : undefined;
  return {
    input: {
      kind: "collection-query",
      filterFields,
      sortFields,
      pagination: { kind: "cursor", defaultLimit: Number(defaultLimit), maxLimit: Number(maxLimit) },
    },
    nextCursorField: "nextCursor",
    totalCountField: "totalCount",
    ...(defaultSort ? { defaultSort } : {}),
  };
}

/**
 * Project the web block of every standalone catalog. Pages are keyed by their
 * authored id and routed at `/<id>` relative to the surface root; the host
 * mounts them beside the entity routes.
 */
function projectStandalone(
  input: WebStandaloneOperationsInput,
): ProjectedStandalone | undefined {
  const operations: Record<string, WebStandaloneOperationRef> = {};
  const pages: Record<string, WebPage> = {};
  const entities: Record<string, WebEntityInterface> = {};
  const metadata: ProjectedStandalone["metadata"] = [];
  const refsByPage = new Map<string, WebStandaloneOperationRef[]>();
  const pageOwner = new Map<string, string>();
  const compiledByKey = new Map(input.operations.map((operation) => [operation.key, operation]));
  const catalogs = [...input.catalogs]
    .filter((catalog) => catalog.interfaces.web)
    .sort((left, right) => left.plugin.localeCompare(right.plugin));
  for (const catalog of catalogs) {
    const web = catalog.interfaces.web!;
    const operationRef = (key: string): WebStandaloneOperationRef => {
      const definition = catalog.operations[key]!;
      const id = moduleOperationId(catalog, key, definition);
      const compiled = compiledByKey.get(id);
      if (!compiled || compiled.plugin !== catalog.plugin) {
        throw new Error(
          `Standalone Operation "${id}" has a web placement but no compiled contract; ` +
            "pass the catalog's lowered operations alongside the catalog.",
        );
      }
      const placement = web.operations?.[key];
      return {
        id,
        intent: "invoke",
        key,
        name: localized(definition.name, key),
        description: localized(definition.description, ""),
        input: { kind: "json-schema", schema: definition.input!.schema },
        output: { kind: "json-schema", schema: definition.output!.schema },
        effects: definition.effects,
        reliability: {
          idempotency: {
            mode: definition.reliability.idempotency.mode,
            ...(definition.reliability.idempotency.inputField
              ? { inputField: definition.reliability.idempotency.inputField }
              : {}),
          },
        },
        confirmation: definition.confirmation,
        rest: compiled.transports.rest,
        auth: standaloneAuth(compiled),
        page: placement?.page ?? `entity:${key}`,
        ...(placement?.landing ? { landing: true } : {}),
        ...(placement?.order !== undefined ? { order: placement.order } : {}),
      };
    };
    for (const [pageId, page] of Object.entries(web.pages ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      // Page ids are routes, and routes are global: two catalogs cannot each
      // own `/tenants`.
      const owner = pageOwner.get(pageId);
      if (owner) {
        throw new Error(
          `Web page "${pageId}" is declared by both "${owner}" and "${catalog.plugin}"; page ids are global.`,
        );
      }
      pageOwner.set(pageId, catalog.plugin);
      pages[pageId] = {
        id: pageId,
        title: localized(page.title, pageId),
        ...(page.description ? { description: localized(page.description, "") } : {}),
        ...(page.icon ? { icon: page.icon } : {}),
        ...(page.order !== undefined ? { order: page.order } : {}),
        route: `/${pageId}`,
        operations: [],
      };
      metadata.push({ path: `${catalog.plugin}.pages.${pageId}`, value: page });
    }
    for (const [key, placement] of Object.entries(web.operations ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      const ref = operationRef(key);
      const id = ref.id;
      const definition = catalog.operations[key]!;
      operations[id] = ref;
      refsByPage.set(placement.page, [...(refsByPage.get(placement.page) ?? []), ref]);
      metadata.push({ path: id, value: { name: definition.name, description: definition.description } });
    }

    for (const [entityName, entity] of Object.entries(web.entities ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      const recordActionKeys = (entity.operations.recordActions ?? []).map((action) =>
        typeof action === "string" ? action : action.operation
      );
      const operationKeys = [
        entity.operations.list.operation,
        ...(entity.operations.get ? [entity.operations.get.operation] : []),
        ...(entity.operations.collectionActions ?? []),
        ...recordActionKeys,
      ];
      const refs = Object.fromEntries(operationKeys.map((key) => {
        const ref = operationRef(key);
        operations[ref.id] = ref;
        const definition = catalog.operations[key]!;
        metadata.push({ path: ref.id, value: { name: definition.name, description: definition.description } });
        return [key, ref];
      })) as Record<string, WebStandaloneOperationRef>;
      const listDefinition = catalog.operations[entity.operations.list.operation]!;
      const listSchema = listDefinition.output!.schema as { properties?: Record<string, unknown> };
      const resultSchema = listSchema.properties?.[entity.operations.list.resultField] as {
        type?: string; items?: { properties?: Record<string, Record<string, unknown>> };
      } | undefined;
      const recordProperties = resultSchema?.type === "array" ? resultSchema.items?.properties : undefined;
      if (!recordProperties) {
        throw new Error(`Operation-backed entity "${entityName}" list result "${entity.operations.list.resultField}" must be an array of objects with properties.`);
      }
      for (const action of entity.operations.recordActions ?? []) {
        if (typeof action === "string" || !action.visibleWhen) continue;
        for (const condition of action.visibleWhen.conditions) {
          if (!recordProperties[condition.field]) {
            throw new Error(
              `Operation-backed entity "${entityName}" record action "${action.operation}" ` +
                `visibility field "${condition.field}" is absent from its list result schema.`,
            );
          }
        }
      }
      const fields = Object.fromEntries(entity.fields.map((key) => {
        const schema = recordProperties[key];
        if (!schema) throw new Error(`Operation-backed entity "${entityName}" field "${key}" is absent from its list result schema.`);
        const i18n = schema["x-osf-i18n"] as {
          title?: CompiledLocalizedText;
          enum?: Record<string, CompiledLocalizedText>;
        } | undefined;
        const title = i18n?.title;
        const rawType = Array.isArray(schema.type) ? schema.type.find((value) => value !== "null") : schema.type;
        const baseType = schema.format === "date-time"
          ? "datetime"
          : schema.format === "date"
            ? "date"
            : typeof rawType === "string" ? rawType : "string";
        const enumValues = Array.isArray(schema.enum)
          ? schema.enum.filter((value): value is string => typeof value === "string")
          : Object.keys(i18n?.enum ?? {});
        return [key, {
          id: `${entityName}.${key}`,
          key,
          label: localized(title, key),
          description: localized(undefined, ""),
          osfType: baseType,
          baseType,
          ...(enumValues.length ? {
            options: enumValues.map((value) => ({
              value,
              label: localized(i18n?.enum?.[value], value),
            })),
          } : {}),
          cardinality: "one" as const,
          required: false,
          supports: { read: true, create: false, update: false },
        }];
      }));
      const listRef = refs[entity.operations.list.operation]!;
      const listQuery = operationEntityCollectionQuery(
        listRef.id,
        listDefinition.input?.schema,
        listDefinition.output?.schema,
        entity.fields,
      );
      const getRef = entity.operations.get ? refs[entity.operations.get.operation]! : undefined;
      // The same target every plugin action carries: the web places a
      // collection action on the collection page and binds a record action to
      // the record it is opened on, without knowing which catalog authored it.
      const recordActions = (entity.operations.recordActions ?? []).map((action) => {
        const key = typeof action === "string" ? action : action.operation;
        return {
          ...refs[key]!,
          target: { entityId: entityName, entityName, scope: "record" as const, inputField: entity.idField },
          ...(typeof action === "string" || !action.visibleWhen
            ? {}
            : { visibleWhen: action.visibleWhen }),
        };
      });
      const collectionActions = (entity.operations.collectionActions ?? []).map((key) => ({
        ...refs[key]!,
        target: { entityId: entityName, entityName, scope: "collection" as const },
      }));
      const recordRoute = entity.recordRoute ?? `${entity.route}/:${entity.idField}`;
      entities[entityName] = {
        entityId: entityName,
        entitySlug: entity.route.replace(/^\//, ""),
        title: localized(entity.title, entityName),
        displayTemplate: `{{${entity.displayField}}}`,
        fields,
        operations: Object.fromEntries(Object.values(refs).map((ref) => [ref.key, ref])),
        operationSource: {
          idField: entity.idField,
          collection: {
            resultField: entity.operations.list.resultField,
            ...(entity.operations.list.bindings ? { bindings: entity.operations.list.bindings } : {}),
            ...(listQuery ? { query: {
              input: listQuery.input,
              nextCursorField: listQuery.nextCursorField,
              totalCountField: listQuery.totalCountField,
            } } : {}),
          },
          ...(entity.operations.get ? { record: {
            ...(entity.operations.get.resultField ? { resultField: entity.operations.get.resultField } : {}),
            ...(entity.operations.get.bindings ? { bindings: entity.operations.get.bindings } : {}),
          } } : {}),
          ...(entity.related?.length ? { related: entity.related.map((item) => ({
            entityId: item.entity, label: localized(item.label, item.entity), route: item.route,
          })) } : {}),
        },
        views: {
          collection: {
            id: `${entityName}.collection`, kind: "collection", renderer: "operation.entity.collection", modes: ["read"],
            route: entity.route,
            operations: { read: listRef, ...(collectionActions.length ? { actions: collectionActions } : {}) },
            title: localized(entity.title, entityName),
            searchPlaceholder: localized(undefined, `Search ${entityName}`),
            displayField: entity.displayField,
            ...(listQuery?.defaultSort ? { defaultSort: listQuery.defaultSort } : {}),
            columns: entity.columns.map((key) => ({ fieldId: `${entityName}.${key}`, key, label: fields[key]!.label })),
          },
          ...(getRef ? { record: {
            id: `${entityName}.record`, kind: "record", renderer: "operation.entity.record", preset: "inbox-main-context",
            modes: ["read"], routes: { read: recordRoute },
            operations: { read: getRef, ...(recordActions.length ? { actions: recordActions } : {}) },
            titleTemplate: `{{${entity.displayField}}}`,
            layout: { tabs: [{ id: "overview", label: localized(undefined, "Overview"), groups: [{ id: "overview", title: localized(undefined, "Overview"), fields: entity.fields }] }], context: { groups: [], relationships: [] } },
            labels: {},
          } } : {}),
        },
        relationships: {},
      } as unknown as WebEntityInterface;
    }
  }
  if (catalogs.length === 0) return undefined;
  for (const [pageId, refs] of refsByPage) pages[pageId]!.operations = pageOperationOrder(refs);
  return {
    operations: Object.fromEntries(Object.entries(operations).sort(([left], [right]) => left.localeCompare(right))),
    pages,
    entities,
    metadata,
  };
}

/** Project resolved entity contracts into the versioned browser interface contract. */
export function buildWebManifest(
  entities: readonly Pick<CompiledEntityInfo, "slug" | "contract">[],
  options: WebManifestOptions = {},
  standalone: WebStandaloneOperationsInput = { catalogs: [], operations: [] },
  referentiedata: CoreReferentiedataSnapshot = {},
): WebManifestV1 {
  materializeCollectionOperations(entities, referentiedata);
  const resolved: Required<WebManifestOptions> = {
    requireTranslations: options.requireTranslations ?? false,
    locale: options.locale ?? "en",
    context: options.context ?? "core",
    routeLocale: options.routeLocale ?? options.locale ?? "en",
  };
  const projectable = projectableEntities(entities, resolved);
  const definitions = [...new Set(entities.flatMap(({ contract }) => contract.model.fields.flatMap((field) => field.allowedDefinitions ?? [])))].sort();
  const entityValueDefinitions = Object.fromEntries(definitions.map((name) => {
    const definition = entities.find(({ contract }) => contract.entity.name === name)?.contract;
    if (!definition) throw new Error(`Web entity-value definition ${name} is absent from the compiled corpus.`);
    assertEntityValueDefinition({ contract: definition, effectiveFields: definition.model.fields });
    const materialize = definition.pluginOperations?.find((operation) => operation.key === "materialize");
    return [name, {
      entityName: name,
      label: localized(definition.entity.labels, definition.entity.title ?? name),
      // These supports describe editing inside a carrier value, not CRUD.
      fields: definition.model.fields.map((field) => projectField(field, name, { read: true, create: true, update: true }, true, definition.interfaces?.web?.fields)),
      ...(materialize ? { materializeOperationId: materialize.id } : {}),
    }];
  }));
  // Provider-backed entities project first: a core entity may reference one.
  const pages = projectStandalone(standalone);
  const providers = new Map(Object.entries(pages?.entities ?? {}));
  const byName = new Map(projectable.map((entity) => [entity.contract.entity.name, entity]));
  const projected = projectable.map((entity) => projectEntity(entity, byName, providers));
  const missing = missingUiTranslations(projected);
  missing.push(...missingUiTranslations(pages?.operations ?? {}));
  if (resolved.requireTranslations) for (const entity of projectable) {
    missing.push(...missingLocalizedMetadata(entity.contract, entity.contract.entity.name));
  }
  if (resolved.requireTranslations) for (const { path, value } of pages?.metadata ?? []) {
    missing.push(...missingLocalizedMetadata(value, path));
  }
  const schemaOperations = [
    ...projected.flatMap((entity) => Object.values(entity.operations)),
    ...Object.values(pages?.entities ?? {}).flatMap((entity) => Object.values(entity.operations)),
    ...Object.values(pages?.operations ?? {}),
  ];
  if (resolved.requireTranslations) for (const operation of schemaOperations) {
    // Collection-query inputs carry field keys, not a JSON Schema; their labels
    // are covered by the entity field check above.
    if (operation && "input" in operation && operation.input.kind === "json-schema") missing.push(...missingSchemaUiTranslations(operation.input.schema, `${operation.id}.input`));
    if (operation && "output" in operation && operation.output?.kind === "json-schema" && operation.output.schema) missing.push(...missingSchemaUiTranslations(operation.output.schema, `${operation.id}.output`));
  }
  if (missing.length) throw new Error(`Missing required UI translations: ${missing.join(", ")}`);
  return {
    contract: "openshapeforge.web-manifest",
    version: 1,
    locale: resolved.locale,
    entities: {
      ...(pages?.entities ?? {}),
      // A host's canonical entity projection owns its normal application
      // route. A provider-backed projection with the same name remains usable
      // in a dedicated manifest (for example the platform-admin app), but may
      // not replace the canonical entity in the composed product manifest.
      ...Object.fromEntries(projected.map((entity) => [entity.entityId, entity])),
    },
    ...(pages ? { operations: pages.operations, pages: pages.pages } : {}),
    ...(definitions.length ? { entityValueDefinitions } : {}),
  };
}

/** Stable JSON representation for generated artifacts and deterministic checks. */
export function renderWebManifest(manifest: WebManifestV1): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
