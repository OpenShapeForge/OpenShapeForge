// SPDX-License-Identifier: BUSL-1.1
/** Prepare canonical entities and their Operations for web projection. */
import { operationForm } from "./operation-form-presentation.js";
import type { CompiledEntityInfo, CompiledPluginOperation } from "../plugins.js";
import { withOperationControls } from "../generate-operations.js";
import type {
  CompiledEntityContract,
  CompiledEntityOperation,
  CompiledFormVariant,
  CompiledViewContext,
  CompiledViewGroup,
  LocalizedText as CompiledLocalizedText,
} from "./types.js";
import type {
  WebCollectionView,
  WebCustomOperationRef,
  WebFieldGroup,
  WebFieldProjection,
  WebVisibilityCondition,
  WebManifestOptions,
  WebOperationIntent,
  WebOperationRef,
} from "@openshapeforge/interface-web";
import { localized, snakeToCamel, standaloneAuth } from "./web-projection-helpers.js";
import type { ProjectableEntity } from "./web-value-path.js";

/** A REST-driven browser must positively project both its collection and transport. */
export function hasWebRestCollection(contract: CompiledEntityContract): boolean {
  return contract.source
    ? contract.pluginOperations?.some(operation => operation.key === "list"
      && Boolean(operation.interfaces.web) && Boolean(operation.interfaces.rest)) === true
    : contract.interfaces?.web?.operations.list === true && contract.rest?.operations.list === true;
}

const technicalFields = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "externalId",
  "sourceAuthority",
  "sourceOrganization",
  "sourceAdministration",
  "sourceAdministrationName",
]);

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
    input: {
      kind: "json-schema",
      schema: withOperationControls(source.input.schema, {
        ...(source.concurrency ? { concurrency: source.concurrency } : {}),
        confirmation: source.interaction.confirmation,
      }),
    },
    output: source.output,
    ...(source.interfaces?.web && source.interfaces.web.form ? { form: operationForm(source.interfaces.web.form, source.input.schema, source.id, source.reliability.idempotency.mode === "keyed" ? [source.reliability.idempotency.inputField] : []) } : {}),
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
  if ((definition.implementation.type !== "plugin" && definition.implementation.type !== "collection" && definition.implementation.type !== "ownedDelete") || !definition.target ||
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
    // The same control-augmented schema the API catalog validates against:
    // the browser must send expectedVersion/leaseToken where the executor
    // requires them, and a closed schema that omits them makes the battery
    // drop those keys before the wire.
    input: { kind: "json-schema", schema: withOperationControls(definition.input.schema, definition) },
    output: { kind: "json-schema", schema: definition.output.schema },
    ...(source.interfaces.web?.visibleWhen ? { visibleWhen: source.interfaces.web.visibleWhen } : {}),
    ...(source.interfaces.web?.successMessage ? { successMessage: localized(source.interfaces.web.successMessage, "Action completed.") } : {}),
    ...(source.interfaces.web?.resultRenderer ? { resultRenderer: source.interfaces.web.resultRenderer } : {}),
    ...(source.interfaces.web?.form ? { form: operationForm(source.interfaces.web.form, definition.input.schema, source.id, definition.reliability.idempotency.mode === "keyed" ? [definition.reliability.idempotency.inputField] : []) } : {}),
    effects: definition.effects,
    ...(definition.auth ? { auth: standaloneAuth({ auth: definition.auth } as CompiledPluginOperation) } : {}),
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
              `/api/${definition.implementation.type === "plugin" ? definition.implementation.plugin : "core"}/${kebab(source.entityName)}` +
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

/**
 * Presentation-renderer overrides authored on a FieldRef entry, keyed by
 * field key. Still in development: nothing prunes this yet, so a FieldRef's
 * `render` survives compilation instead of being silently dropped alongside
 * the key-only projection in fieldKeys().
 */
function fieldOverrides(
  group: CompiledViewGroup,
  excluded: ReadonlySet<string> = new Set(),
): Record<string, { render: { component: string; props?: Record<string, unknown> } }> | undefined {
  const entries = (group.fields ?? []).flatMap((entry) => {
    if (typeof entry === "string" || !entry.renderOverride) return [];
    if (entry.fieldDisplayMode === "hidden" || excluded.has(entry.key)) return [];
    return [[entry.key, { render: entry.renderOverride }] as const];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** A group's icon and its visibility condition travel to the renderer unchanged. */
function groupPresentation(group: CompiledViewGroup): Pick<WebFieldGroup, "icon" | "showTitle" | "visibleWhen" | "control"> {
  return {
    ...(group.bindings && group.render ? { control: { component: group.render.component, ...(group.render.props ? { props: structuredClone(group.render.props) } : {}), bindings: { ...group.bindings } } } : {}),
    ...(group.icon ? { icon: group.icon } : {}),
    ...(group.showTitle === false ? { showTitle: false } : {}),
    ...(group.visibleWhen ? { visibleWhen: structuredClone(group.visibleWhen) } : {}),
  };
}

/**
 * A condition is evaluated by the host on the record it shows, so it may only use fields the
 * Web interface can read.
 */
export function assertVisibilityFields(
  entityName: string,
  scope: string,
  owners: readonly { id: string; visibleWhen?: WebVisibilityCondition; control?: WebFieldGroup["control"] }[],
  fields: Readonly<Record<string, WebFieldProjection>>,
): void {
  for (const owner of owners) if (owner.control) {
    for (const key of Object.values(owner.control.bindings)) {
      const field = fields[key];
      if (!field?.supports.read || field.cardinality === "many" || field.baseType !== "string" || field.optionSource || field.options?.length || field.typedBy) throw new Error(`${entityName} ${scope} "${owner.id}" binding "${key}" must be a readable scalar text field.`);
    }
    if (owner.control.component !== "FieldPersonName" || Object.keys(owner.control.bindings).some(key => !["givenName", "prefix", "familyName"].includes(key)) || !owner.control.bindings.givenName || !owner.control.bindings.familyName) throw new Error(`${entityName} ${scope} "${owner.id}" requires valid FieldPersonName bindings.`);
    if (owner.control.props?.allowSingleName !== false) throw new Error(`${entityName} ${scope} "${owner.id}" name-part bindings require explicit allowSingleName: false; single-name persistence is not bound.`);
    const layout = owner.control.props?.layout;
    if (layout !== undefined && layout !== "front" && layout !== "above" && layout !== "none") throw new Error(`${entityName} ${scope} "${owner.id}" FieldPersonName layout must be front, above or none.`);
  }
  for (const owner of owners) for (const condition of owner.visibleWhen?.conditions ?? []) {
    if (!fields[condition.field]?.supports.read) {
      throw new Error(`${entityName} ${scope} "${owner.id}" visibleWhen field "${condition.field}" is not a readable field of ${entityName}.`);
    }
  }
}

/**
 * Nested groups are flattened, so a child carries its parent's condition too: both must hold.
 * Or-logic cannot be combined into one flat condition and is refused where it would be needed.
 */
function withParentVisibility(group: CompiledViewGroup, parent: CompiledViewGroup["visibleWhen"], scope = "Form group"): CompiledViewGroup {
  if (!parent) return group;
  if (!group.visibleWhen) return { ...group, visibleWhen: parent };
  // A single condition reads the same under either logic.
  const disjunctive = (condition: NonNullable<CompiledViewGroup["visibleWhen"]>) => condition.logic === "or" && condition.conditions.length > 1;
  if (disjunctive(group.visibleWhen) || disjunctive(parent)) {
    throw new Error(`${scope} "${group.id}" combines its visibleWhen with a parent group's; nested conditions must use "and".`);
  }
  return { ...group, visibleWhen: { conditions: [...parent.conditions, ...group.visibleWhen.conditions] } };
}

export function projectGroups(
  groups: readonly CompiledViewGroup[] | undefined,
  excluded: ReadonlySet<string> = new Set(),
  parentVisibility?: CompiledViewGroup["visibleWhen"],
  scope = "Form group",
): WebFieldGroup[] {
  return (groups ?? []).flatMap((authored) => {
    const group = withParentVisibility(authored, parentVisibility, scope);
    const keys = fieldKeys(group, excluded);
    // A form group projects fields only; a condition on a relationship-only group could not be honoured.
    if (authored.visibleWhen && authored.relationship && !authored.relationship.view && keys.length === 0 && !group.groups?.length) {
      throw new Error(`${scope} "${group.id}" has a visibleWhen but no fields to show or hide; place the condition on a group with fields.`);
    }
    if (group.bindings) {
      if (!group.render || group.groups?.length || group.relationship || group.relationships?.length) throw new Error(`${scope} "${group.id}" bindings require a field-only group and a renderer.`);
      const targets = Object.values(group.bindings);
      if (!targets.length || new Set(targets).size !== targets.length || keys.length !== targets.length || targets.some(key => !keys.includes(key))) throw new Error(`${scope} "${group.id}" bindings must map every group field exactly once.`);
    }
    const overrides = fieldOverrides(group, excluded);
    const placement = scope === "Detail group" && group.relationship?.view
      ? { relationshipId: group.relationship.through ? `${group.relationship.name}__${group.relationship.through}` : group.relationship.name, targetView: group.relationship.view } : {};
    const projected = keys.length > 0 || placement.relationshipId
      ? [{ ...placement, id: group.id, title: localized(group.title ?? group.label, group.id), fields: keys, ...groupPresentation(group), ...(overrides ? { fieldOverrides: overrides } : {}) }]
      : [];
    return [...projected, ...projectGroups(group.groups, excluded, group.visibleWhen, scope)];
  });
}

export function projectTabGroups(tab: CompiledViewGroup): WebFieldGroup[] {
  const ownFields = fieldKeys(tab);
  const overrides = fieldOverrides(tab);
  return [
    ...(ownFields.length > 0
      ? [{ id: tab.id, title: localized(tab.title ?? tab.label, tab.id), fields: ownFields, ...groupPresentation(tab), ...(overrides ? { fieldOverrides: overrides } : {}) }]
      : []),
    ...projectGroups(tab.groups, new Set(), tab.visibleWhen, "Detail group"),
  ];
}

export function formGroups(
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

export function projectedRoute(
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
    renderer: contract.interfaces?.web?.renderers?.collection ?? (contract.source ? "operation.entity.collection" : "entity.collection"),
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
    ...(contract.interfaces?.web?.collectionEmptyState ? { emptyState: { ...(contract.interfaces.web.collectionEmptyState.illustration ? {illustration:contract.interfaces.web.collectionEmptyState.illustration} : {}), ...(contract.interfaces.web.collectionEmptyState.primaryAction ? {primaryAction:contract.interfaces.web.collectionEmptyState.primaryAction} : {}), title: localized(contract.interfaces.web.collectionEmptyState.title, "No records"), ...(contract.interfaces.web.collectionEmptyState.description ? { description: localized(contract.interfaces.web.collectionEmptyState.description, "") } : {}) } } : {}),
    displayField: contract.entity.filterField ?? columnKeys[0]!,
    columns: columnKeys.map((key) => ({
      fieldId: `${entityName}.${key}`,
      key,
      label: localized(list?.columns.find(column => column.key === key)?.label ?? fieldByKey.get(key)?.label, key),
    })),
    ...(list?.defaultSort ? { defaultSort: list.defaultSort } : {}),
  };
}

export function projectableEntities(
  entities: readonly Pick<CompiledEntityInfo, "slug" | "contract">[],
  options: Required<WebManifestOptions>,
): ProjectableEntity[] {
  return entities.flatMap(({ slug, contract }) => {
    if (contract.entity.valueDefinition) return [];
    const exposed = contract.interfaces?.web?.operations;
    if (!contract.source && (!contract.entityOperations.list || !exposed?.list)) return [];
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
    if (contract.source) {
      if (!customOperations.list) return [];
      operations.list = customOperations.list;
      if (customOperations.get) operations.get = customOperations.get;
    }
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
