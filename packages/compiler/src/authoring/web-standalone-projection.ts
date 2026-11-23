// SPDX-License-Identifier: BUSL-1.1
/** Project standalone Operations, their pages, and Operation-backed entities. */
import type { CompiledPluginOperation } from "../plugins.js";
import { assertRelatedWebEntitiesResolve, moduleOperationId } from "./operation-catalog.js";
import type { LocalizedText as CompiledLocalizedText, OperationCatalogDefinition } from "./types.js";
import type {
  WebEntityInterface,
  WebPage,
  WebRecordTab,
  WebRelationshipProjection,
  WebStandaloneOperationRef,
} from "@openshapeforge/interface-web";
import { localized, objectProperties, operationEntityCollectionQuery, standaloneAuth, withoutCreate } from "./web-projection-helpers.js";
import type { ProjectableEntity } from "./web-value-path.js";

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

/**
 * Every entity an authored input schema points a reference picker at must be
 * one this deployment actually projects.
 *
 * `x-osf-reference` is how a declarative form says "pick a record of this
 * entity": the host resolves the target's own collection and display name to
 * render the picker. Nothing else checked the name, so a catalog could name an
 * entity that no layer declares — or one an overlay supplies and the published
 * base does not — and still compile, leaving a form whose only control cannot
 * be populated. Checked here, where the projectable corpus is known, so the
 * build fails on the authoring rather than the browser on the page.
 *
 * Every level of the schema, not only its root: a picker is as dead inside a
 * nested object, a list item or a discriminated variant as it is beside them,
 * and a host walks all of those to render its controls. The reported name is
 * the path to the input, so a nested one says where it is.
 */
function assertReferenceTargetsExist(
  origin: string,
  schema: Readonly<Record<string, unknown>>,
  known: ReadonlySet<string>,
  path: readonly string[] = [],
): void {
  const reference = schema["x-osf-reference"];
  if (reference && typeof reference === "object" && !Array.isArray(reference)) {
    const entity = (reference as { entity?: unknown }).entity;
    if (typeof entity === "string" && !known.has(entity)) {
      throw new Error(
        `${origin} input "${path.join("/")}" references unknown entity "${entity}"; ` +
          "x-osf-reference must name a core entity or an operation-backed web " +
          "entity this deployment's authoring layers declare.",
      );
    }
  }
  for (const [key, property] of Object.entries(objectProperties(schema))) {
    assertReferenceTargetsExist(origin, property, known, [...path, key]);
  }
  const items = schema.items;
  if (items && typeof items === "object" && !Array.isArray(items)) {
    assertReferenceTargetsExist(origin, items as Record<string, unknown>, known, [...path, "*"]);
  }
  // A discriminated variant: each branch declares its own properties, and a
  // picker in one of them is one a reader actually reaches.
  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (!branch || typeof branch !== "object" || Array.isArray(branch)) continue;
      assertReferenceTargetsExist(origin, branch as Record<string, unknown>, known, path);
    }
  }
}

/**
 * A collection action, targeted at the collection it was placed on.
 *
 * A collection action of a PARAMETERIZED collection is invoked on the page the
 * user is already on, so it inherits that page's own route bindings — the same
 * map the list Operation uses, narrowed to the inputs this action actually
 * declares. Nothing new is authored for it: an action that does not take the
 * parameter simply gets no binding.
 */
function collectionActionTarget(
  ref: WebStandaloneOperationRef,
  entityName: string,
  listBindings: Record<string, string> | undefined,
): WebStandaloneOperationRef {
  const inputs = objectProperties(ref.input.schema);
  const routeBindings = Object.fromEntries(
    Object.entries(listBindings ?? {}).filter(([inputKey]) => inputKey in inputs));
  return {
    ...ref,
    target: {
      entityId: entityName,
      entityName,
      scope: "collection" as const,
      ...(Object.keys(routeBindings).length ? { routeBindings } : {}),
    },
  };
}

/** The core entity an operation schema property is typed as, when its `x-osf-type` names one. */
function referenceTarget(
  schema: Record<string, unknown>,
  targets: ReadonlyMap<string, ProjectableEntity>,
): ProjectableEntity | undefined {
  const osfType = schema["x-osf-type"];
  return typeof osfType === "string" ? targets.get(osfType) : undefined;
}

/** Project catalog pages beside the canonical entity routes. */
export function projectStandalone(
  input: WebStandaloneOperationsInput,
  targets: ReadonlyMap<string, ProjectableEntity> = new Map(),
): ProjectedStandalone | undefined {
  const operations: Record<string, WebStandaloneOperationRef> = {};
  const pages: Record<string, WebPage> = {};
  const entities: Record<string, WebEntityInterface> = {};
  const metadata: ProjectedStandalone["metadata"] = [];
  const refsByPage = new Map<string, WebStandaloneOperationRef[]>();
  const pageOwner = new Map<string, string>();
  const pendingReferences: Array<{ entityName: string; key: string; targetName: string; valueField: string }> = [];
  const compiledByKey = new Map(input.operations.map((operation) => [operation.key, operation]));
  const catalogs = [...input.catalogs]
    .filter((catalog) => catalog.interfaces.web)
    .sort((left, right) => left.plugin.localeCompare(right.plugin));
  // `entities[name]` below would let the last catalog win in silence, and a
  // related link projected further down names a destination any catalog may
  // own. Both resolve across all catalogs, so both are settled here, before
  // the first one is projected.
  assertRelatedWebEntitiesResolve(catalogs.map((document) => ({ origin: document.plugin, document })));
  // Validate extension links against their actual owner and destination using
  // exactly the same route, binding, read and realm rules as authored links.
  const extendedCatalogs = structuredClone(catalogs);
  for (const catalog of extendedCatalogs) for (const [name, extension] of Object.entries(catalog.interfaces.web?.entityExtensions ?? {})) {
    const owner = extendedCatalogs.find((candidate) => candidate.interfaces.web?.entities?.[name]);
    const entity = owner?.interfaces.web?.entities?.[name];
    if (!entity) throw new Error(`Operation-backed entity extension "${name}" from "${catalog.plugin}" has no target entity.`);
    entity.related = [...(entity.related ?? []), ...extension.related];
  }
  assertRelatedWebEntitiesResolve(extendedCatalogs.map((document) => ({ origin: document.plugin, document })));
  // A reference picker may point at a core entity or at an operation-backed
  // web entity any catalog declares — the two are the same thing to the host,
  // and an operation-backed one is how a provider surface exposes its own
  // records. Collected before the loop, so a catalog may reference an entity a
  // later catalog declares.
  const referenceable = new Set([
    ...targets.keys(),
    ...catalogs.flatMap((catalog) => Object.keys(catalog.interfaces.web?.entities ?? {})),
  ]);
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
      assertReferenceTargetsExist(`${catalog.plugin} Operation "${key}"`, compiled.inputSchema, referenceable);
      const placement = web.operations?.[key];
      return {
        id,
        intent: "invoke",
        key,
        name: localized(definition.name, key),
        description: localized(definition.description, ""),
        input: { kind: "json-schema", schema: compiled.inputSchema },
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
        ...(entity.operations.create ? [entity.operations.create.operation] : []),
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
        const target = referenceTarget(schema, targets);
        const reference = schema["x-osf-reference"];
        const explicitReference = reference && typeof reference === "object" && !Array.isArray(reference)
          ? reference as { entity?: unknown; valueField?: unknown } : undefined;
        const targetName = explicitReference?.entity;
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        // Existing picker metadata and array schemas do not opt into a single
        // record relationship. Both matching annotations and a scalar are required.
        if (!target && key !== entity.idField && typeof targetName === "string"
          && schema["x-osf-type"] === targetName && types.includes("string")
          && types.every((type) => type === "string" || type === "null")
          && catalogs.some((item) => item.interfaces.web?.entities?.[targetName])) {
          if (typeof explicitReference?.valueField !== "string") {
            throw new Error(`Operation-backed reference ${entityName}.${key} needs an explicit valueField.`);
          }
          pendingReferences.push({ entityName, key, targetName, valueField: explicitReference.valueField });
        }
        const rawType = Array.isArray(schema.type) ? schema.type.find((value) => value !== "null") : schema.type;
        // Plain text arrays use the existing collection renderer. Structured,
        // open, typed and enumerated items retain their prior projection until
        // their own semantics can be projected completely.
        const candidate = rawType === "array" && schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)
          ? schema.items as typeof schema : undefined;
        const plainStringArray = candidate?.type === "string" && candidate.format === undefined && candidate.enum === undefined
          && candidate.const === undefined && candidate.oneOf === undefined && candidate.anyOf === undefined
          && candidate.allOf === undefined && candidate.not === undefined && candidate.$ref === undefined
          && candidate["x-osf-type"] === undefined && candidate["x-osf-reference"] === undefined
          && candidate["x-osf-typed-by"] === undefined && candidate["x-osf-presentation"] === undefined
          && candidate["x-osf-exact"] === undefined && schema.format === undefined && schema.enum === undefined
          && !Object.keys(i18n?.enum ?? {}).length && !target
          && schema["x-osf-type"] === undefined && schema["x-osf-reference"] === undefined
          && schema["x-osf-typed-by"] === undefined && schema["x-osf-presentation"] === undefined
          && schema["x-osf-exact"] === undefined;
        const baseType = plainStringArray ? "string" : schema.format === "date-time"
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
          osfType: target ? target.contract.entity.name : baseType,
          baseType,
          ...(enumValues.length ? {
            options: enumValues.map((value) => ({
              value,
              label: localized(i18n?.enum?.[value], value),
            })),
          } : {}),
          ...(target ? { relationship: { targetEntityId: target.contract.entity.name } } : {}),
          cardinality: plainStringArray ? "many" as const : "one" as const,
          required: false,
          supports: { read: true, create: false, update: false },
        }];
      }));
      // A field typed as another entity (`x-osf-type: Relation`, as the compiler types every
      // reference in an operation schema) is that entity's belongsTo, the same projection a
      // core entity's reference field gets — so the record reads it by name, not by id.
      const relationships = Object.fromEntries(entity.fields.flatMap((key) => {
        const target = referenceTarget(recordProperties[key]!, targets);
        if (!target) return [];
        const { list, get } = target.operations;
        const projected: WebRelationshipProjection = {
          id: `${entityName}.${key}`,
          key,
          label: fields[key]!.label,
          kind: "belongsTo",
          targetEntityId: target.contract.entity.name,
          targetRoute: target.route,
          recordField: key,
          ownership: "reference",
          operations: { ...(list ? { list } : {}), ...(get ? { get } : {}) },
          ...(list ? { collection: { ...target.collection, operations: withoutCreate(target.collection.operations),
            id: `${target.contract.entity.name}.relationship.collection` } } : {}),
        };
        return [[key, projected]];
      }));
      const listRef = refs[entity.operations.list.operation]!;
      const listQuery = operationEntityCollectionQuery(
        listRef.id,
        listDefinition.input?.schema,
        listDefinition.output?.schema,
        entity.fields,
        Object.keys(entity.operations.list.bindings ?? {}),
      );
      const getRef = entity.operations.get ? refs[entity.operations.get.operation]! : undefined;
      const createRef = entity.operations.create ? refs[entity.operations.create.operation]! : undefined;
      if (createRef) {
        const properties = objectProperties(createRef.input.schema);
        for (const [input, context] of Object.entries(entity.operations.create?.bindings ?? {})) {
          if (!properties[input]) throw new Error(`${entityName}.create binding names unknown input ${input}.`);
          if (!Object.values(entity.operations.list.bindings ?? {}).includes(context)) {
            throw new Error(`${entityName}.create binding names unknown collection context ${context}.`);
          }
        }
      }
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
      const collectionActions = (entity.operations.collectionActions ?? []).map((key) =>
        collectionActionTarget(refs[key]!, entityName, entity.operations.list.bindings));
      const recordRoute = entity.recordRoute ?? `${entity.route}/:${entity.idField}`;
      const authoredLayout = entity.recordLayout;
      let recordPreset: "main-context" | "inbox-main-context" = "inbox-main-context";
      let recordTabs: WebRecordTab[] = [{ id: "overview", label: localized(undefined, "Overview"), groups: [{ id: "overview", title: localized(undefined, "Overview"), fields: entity.fields }] }];
      if (authoredLayout) {
        const onlyKeys = (value: object, allowed: readonly string[], scope: string) => {
          const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
          if (unsupported.length) throw new Error(`${entityName} recordLayout ${scope} does not support: ${unsupported.join(", ")}.`);
        };
        onlyKeys(authoredLayout, ["preset", "tabs"], "layout");
        if (!getRef) throw new Error(`${entityName} recordLayout requires a get Operation.`);
        if (authoredLayout.preset === "main") throw new Error(`${entityName} recordLayout preset main hides record actions and is not supported.`);
        recordPreset = authoredLayout.preset ?? "inbox-main-context";
        if (authoredLayout.tabs.length !== 1) throw new Error(`${entityName} recordLayout requires exactly one content tab; related route tabs remain available.`);
        const tab = authoredLayout.tabs[0]!;
        onlyKeys(tab, ["id", "label", "title", "groups"], "tab");
        if (!tab.id || !tab.groups?.length) throw new Error(`${entityName} recordLayout tab needs an id and field groups.`);
        const used = new Set<string>();
        const groups = tab.groups.map((group) => {
          onlyKeys(group, ["id", "title", "label", "fields"], "group");
          if (!group.id || !group.fields?.length) throw new Error(`${entityName} recordLayout group needs an id and fields.`);
          const keys = group.fields.map((entry) => {
            if (typeof entry !== "string" || !fields[entry]) throw new Error(`${entityName} recordLayout group ${group.id} references an unsupported or unknown field.`);
            if (used.has(entry)) throw new Error(`${entityName} recordLayout field ${entry} appears more than once.`);
            used.add(entry);
            return entry;
          });
          return { id: group.id, title: localized(group.title ?? group.label, group.id), fields: keys };
        });
        if (new Set(groups.map((group) => group.id)).size !== groups.length) throw new Error(`${entityName} recordLayout group ids must be unique.`);
        recordTabs = [{ id: tab.id, label: localized(tab.label ?? tab.title, tab.id), groups }];
      }
      entities[entityName] = {
        entityId: entityName,
        entitySlug: entity.route.replace(/^\//, ""),
        title: localized(entity.title, entityName),
        displayTemplate: `{{${entity.displayField}}}`,
        fields,
        operations: Object.fromEntries(Object.values(refs).map((ref) => [ref.key, ref])),
        operationSource: {
          idField: entity.idField,
          ...(entity.operations.create ? { create: { bindings: entity.operations.create.bindings ?? {} } } : {}),
          collection: {
            resultField: entity.operations.list.resultField,
            ...(entity.operations.list.bindings ? { bindings: entity.operations.list.bindings } : {}),
            ...(listQuery ? { query: {
              input: listQuery.input,
              nextCursorField: listQuery.nextCursorField,
              // Omitted, not null, when the Operation declares an unknown
              // total: the field names where to READ a total, and there is no
              // such place to name.
              ...(listQuery.totalCountField ? { totalCountField: listQuery.totalCountField } : {}),
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
            operations: { read: listRef, ...(createRef ? { create: createRef } : {}), ...(collectionActions.length ? { actions: collectionActions } : {}) },
            title: localized(entity.title, entityName),
            searchPlaceholder: { en: `Search ${localized(entity.title, entityName).en}`, nl: `Zoeken in ${localized(entity.title, entityName).nl}` },
            displayField: entity.displayField,
            ...(listQuery?.defaultSort ? { defaultSort: listQuery.defaultSort } : {}),
            columns: entity.columns.map((key) => ({ fieldId: `${entityName}.${key}`, key, label: fields[key]!.label })),
          },
          ...(getRef ? { record: {
            id: `${entityName}.record`, kind: "record", renderer: "operation.entity.record", preset: recordPreset,
            modes: ["read"], routes: { read: recordRoute },
            operations: { read: getRef, ...(recordActions.length ? { actions: recordActions } : {}) },
            titleTemplate: `{{${entity.displayField}}}`,
            layout: { tabs: recordTabs, context: { groups: [], relationships: [] } },
            labels: {},
          } } : {}),
        },
        relationships,
      } as unknown as WebEntityInterface;
    }
  }
  // Resolve provider-backed reference targets after every catalog entity exists.
  // A single authored route parameter unambiguously identifies the destination;
  // composite routes need explicit bindings, rather than guessing from names.
  for (const { entityName, key, targetName, valueField } of pendingReferences) {
    const owner = entities[entityName]!;
    const target = entities[targetName];
    if (!target?.operationSource || !target.views.collection) throw new Error(`Operation-backed reference ${entityName}.${key} has no projected target ${targetName}.`);
    if (valueField !== target.operationSource.idField) throw new Error(`Operation-backed reference ${entityName}.${key} must identify ${targetName} by its idField ${target.operationSource.idField}.`);
    if (owner.relationships[key]) throw new Error(`Operation-backed reference ${entityName}.${key} conflicts with an existing relationship.`);
    const record = target.views.record;
    const route = record?.routes.read;
    const parameters = route?.match(/:([a-zA-Z][a-zA-Z0-9_]*)/g) ?? [];
    const bindings = target.operationSource?.record?.bindings ?? {};
    if (!record?.operations.read || !route || parameters.length !== 1 || Object.values(bindings).some((value) => `:${value}` !== parameters[0])) {
      throw new Error(`Operation-backed reference ${entityName}.${key} needs a readable target with a single record route parameter and compatible get bindings.`);
    }
    const readInput = operations[record.operations.read.id]?.input.schema;
    const properties = readInput ? objectProperties(readInput) : {};
    const parameter = parameters[0]!.slice(1);
    const availableInputs = new Set([...Object.keys(bindings), ...(properties[parameter] ? [parameter] : [])]);
    const requiredInputs = readInput && Array.isArray(readInput.required) ? readInput.required : [];
    if (!readInput || !availableInputs.has(target.operationSource.idField) || Object.keys(bindings).some((inputKey) => !properties[inputKey]) || requiredInputs.some((inputKey) => typeof inputKey !== "string" || !availableInputs.has(inputKey))) {
      throw new Error(`Operation-backed reference ${entityName}.${key} cannot supply the target read Operation's required input from its record route.`);
    }
    const sourceRead = owner.views.record?.operations.read ?? owner.views.collection.operations.read;
    const sourceAuth = sourceRead && operations[sourceRead.id]?.auth;
    const targetAuth = operations[record.operations.read.id]?.auth;
    if (!sourceAuth || !targetAuth || sourceAuth.mode !== targetAuth.mode) {
      throw new Error(`Operation-backed reference ${entityName}.${key} cannot cross authentication realms.`);
    }
    const providerBindings = Object.fromEntries([...availableInputs].map((inputKey) => [inputKey, key]));
    const field = owner.fields[key]!;
    field.osfType = targetName;
    field.relationship = { targetEntityId: targetName };
    owner.relationships[key] = {
      id: `${entityName}.${key}`, key, label: field.label, kind: "belongsTo",
      targetEntityId: targetName, targetRoute: target.views.collection.route,
      recordField: key, ownership: "reference", source: { kind: "provider", bindings: providerBindings },
      operations: { get: record.operations.read },
    };
  }
  // A plugin may own a child resource while its parent Operation-backed entity
  // belongs to another catalog (for example a host capability below a core
  // platform tenant). Resolve those additions only after every catalog entity
  // exists, so catalogs remain independently owned and the relationship stays
  // declarative.
  for (const catalog of catalogs) {
    for (const [targetName, extension] of Object.entries(catalog.interfaces.web?.entityExtensions ?? {})
      .sort(([left], [right]) => left.localeCompare(right))) {
      const target = entities[targetName];
      if (!target?.operationSource) {
        throw new Error(`Operation-backed entity extension "${targetName}" from "${catalog.plugin}" has no target entity.`);
      }
      for (const related of extension.related) {
        if (!entities[related.entity]) {
          throw new Error(
            `Operation-backed entity extension "${targetName}" from "${catalog.plugin}" relates to unknown entity "${related.entity}".`,
          );
        }
        const current = target.operationSource.related ?? [];
        if (current.some((item) => item.entityId === related.entity || item.route === related.route)) {
          throw new Error(
            `Operation-backed entity extension "${targetName}" from "${catalog.plugin}" duplicates related entity "${related.entity}" or route "${related.route}".`,
          );
        }
        target.operationSource.related = [...current, {
          entityId: related.entity,
          label: localized(related.label, related.entity),
          route: related.route,
        }];
      }
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
