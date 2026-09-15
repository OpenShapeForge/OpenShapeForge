// SPDX-License-Identifier: BUSL-1.1
/**
 * Web interface projection.
 *
 * This module turns resolved entity contracts into a transport-free manifest.
 * Browser applications consume the manifest through their own component and
 * operation adapters; API paths and design-system component names deliberately
 * do not cross this boundary.
 */
import { missingLocalizedMetadata, missingSchemaUiTranslations, missingUiTranslations } from "@openshapeforge/interface-web";
import type { CompiledEntityInfo } from "../plugins.js";
import type { CoreReferentiedataSnapshot } from "../core-referentiedata-artifacts.js";
import { assertEntityValueDefinition } from "./entity-values.js";
import { materializeCollectionOperations } from "./collection-operations.js";
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
  WebCustomOperationRef,
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
  if (!source) return undefined;
  if (source.implementation.type === "entity") {
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
          operation(exposed && exposed[intent] !== true
            ? undefined
            : contract.entityOperations[intent]),
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
  return {
    id: `${parent}.${field.key}`, key: field.key,
    label: localized(field.label, field.key), description: localized(field.description, ""),
    valueType: field.valueType,
    cardinality: field.cardinality === "collection" ? "many" : "one",
    required: field.required,
    ...(presentation ? { presentation } : {}),
    ...projectedTextLength(field),
    ...(field.semanticType ? { semanticType: field.semanticType } : {}),
    ...(field.relationship?.target ? { relationship: { targetEntityId: field.relationship.target } } : {}),
    ...(field.variables ? { variables: field.variables } : {}),
    ...(field.suggestions ? { suggestions: field.suggestions } : {}),
    ...(field.visibility ? { visibility: field.visibility } : {}),
    ...(field.entityValue ? { entityValue: { ...field.entityValue } } : {}),
    ...(field.allowedDefinitions ? { allowedDefinitions: [...field.allowedDefinitions].sort() } : {}),
    ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
    ...(field.options?.items?.length ? { options: field.options.items.map(({ value, label }) => ({ value, label: localized(label, value) })) } : {}),
    ...(field.options?.type === "referentiedata" && field.options.referentieGroep
      ? { optionSource: { type: "referentiedata" as const, group: field.options.referentieGroep } } : {}),
    ...(field.options?.type === "entity" && field.options.source
      ? { optionSource: { type: "entity" as const, source: field.options.source, valueField: field.options.valueField ?? "id" } } : {}),
    ...((field.options?.type === "remote" || field.options?.type === "dynamic") && (field.options.remoteUrl || field.options.source)
      ? { optionSource: { type: field.options.type, source: field.options.remoteUrl ?? field.options.source! } } : {}),
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
    typeof relationship.cardinality === "object" && (relationship.cardinality.min ?? 0) > 0)) return true;
  return [...all.values()].some((owner) => owner.contract.model.relationships.some((relationship) =>
    relationship.fieldKey && !relationship.through && relationship.kind === "hasMany" && relationship.target === contract.entity.name &&
    (relationship.sortable || contract.storage.columns.some((column) => column.column === relationship.foreignKey && !column.nullable))));
}

function withoutCreate<T extends { create?: unknown }>(operations: T): Omit<T, "create"> {
  const { create: _create, ...rest } = operations;
  return rest;
}

function projectEntity(
  source: ProjectableEntity,
  all: ReadonlyMap<string, ProjectableEntity>,
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
      if (!relationship.fieldKey || relationship.through || relationship.kind !== "hasMany" || relationship.target !== entityName) continue;
      const inverse = contract.storage.columns.find((column) => column.column === relationship.foreignKey);
      if (inverse) serverOwnedFields.add(inverse.field);
    }
  }
  const createGroups = createUnsupported ? [] : formGroups(createVariant, undefined, serverOwnedFields);
  const authoredCreateGroups = formGroups(createVariant, undefined, serverOwnedFields);
  const updateGroups = formGroups(updateVariant, createVariant, serverOwnedFields);
  const createFields = new Set(createGroups.flatMap(({ fields }) => fields));
  const updateFields = new Set(updateGroups.flatMap(({ fields }) => fields));
  const explicitFieldKeys = new Set(contract.model.fields.map(({ key }) => key));
  const explicitFields = contract.model.fields.map((field) => {
    const projected = projectField(field, entityName, {
        read: true,
        create: !field.readOnly && !field.deriveOnCreate && createFields.has(field.key),
        update: !field.readOnly && !field.immutable && !field.deriveOnCreate && updateFields.has(field.key),
    }, false, contract.interfaces?.web?.fields);
    return [field.key, projected] as const;
  });
  const implicitRelationshipFields = contract.model.relationships.flatMap((relationship) => {
    if (relationship.kind !== "belongsTo" || !relationship.foreignKey) return [];
    const column = contract.storage.columns.find(
      (candidate) => candidate.column === relationship.foreignKey,
    );
    const key = column?.field ?? snakeToCamel(relationship.foreignKey);
    // When an authored field owns this input key, its writability and
    // presentation semantics are authoritative. Never widen it from the
    // structural relationship declaration.
    if (explicitFieldKeys.has(key)) return [];
    const targetId = all.get(relationship.target)?.contract.model.fields.find(
      (field) => field.key === "id",
    );
    const label = localized(relationship.label, relationship.key);
    const projected: WebFieldProjection = {
      id: `${entityName}.${key}`,
      key,
      label,
      description: label,
      valueType: "string",
      ...(targetId?.semanticType ? { semanticType: targetId.semanticType } : {}),
      cardinality: "one",
      required: column ? !column.nullable : false,
      supports: {
        read: true,
        create: Boolean(operations.create && createVariant),
        update: Boolean(operations.update && updateVariant),
      },
    };
    return [[key, projected] as const];
  });
  const fields = Object.fromEntries([...explicitFields, ...implicitRelationshipFields]);

  const relationships = Object.fromEntries(contract.model.relationships.flatMap((relationship) => {
    const target = all.get(relationship.target);
    if (!target || (!relationship.foreignKey && !relationship.via)) return [];
    const list = target.operations.list;
    const get = target.operations.get;
    const create = target.operations.create;
    const definitions = contract.model.fields.find((field) => field.key === (relationship.fieldKey ?? relationship.key))?.allowedDefinitions;
    const nativeOperations: Pick<WebRelationshipProjection["operations"], "insert" | "move"> = {};
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
      ...(relationship.inverse ? { inverse: relationship.inverse } : {}),
      ...(relationship.ownership ? { ownership: relationship.ownership } : {}),
      ...(relationship.cardinality ? { cardinality: relationship.cardinality } : {}),
      ...(relationship.sortable ? { sortable: true, positionColumn: relationship.kind === "manyToMany" ? "position" : `${relationship.foreignKey}_position` } : {}),
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
    entityId: entityName,
    ...(contract.entity.displayTemplate ? { displayTemplate: contract.entity.displayTemplate } : {}),
    entitySlug: source.slug,
    title: source.collection.title,
    fields,
    operations: { ...operations, ...customOperations },
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

/** Project resolved entity contracts into the versioned browser interface contract. */
export function buildWebManifest(
  entities: readonly Pick<CompiledEntityInfo, "slug" | "contract">[],
  options: WebManifestOptions = {},
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
  const byName = new Map(projectable.map((entity) => [entity.contract.entity.name, entity]));
  const projected = projectable.map((entity) => projectEntity(entity, byName));
  const missing = missingUiTranslations(projected);
  if (resolved.requireTranslations) for (const entity of projectable) {
    missing.push(...missingLocalizedMetadata(entity.contract, entity.contract.entity.name));
  }
  if (resolved.requireTranslations) for (const entity of projected) for (const operation of Object.values(entity.operations)) {
    if (operation && "input" in operation) missing.push(...missingSchemaUiTranslations(operation.input.schema, `${operation.id}.input`));
    if (operation && "output" in operation && operation.output?.schema) missing.push(...missingSchemaUiTranslations(operation.output.schema, `${operation.id}.output`));
  }
  if (missing.length) throw new Error(`Missing required UI translations: ${missing.join(", ")}`);
  return {
    contract: "openshapeforge.web-manifest",
    version: 1,
    locale: resolved.locale,
    entities: Object.fromEntries(projected.map((entity) => [entity.entityId, entity])),
    ...(definitions.length ? { entityValueDefinitions } : {}),
  };
}

/** Stable JSON representation for generated artifacts and deterministic checks. */
export function renderWebManifest(manifest: WebManifestV1): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
