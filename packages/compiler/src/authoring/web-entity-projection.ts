// SPDX-License-Identifier: BUSL-1.1
/** Project entity fields, relationships, and views into the web manifest. */
import { compileCollectionTable } from "./collection-table.js";
import { collectBlueprintOperations } from "../blueprint-operations.js";
import { constrainedReferenceCreateOperationId } from "../generate-operations.js";
import { fieldOptionSource } from "./web-field-options.js";
import { compileFieldValuePolicy } from "./field-value-policy.js";
import { sortablePositionColumn } from "./sortable-position.js";
import type {
  CompiledEntityContract,
  CompiledField,
  CompiledViewGroup,
  CompiledRelationshipUsage,
} from "./types.js";
import type {
  WebCollectionQueryContract,
  WebCollectionView,
  WebEntityInterface,
  WebFieldProjection,
  WebOperationRef,
  WebRecordTab,
  WebRelationshipProjection,
  WebViewMode,
} from "@openshapeforge/interface-web";
import { assertVisibilityFields, formGroups, projectGroups, projectTabGroups, projectedRoute } from "./web-projectable-entities.js";
import { localized, objectProperties, operationEntityCollectionQuery, snakeToCamel, withoutCreate } from "./web-projection-helpers.js";
import { compileRelationshipPath, compileWebValuePath, type ProjectableEntity } from "./web-value-path.js";

function projectedTextLength(field: CompiledField): { maxLength?: number } {
  const rule = field.validation?.maxLength;
  const value = typeof rule === "object" ? rule.value : rule;
  return typeof value === "number" ? { maxLength: value } : {};
}

/** Logical fields shared by record screens and collection-scoped value editors. */
export function projectField(
  field: CompiledField,
  parent: string,
  supports: WebFieldProjection["supports"],
  editNested = false,
  presentations: Record<string, { render: NonNullable<WebFieldProjection["presentation"]> }> = {},
): WebFieldProjection {
  const nestedSupports = editNested ? supports : { read: true, create: false, update: false };
  const presentation = presentations[`${parent}.${field.key}`.split(".").slice(1).join(".")]?.render
    ?? (field.options?.presentation === "tiles"
      ? { component: "ChoiceTiles", ...(field.render.props ? { props: structuredClone(field.render.props) } : {}) }
      // The field's component always reaches the renderer, authored props or not.
      : field.render?.component ? structuredClone(field.render) : undefined);
  if (field.options?.presentation && field.options.type !== "static") {
    throw new Error(`${parent}.${field.key}: options.presentation "${field.options.presentation}" requires static options.`);
  }
  const optionSource = fieldOptionSource(field);
  const fieldPolicy = compileFieldValuePolicy(field);
  // Presentation props are applied after the semantic unit by field renderers.
  // Project the same effective unit for compact renderers and summaries.
  const unit = typeof presentation?.props?.unit === "string" ? presentation.props.unit : field.unit;
  return {
    id: `${parent}.${field.key}`, key: field.key,
    label: localized(field.label, field.key), description: localized(field.description, ""),
    osfType: field.osfType,
    ...(unit ? { unit } : {}),
    ...(field.document ? { document: structuredClone(field.document) } : {}),
    baseType: field.baseType,
    cardinality: field.cardinality === "collection" ? "many" : "one",
    required: field.required,
    ...(fieldPolicy ? { fieldPolicy } : {}),
    ...(field.authoring ? { authoring: structuredClone(field.authoring) } : {}),
    ...(presentation ? { presentation } : field.options?.presentation === "tiles" ? { presentation: { component: "ChoiceTiles" } } : {}),
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
    // The logical binding and the head entity it resolves to; the snapshot column stays server-side storage.
    ...(field.valueFieldsFrom ? { valueFieldsFrom: {
      reference: field.valueFieldsFrom.reference, field: field.valueFieldsFrom.field,
      ...(field.valueFieldsFrom.headEntity ? { headEntity: field.valueFieldsFrom.headEntity } : {}),
    } } : {}),
    ...(field.typedBy ? { typedBy: { ...field.typedBy } } : {}),
    ...(field.allowedDefinitions ? { allowedDefinitions: [...field.allowedDefinitions].sort() } : {}),
    ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
    ...(field.defaultTemplate !== undefined ? { defaultTemplate: field.defaultTemplate } : {}),
    ...(field.options?.items?.length ? { options: field.options.items.map(({ value, label, icon }) => ({ value, label: localized(label, value), ...(icon ? { icon } : {}) })) } : {}),
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
  const create = provider.views.collection.operations.create;
  const createBindings: Record<string, string> = {};
  for (const [inputField, context] of Object.entries(provider.operationSource?.create?.bindings ?? {})) {
    const listInput = Object.entries(provider.operationSource?.collection.bindings ?? {}).find(([, value]) => value === context)?.[0] ?? context;
    const ownField = bindings[listInput];
    if (!ownField || !fields[ownField]) throw new Error(`${origin}: create context ${context} has no parent binding.`);
    createBindings[inputField] = ownField;
  }
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
    source: { kind: "provider", bindings: { ...bindings }, ...(create ? { createBindings } : {}),
      ...(provider.operationSource?.collection.query ? { query: structuredClone(provider.operationSource.collection.query) } : {}) },
    operations: { list, ...(get ? { get } : {}), ...(create ? { create } : {}) },
    collection: { ...provider.views.collection, id: `${provider.entityId}.relationship.collection` },
  }]];
}

/**
 * Fields the server fills on create, so no form offers them: the secure-input
 * target, derived-on-create fields, every collection, and the foreign key of
 * an owned inverse collection (the owner's atomic insert writes it).
 */
function serverOwnedFieldKeys(source: ProjectableEntity, all: ReadonlyMap<string, ProjectableEntity>): Set<string> {
  const { contract } = source;
  const entityName = contract.entity.name;
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
  return serverOwnedFields;
}

/**
 * The keys a create of `source` accepts from the user: the fields its create
 * form shows, plus every single entity reference the server does not own.
 * A reference key is accepted without being shown so a parent record can
 * pre-fill it ("add a child from here"); it stays out when the field is
 * read-only, derived on create or written by an owner's atomic insert. Empty
 * when generic create is unsupported or the entity has no create form.
 */
function createWritableFieldKeys(source: ProjectableEntity, all: ReadonlyMap<string, ProjectableEntity>): Set<string> {
  const createVariant = source.view?.form?.variants.create;
  if (!createVariant || unsupportedGenericCreate(source, all)) return new Set();
  const serverOwned = serverOwnedFieldKeys(source, all);
  const inForm = new Set(formGroups(createVariant, undefined, serverOwned).flatMap(({ fields }) => fields));
  return new Set(source.contract.model.fields
    .filter((field) => !field.readOnly && !field.deriveOnCreate &&
      (inForm.has(field.key) || (field.relationship?.kind === "belongsTo" && !serverOwned.has(field.key))))
    .map((field) => field.key));
}

/**
 * A derived collection offers "create a child from here" when the child form
 * can be pre-filled with the parent key: the child supports generic create
 * and the referencing field is one the user may write on create. An owned
 * collection's key is server-owned (the atomic insert writes it), so it
 * keeps no create — the owned-collection Operations are its way.
 */
function collectionCreateSupported(
  relationship: CompiledEntityContract["model"]["relationships"][number],
  target: ProjectableEntity,
  all: ReadonlyMap<string, ProjectableEntity>,
): boolean {
  if (relationship.kind !== "hasMany" || relationship.through || !relationship.foreignKey || !target.operations.create) return false;
  const referencing = target.contract.storage.columns.find((column) => column.column === relationship.foreignKey)?.field;
  return referencing !== undefined && createWritableFieldKeys(target, all).has(referencing);
}

const relationshipActionKeys = ["create", "insert", "move", "update", "remove"] as const;

function narrowRelationshipList(
  operation: WebOperationRef,
  usage: CompiledRelationshipUsage,
  origin: string,
  boundFilterField?: string,
): WebOperationRef {
  const input = operation.input;
  if (operation.intent !== "list" || input?.kind !== "collection-query") {
    throw new Error(`${origin}: related collection has no canonical list query contract.`);
  }
  return { ...operation, input: narrowRelationshipQuery(input, usage, origin, boundFilterField) };
}

function narrowRelationshipQuery(
  input: WebCollectionQueryContract, usage: CompiledRelationshipUsage, origin: string, boundFilterField?: string,
): WebCollectionQueryContract {
  const overrides = usage.overrides;
  const narrow = (requested: readonly string[] | undefined, available: readonly string[], name: string): readonly string[] => {
    if (!requested) return available;
    const unsupported = requested.filter((key) => !available.includes(key));
    if (unsupported.length) throw new Error(`${origin}: ${name} expands the target list Operation with ${unsupported.join(", ")}.`);
    return [...requested];
  };
  const defaultLimit = overrides?.pageSize ?? input.pagination.defaultLimit;
  if (!Number.isInteger(defaultLimit) || defaultLimit < 1 || defaultLimit > input.pagination.maxLimit) {
    throw new Error(`${origin}: pageSize must be between 1 and ${input.pagination.maxLimit}.`);
  }
  const filterFields = narrow(overrides?.filters, input.filterFields, "filters");
  return {
      ...input,
      filterFields: boundFilterField && !filterFields.includes(boundFilterField)
        ? [...filterFields, boundFilterField]
        : filterFields,
      sortFields: narrow(overrides?.sortFields, input.sortFields, "sortFields"),
      pagination: { ...input.pagination, defaultLimit },
  };
}

function applyRelationshipUsage(
  relationship: WebRelationshipProjection,
  usage: CompiledRelationshipUsage | undefined,
  target: ProjectableEntity | WebEntityInterface | undefined,
  origin: string,
): WebRelationshipProjection {
  if (!usage?.overrides || !relationship.collection || !relationship.operations.list || !target) return relationship;
  const overrides = usage.overrides;
  const providerQuery = relationship.source?.query;
  // Keep the executable invoke schema intact; only its UI query projection is
  // narrowed. Parent bindings remain mandatory and are never search controls.
  const narrowedQuery = providerQuery ? {
    ...providerQuery, input: narrowRelationshipQuery(providerQuery.input, usage, origin),
  } : undefined;
  const list = narrowedQuery ? relationship.operations.list
    : narrowRelationshipList(relationship.operations.list, usage, origin, relationship.recordField);
  const allowedActions = overrides.actions ? new Set(overrides.actions) : undefined;
  const operations = { ...relationship.operations, list };
  for (const key of relationshipActionKeys) {
    if (allowedActions && !allowedActions.has(key)) delete operations[key];
  }
  const columnByKey = new Map(relationship.collection.columns.map((column) => [column.key, column]));
  const fieldByKey = new Map(('contract' in target ? target.contract.model.fields : Object.values(target.fields))
    .map((field) => [field.key, field]));
  const targetName = 'contract' in target ? target.contract.entity.name : target.entityId;
  const presentation = overrides.presentation;
  if (presentation) {
    for (const key of [presentation.titleField, presentation.timestampField, presentation.descriptionField, presentation.relatedField, presentation.iconField].filter(Boolean)) {
      if (!fieldByKey.has(key!)) throw new Error(`${origin}: timeline field ${key} is not a field of ${targetName}.`);
    }
    if (presentation.icons && (!presentation.iconField || (fieldByKey.get(presentation.iconField)?.baseType !== "string" || fieldByKey.get(presentation.iconField)?.cardinality === "collection"))) throw new Error(`${origin}: timeline icons require an existing single string icon field.`);
    const dateField = fieldByKey.get(presentation.timestampField)!;
    if (!["date", "datetime"].includes(dateField.baseType)) throw new Error(`${origin}: timeline timestamp must be a date or datetime field.`);
    if (presentation.relatedField && !fieldByKey.get(presentation.relatedField)?.relationship) throw new Error(`${origin}: timeline relatedField must be a canonical reference.`);
  }

  const columns = overrides.columns?.map((entry) => {
    const key = typeof entry === "string" ? entry : entry.key;
    const field = fieldByKey.get(key);
    if (!field) throw new Error(`${origin}: column ${key} is not a field of ${targetName}.`);
    return {
      fieldId: `${targetName}.${key}`,
      key,
      label: localized(typeof entry === "string" ? columnByKey.get(key)?.label ?? field.label : entry.label ?? field.label, key),
    };
  }) ?? relationship.collection.columns;
  const sortFields = narrowedQuery?.input.sortFields ?? (list.input?.kind === "collection-query" ? list.input.sortFields : []);
  const defaultSort = overrides.sort ?? relationship.collection.defaultSort;
  if (defaultSort && !sortFields.includes(defaultSort.key)) {
    throw new Error(`${origin}: default sort ${defaultSort.key} is not exposed by this placement.`);
  }
  const collectionOperations = { ...relationship.collection.operations, read: list };
  if (!operations.create) delete collectionOperations.create;
  return {
    ...relationship,
    ...(narrowedQuery ? { source: { ...relationship.source!, query: narrowedQuery } } : {}),
    operations,
    collection: {
      ...(presentation ? { presentation } : {}),
      ...relationship.collection,
      operations: collectionOperations,
      columns,
      ...(overrides.title ? { title: localized(overrides.title, relationship.collection.title.en) } : {}),
      ...(defaultSort ? { defaultSort } : {}),
    },
  };
}

/**
 * The authored collection tree: `children` must be a stored collection
 * relationship of the entity, `label` and `count` fields of it.
 */
function collectionTree(contract: CompiledEntityContract): WebCollectionView["tree"] {
  const tree = contract.interfaces?.web?.collectionTree;
  if (!tree) return undefined;
  const entityName = contract.entity.name;
  const children = contract.model.relationships.find((relationship) => relationship.key === tree.children);
  if (!children || children.kind !== "hasMany" || children.provider) {
    throw new Error(`${entityName}: collection tree children ${tree.children} must be a stored collection relationship of ${entityName}.`);
  }
  if (tree.parent && !contract.model.relationships.some(edge => edge.key === tree.parent && edge.kind === "belongsTo" && !edge.provider)) throw new Error(`${entityName}: collection tree parent ${tree.parent} must be a stored belongsTo relationship of ${entityName}.`);
  for (const key of ["label", "count", "parent"] as const) {
    const field = tree[key];
    if (field !== undefined && !contract.model.fields.some((candidate) => candidate.key === field)) {
      throw new Error(`${entityName}: collection tree ${key} ${field} is not a field of ${entityName}.`);
    }
  }
  return { children: tree.children, ...(tree.parent ? {parent:tree.parent}:{}), ...(tree.label ? { label: tree.label } : {}), ...(tree.count ? { count: tree.count } : {}), ...(tree.through ? { through: tree.through } : {}) };
}

export function projectEntity(
  source: ProjectableEntity,
  all: ReadonlyMap<string, ProjectableEntity>,
  providers: ReadonlyMap<string, WebEntityInterface> = new Map(),
  updateLayout?: readonly CompiledViewGroup[],
): WebEntityInterface {
  const { contract, view, customOperations } = source;
  const createUnsupported = unsupportedGenericCreate(source, all);
  const operations: ProjectableEntity["operations"] = createUnsupported ? withoutCreate(source.operations) : source.operations;
  const entityName = contract.entity.name;
  const createVariant = view?.form?.variants.create;
  const updateVariant = view?.form?.variants.edit;
  const serverOwnedFields = serverOwnedFieldKeys(source, all);
  const createGroups = createUnsupported ? [] : formGroups(createVariant, undefined, serverOwnedFields);
  const authoredCreateGroups = formGroups(createVariant, undefined, serverOwnedFields);
  const updateExcluded = new Set([...serverOwnedFields, ...contract.model.fields.filter(field => field.readOnly || field.immutable).map(field => field.key)]);
  const updateGroups = updateLayout ? projectGroups(updateLayout, updateExcluded) : formGroups(updateVariant, createVariant, serverOwnedFields);
  const createFields = createWritableFieldKeys(source, all);
  const updateFields = new Set(updateGroups.flatMap(({ fields }) => fields));
  // A provider-backed reference is only a relationship: it has no value of its
  // own to read or write, so it is not a field on any interface.
  const providerFieldKeys = new Set(contract.model.relationships.flatMap((relationship) => relationship.provider && relationship.fieldKey ? [relationship.fieldKey] : []));
  const explicitFields = contract.model.fields.filter((field) => !providerFieldKeys.has(field.key)).map((field) => {
    const projected = projectField(field, entityName, {
        read: true,
        create: createFields.has(field.key),
        update: !field.readOnly && !field.immutable && !field.deriveOnCreate && updateFields.has(field.key),
    }, false, contract.interfaces?.web?.fields);
    return [field.key, projected] as const;
  });
  // Every single entity reference is an authored field, so its writability and
  // presentation are projected above; relationships add no implicit fields.
  const fields = Object.fromEntries(explicitFields);
  assertVisibilityFields(entityName, "Web action", Object.values(customOperations), fields);
  const tree = collectionTree(contract);
  const table = compileCollectionTable(source, all);
  const authoredBoard = contract.interfaces?.web?.collectionBoard;
  let board: WebCollectionView["board"];
  if (authoredBoard) {
    const group = fields[authoredBoard.groupBy];
    if (!group || group.cardinality !== "one" || (!group.relationship && !group.optionSource && !group.options?.length)) {
      throw new Error(`${entityName}: board grouping requires a single relationship or choice field.`);
    }
    if (group.relationship && !group.optionSource && !group.options?.length && !all.get(group.relationship.targetEntityId)?.operations.list) {
      throw new Error(`${entityName}: board grouping requires a readable collection of choices.`);
    }
    if (authoredBoard.scopeBy) {
      const target = group.relationship && all.get(group.relationship.targetEntityId);
      const scope = target?.contract.model.fields.find(field => field.key === authoredBoard.scopeBy);
      const providerField = target?.contract.model.relationships.some(item => item.provider && item.fieldKey === authoredBoard.scopeBy);
      const input = target?.collection.operations.read.input;
      if (!scope || scope.cardinality === "collection" || scope.baseType !== "string" || scope.computed || providerField
        || !target?.contract.storage.columns.some(column => column.field === scope.key)
        || (input?.kind === "collection-query" && !input.filterFields.includes(scope.key))) {
        throw new Error(`${entityName}: board scope must name a persisted filterable single scalar field on the grouping entity.`);
      }
    }
    if (authoredBoard.groupSummary) {
      const target = group.relationship && all.get(group.relationship.targetEntityId);
      if (!group.relationship) {
        throw new Error(`${entityName}: board group summary requires an entity relationship for grouping.`);
      }
      // The header is populated from the same authorized collection that supplies
      // the lanes; a get-only or unrelated option source cannot provide it.
      if (!target || target.contract.source || !target.operations.list
        || (group.optionSource && (group.optionSource.type !== "entity" || group.optionSource.source !== group.relationship.targetEntityId))
        || (!group.optionSource && group.options?.length)) {
        throw new Error(`${entityName}: board group summary requires a readable grouping entity collection.`);
      }
      const summary = target?.contract.model.fields.find(field => field.key === authoredBoard.groupSummary);
      const provider = target?.contract.model.relationships.some(item => item.fieldKey === authoredBoard.groupSummary);
      if (!summary || summary.cardinality === "collection" || summary.baseType === "object" || summary.relationship?.target || provider) {
        throw new Error(`${entityName}: board group summary must name a scalar field on the grouping entity.`);
      }
    }
    const valuePath = (expression: string) => compileWebValuePath(source, all, expression, "board");
    const title = (Array.isArray(authoredBoard.card.title) ? authoredBoard.card.title : [authoredBoard.card.title]).map(valuePath);
    if (!title.length) throw new Error(`${entityName}: board card title requires at least one path.`);
    if (title.some(part => part.cardinality !== "one")) throw new Error(`${entityName}: board card title must be single-valued.`);
    const timestamp = authoredBoard.card.timestamp && valuePath(authoredBoard.card.timestamp);
    if (timestamp && (!timestamp.field || timestamp.cardinality !== "one" || all.get(timestamp.targetEntityId)?.contract.model.fields.find(field => field.key === timestamp.field)?.baseType !== "datetime")) {
      throw new Error(`${entityName}: board card timestamp must be a single datetime field.`);
    }
    const indicator = authoredBoard.card.indicator ? contract.model.fields.find(field => field.key === authoredBoard.card.indicator) : undefined;
    if (authoredBoard.card.indicator && (!indicator?.computed || !("kind" in indicator.computed) || indicator.computed.kind !== "temporalThreshold")) {
      throw new Error(`${entityName}: board indicator must reference a temporal threshold field.`);
    }
    // The avatar is the record a single reference names, read like any other card path.
    const avatarKey = authoredBoard.card.avatar;
    const avatarReference = avatarKey ? contract.model.relationships.find(item => item.fieldKey === avatarKey && item.kind === "belongsTo" && !item.provider) : undefined;
    const avatar = avatarReference && fields[avatarKey!]?.cardinality === "one" ? valuePath(avatarKey!) : undefined;
    if (avatarKey && (!avatar || avatar.field || avatar.cardinality !== "one" || avatar.targetEntityId !== avatarReference!.target)) {
      throw new Error(`${entityName}: board card avatar must name a single reference field.`);
    }
    const money = (amountExpression: string, currencyExpression: string, persisted: boolean) => {
      const amount = valuePath(amountExpression);
      const currency = valuePath(currencyExpression);
      const target = all.get(amount.targetEntityId);
      const amountField = target?.contract.model.fields.find(item => item.key === amount.field);
      const currencyField = target?.contract.model.fields.find(item => item.key === currency.field);
      if (!amount.field || !currency.field || amount.cardinality !== "one" || currency.cardinality !== "one"
        || amount.targetEntityId !== currency.targetEntityId || JSON.stringify(amount.path) !== JSON.stringify(currency.path)
        || !amountField || !["number", "integer"].includes(amountField.baseType) || currencyField?.baseType !== "string") {
        throw new Error(`${entityName}: board amount and currency must be single scalar fields on the same record reached by the same path.`);
      }
      if (persisted) {
        const groupColumn = source.contract.storage.columns.find(column => column.field === authoredBoard.groupBy);
        if (!groupColumn) throw new Error(`${entityName}: board aggregate requires a persisted grouping field.`);
        let owner = source;
        for (const step of amount.path) {
          const relationship = owner.contract.model.relationships.find(item => `${owner.contract.entity.name}.${item.key}` === step.relationshipId);
          const next = relationship && all.get(relationship.target);
          if (!relationship || relationship.kind !== "belongsTo" || !relationship.foreignKey || relationship.provider || (relationship.constraints && Object.keys(relationship.constraints).length > 0) || !next || next.contract.source) {
            throw new Error(`${entityName}: board aggregate requires persisted belongs-to relationships.`);
          }
          owner = next;
        }
        const stored = (field: typeof amountField) => !field.computed && !field.typedBy && (!field.variables || field.variables === "none") && owner.contract.storage.columns.some(column => column.field === field.key);
        const amountColumn = owner.contract.storage.columns.find(column => column.field === amountField.key);
        const currencyColumn = owner.contract.storage.columns.find(column => column.field === currencyField!.key);
        if (!stored(amountField) || !stored(currencyField!) || !amountColumn || !["numeric", "integer", "bigint"].includes(amountColumn.type) || currencyColumn?.type !== "text") {
          throw new Error(`${entityName}: board aggregate requires persisted scalar fields and an exact numeric amount.`);
        }
      }
      return { amount, currency };
    };
    const cardAmount = authoredBoard.card.amount && money(authoredBoard.card.amount.value, authoredBoard.card.amount.currency, false);
    const aggregate = authoredBoard.aggregate && money(authoredBoard.aggregate.sum, authoredBoard.aggregate.currency, true);
    board = { groupBy: authoredBoard.groupBy, ...(authoredBoard.scopeBy ? { scopeBy: authoredBoard.scopeBy } : {}), ...(authoredBoard.groupSummary ? { groupSummary: authoredBoard.groupSummary } : {}), ...(aggregate ? { aggregate: { sum: aggregate.amount, currency: aggregate.currency } } : {}), card: { title, ...(timestamp ? { timestamp } : {}), ...(indicator ? { indicator: indicator.key } : {}), ...(avatar ? { avatar } : {}), ...(authoredBoard.card.subtitle ? { subtitle: authoredBoard.card.subtitle.map(valuePath) } : {}), ...(cardAmount ? { amount: { value: cardAmount.amount, currency: cardAmount.currency } } : {}), body: (authoredBoard.card.body ?? []).map(valuePath) } };
  }
  for (const groups of [authoredCreateGroups, updateGroups]) assertVisibilityFields(entityName, "form group", groups, fields);

  let relationships = Object.fromEntries(contract.model.relationships.flatMap((relationship) => {
    if (relationship.provider) return projectProviderRelationship(entityName, relationship, providers, fields);
    const target = all.get(relationship.target);
    if (contract.source && !relationship.foreignKey && !relationship.via) {
      // Operations-backed entity: project display-only belongsTo reference using the
      // source field as recordField. Requires a target get Operation to resolve the record.
      if (!target || relationship.kind !== "belongsTo" || !relationship.fieldKey) return [];
      const get = target.operations.get;
      if (!get) return [];
      const projected: WebRelationshipProjection = {
        id: `${entityName}.${relationship.key}`,
        key: relationship.key,
        label: localized(relationship.label, relationship.key),
        kind: "belongsTo",
        targetEntityId: target.contract.entity.name,
        targetRoute: target.route,
        recordField: relationship.fieldKey,
        fieldKey: relationship.fieldKey,
        ...(relationship.ownership ? { ownership: relationship.ownership } : {}),
        operations: { get },
      };
      return [[relationship.key, projected]];
    }
    if (!target || (!relationship.foreignKey && !relationship.via)) return [];
    const list = target.operations.list;
    const get = target.operations.get;
    // A single reference never creates its target from the picker; a
    // collection creates a child when the child form can carry the parent key.
    const create = collectionCreateSupported(relationship, target, all) ? target.operations.create : undefined;
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
      ...(relationship.version ? { version: relationship.version } : {}),
      ...(relationship.childLock ? { childLock: relationship.childLock } : {}),
      ...(relationship.cardinality ? { cardinality: relationship.cardinality } : {}),
      ...(relationship.sortable ? { sortable: true, positionColumn: sortablePositionColumn(relationship.foreignKey!) } : {}),
      ...(relationship.via ? { via: relationship.via } : {}),
      ...(relationship.through ? { through: relationship.through } : {}),
      ...(relationship.fieldKey && relationship.kind !== "belongsTo" ? { mutationSupport: Object.keys(nativeOperations).length ? "atomic" as const : "unsupported" as const } : {}),
      operations: { ...(list ? { list } : {}), ...(get ? { get } : {}), ...(create ? { create } : {}), ...nativeOperations },
      ...(list ? { collection: { ...target.collection,
        ...(create ? {} : { operations: withoutCreate(target.collection.operations) }),
        id: `${target.contract.entity.name}.relationship.collection` } } : {}),
    };
    return [[relationship.key, projected]];
  }));

  const placements = (groups: readonly CompiledViewGroup[]): CompiledViewGroup[] => groups.flatMap(group => [group, ...placements(group.groups ?? [])]);
  for (const tab of placements(view?.detail?.groups.items ?? [])) {
    const usage = tab.relationship;
    if (!usage?.name || !relationships[usage.name]) continue;
    let relationship = relationships[usage.name]!;
    let target = all.get(relationship.targetEntityId) ?? providers.get(relationship.targetEntityId);
    let placement = usage.name;
    if (usage.through) {
      const association = all.get(relationship.targetEntityId);
      const reference = association?.contract.model.relationships.find(item => item.kind === "belongsTo" && item.fieldKey === usage.through);
      const destination = reference && all.get(reference.target);
      const inverse = destination?.contract.model.relationships.find(item => item.kind === "hasMany" && item.target === association?.contract.entity.name && item.foreignKey === reference?.foreignKey);
      if (relationship.kind !== "hasMany" || !relationship.recordField || !reference || !destination?.operations.list || !inverse) {
        throw new Error(`${entityName}.${tab.id}: through ${usage.through} must resolve a canonical association reference and inverse target collection.`);
      }
      placement = `${usage.name}__${usage.through}`;
      target = destination;
      relationship = {
        id: `${entityName}.${placement}`, key: placement, label: localized(tab.label ?? tab.title, tab.id),
        kind: "hasMany", targetEntityId: destination.contract.entity.name, targetRoute: destination.route,
        recordField: relationship.recordField,
        association: { entityId: association!.contract.entity.name, relationship: inverse.key, parentField: relationship.recordField },
        operations: { list: destination.operations.list, ...(destination.operations.get ? { get: destination.operations.get } : {}) },
        collection: { ...destination.collection, operations: withoutCreate(destination.collection.operations) },
      };
    }
    relationships = {
      ...relationships,
      [placement]: applyRelationshipUsage(relationship, usage, target, `${entityName}.${tab.id}.${placement}`),
    };
  }

  const projectRecordTab = (tab: CompiledViewGroup): WebRecordTab[] => {
    const relationshipId = tab.relationship?.through ? `${tab.relationship.name}__${tab.relationship.through}` : tab.relationship?.name;
    if (relationshipId && !relationships[relationshipId]) return [];
    const requestedView = tab.relationship?.view;
    if (requestedView) {
      const relation = relationships[relationshipId!];
      const target = relation && all.get(relation.targetEntityId);
      const namedView = target?.contract.interfaces?.web?.namedViews?.[requestedView];
      const targetKind = requestedView === "record" && target?.view?.detail ? "record"
        : requestedView === "collection" ? "collection" : namedView?.kind;
      const expectedKind = relation?.kind === "belongsTo" ? "record" : "collection";
      if (!target || targetKind !== expectedKind || (targetKind === "record" && !target.operations.get)) {
        throw new Error(`${entityName}.${relationshipId}: target view ${requestedView} must be an available ${expectedKind} view on ${relation?.targetEntityId ?? "the target"}.`);
      }
    }
    return [{
      id: tab.id,
      ...(tab.showInReadNavigation !== undefined ? { showInReadNavigation: tab.showInReadNavigation } : {}),
      label: localized(tab.label ?? tab.title, tab.id),
      ...(tab.visibleWhen ? { visibleWhen: structuredClone(tab.visibleWhen) } : {}),
      groups: projectTabGroups(tab),
      ...(relationshipId ? { relationshipId } : {}),
      ...(requestedView ? { targetView: requestedView } : {}),
    }];
  };
  for (const group of placements(view?.detail?.groups.items ?? []).filter(group => group.relationship?.view)) {
    if (group.fields?.length || group.groups?.length) throw new Error(`${entityName}.${group.id}: a target view placement cannot also declare local fields or groups.`);
    projectRecordTab(group);

  }
  const tabs: WebRecordTab[] = (view?.detail?.groups.items ?? []).flatMap(projectRecordTab);
  assertVisibilityFields(entityName, "detail tab", tabs, fields);
  assertVisibilityFields(entityName, "detail group", tabs.flatMap(({ groups }) => groups), fields);
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
  const contextRecordKeys = new Set<string>();
  const contextRecords = authoredContext?.records?.map(definition => {
    if (contextRecordKeys.has(definition.key)) throw new Error(`${entityName}: duplicate context record ${definition.key}.`);
    contextRecordKeys.add(definition.key);
    const { path, target: owner } = compileRelationshipPath(entityName, source, all, definition.path);
    const displayField = definition.displayField ?? owner.collection.displayField;
    const display = owner.contract.model.fields.find(field => field.key === displayField);
    if (!display || display.baseType !== "string" || display.cardinality === "collection") throw new Error(`${entityName}: context record display field ${displayField} must be a single string.`);
    for (const [key, value] of Object.entries(definition.when ?? {})) {
      const field = owner.contract.model.fields.find(field => field.key === key);
      const valueType = field && contextConditionValueTypes[field.baseType];
      if (!field || field.cardinality === "collection" || !valueType
        || (value !== null && (typeof value !== valueType || (field.baseType === "integer" && !Number.isInteger(value))))) throw new Error(`${entityName}: context condition ${key} requires a matching scalar field.`);
    }
    if (definition.status) {
      const statusField = owner.contract.model.fields.find(field => field.key === definition.status!.field);
      if (!statusField || statusField.baseType !== "string" || statusField.cardinality === "collection") throw new Error(`${entityName}: context status requires a single string field.`);
    }
    return { key: definition.key, label: localized(definition.label, definition.key), path, targetEntityId: owner.contract.entity.name, displayField,
      ...(definition.when ? { when: definition.when } : {}), ...(definition.tone ? { tone: definition.tone } : {}),
      ...(definition.labelEmphasis !== undefined ? { labelEmphasis: definition.labelEmphasis } : {}), ...(definition.status ? { status: definition.status } : {}) };
  });
  const contacts = authoredContext?.contacts;
  if (contacts) {
    const assertContactField = (relationshipKey: string, fieldKey: string) => {
      const relationship = relationships[relationshipKey];
      const target = relationship && all.get(relationship.targetEntityId);
      const field = target?.contract.model.fields.find(field => field.key === fieldKey);
      if (relationship?.kind !== "hasMany" || !relationship.operations.list || !field || field.baseType !== "string" || field.cardinality === "collection") {
        throw new Error(`${entityName}: contact context ${relationshipKey}.${fieldKey} requires a readable collection with a single string field.`);
      }
    };
    assertContactField(contacts.relationship, contacts.channelField);
    assertContactField(contacts.relationship, contacts.valueField);
    if (contacts.preferredChannelField && (!fields[contacts.preferredChannelField]?.supports.read || fields[contacts.preferredChannelField]?.baseType !== "string")) {
      throw new Error(`${entityName}: contact context preferred channel must be a readable string field.`);
    }
    if (contacts.language) assertContactField(contacts.language.relationship, contacts.language.field);
    const channelKeys = new Set<string>();
    const child = all.get(relationships[contacts.relationship]!.targetEntityId)!;
    for (const channel of contacts.channels ?? []) {
      if (channelKeys.has(channel.key) || !channel.types.length) throw new Error(`${entityName}: contact channels need unique keys and source types.`);
      channelKeys.add(channel.key);
      for (const [key, value] of Object.entries(channel.when ?? {})) {
        const field = child.contract.model.fields.find(field => field.key === key);
        if (!field || field.cardinality === "collection" || field.baseType !== typeof value) throw new Error(`${entityName}: contact condition ${key} must match an existing child field type.`);
      }
    }
  }
  const breadcrumbParent = contract.interfaces?.web?.recordBreadcrumbParent;
  if (breadcrumbParent !== undefined) {
    const parent = relationships[breadcrumbParent];
    if (parent?.kind !== "belongsTo" || !parent.recordField || parent.via || parent.through ||
      parent.targetEntityId === entityName || !fields[parent.recordField]?.supports.read) {
      throw new Error(`${entityName}: breadcrumbParent must name a readable direct reference to another entity.`);
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
    renderer: contract.interfaces?.web?.renderers?.record ?? (contract.source ? "operation.entity.record" : "entity.record"),
    preset: contract.interfaces?.web?.recordPreset ?? "inbox-main-context",
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
      ...(breadcrumbParent !== undefined ? { breadcrumbParent } : {}),
      ...(contract.interfaces?.web?.recordWorkspaceTabs !== undefined ? { workspaceTabs: contract.interfaces.web.recordWorkspaceTabs } : {}),
      context: {
        ...(contextRecords?.length ? { records: contextRecords } : {}),
        ...(contacts ? { contacts: {
          relationshipId: contacts.relationship, channelField: contacts.channelField, valueField: contacts.valueField,
          ...(contacts.channels ? { channels: contacts.channels.map(channel => ({ key: channel.key, types: channel.types, ...(channel.label ? { label: localized(channel.label, channel.key) } : {}), ...(channel.when ? { when: channel.when } : {}) })) } : {}),
          ...(contacts.preferredChannelField ? { preferredChannelField: contacts.preferredChannelField } : {}),
          ...(contacts.language ? { language: { relationshipId: contacts.language.relationship, field: contacts.language.field } } : {}),
        } } : {}),
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

  // Named records use exactly the same projection as the default record. Their
  // relationship overrides stay local to the selected view, not the entity.
  const named = Object.fromEntries(Object.entries(contract.interfaces?.web?.namedViews ?? {}).map(([name, definition]) => {
    if (definition.kind === "collection" && "route" in definition && definition.route) {
      if (definition.collectionLayout !== "table") throw new Error(`${entityName}.${name}: a routed collection requires table layout.`);
      const route = projectedRoute(definition.route, source.routeLocale ?? "en", source.route);
      if (route === source.route) throw new Error(`${entityName}.${name}: a named collection route must differ from the default route.`);
      const { namedViews: _named, collectionTree: _tree, collectionTable: _table, collectionFilter: _filter, collectionBoard: _board, ...web } = contract.interfaces!.web!;
      const projected = projectEntity({ ...source, route,
        collection: { ...source.collection, route, title: localized(definition.title, source.collection.title.en) },
        contract: { ...contract, interfaces: { ...contract.interfaces, web: { ...web, ...(definition.tree ? { collectionTree: definition.tree } : {}), ...(definition.table ? { collectionTable: definition.table } : {}) } } },
      }, all, providers);
      return [name, { ...projected.views.collection, ...(definition.filter ? { filter: definition.filter } : {}), id: `${entityName}.${name}`, collectionLayout: "table" as const }];
    }
    if (definition.kind === "collection" && definition.collectionLayout === "matrix" && "source" in definition.matrix) {
      const { read, apply, rows, measures, total, refresh = [] } = definition.matrix;
      if (rows && (!fields[rows.parentField]?.supports.read || fields[rows.parentField]?.cardinality !== "one")) throw new Error(`${entityName}.${name}: matrix field ${rows.parentField} must be readable and single.`);
      return [name, { kind: "collection" as const, collectionLayout: "matrix" as const, matrix: {
        source: "operation" as const, read, ...(apply ? { apply } : {}), ...(rows ? { rows } : {}),
        measures: measures.map(measure => ({
          key: measure.key, label: localized(measure.label, measure.key), heading: localized(measure.heading ?? measure.label, measure.key),
          format: measure.format, align: measure.align ?? "end", editable: measure.editable ?? false,
        })),
        ...(total ? { total: localized(total, "Total") } : {}),
        refresh: [...new Set([entityName, ...refresh])],
      } }];
    }
    if (definition.kind === "collection" && definition.collectionLayout === "matrix") {
      const { rowField, columnField, valueField } = definition.matrix as import("./types.js").RecordMatrixDefinition;
      for (const key of [rowField, columnField, valueField]) {
        if (!fields[key]?.supports.read || fields[key]?.cardinality !== "one") throw new Error(`${entityName}.${name}: matrix field ${key} must be readable and single.`);
      }
      for (const key of [rowField, columnField]) {
        if (fields[key]!.baseType !== "string") throw new Error(`${entityName}.${name}: matrix axes require string or entity-reference fields.`);
      }
      if (!["number", "integer"].includes(fields[valueField]!.baseType)) throw new Error(`${entityName}.${name}: matrix sum requires a numeric value field.`);
      return [name, definition];
    }
    if (definition.kind !== "record" || "fields" in definition) return [name, definition];
    const { namedViews: _named, recordContext: _context, renderers: _renderers, ...web } = contract.interfaces!.web!;
    const { form: _form, ...readView } = view!;
    // Older compiled contracts store tab groups directly rather than a detail.
    const namedDetail = "detail" in definition ? definition.detail : {
      type: "detail" as const,
      header: { render: view?.detail?.header.render ?? view!.page,
        title: definition.title ?? view?.detail?.header.title ?? "{{id}}" },
      groups: { render: view?.detail?.groups.render ?? view!.page, items: definition.layout.tabs },
    };
    const editable = "actions" in definition && definition.actions?.includes("update");
    const update = editable ? record?.operations.update : undefined;
    if (editable && !update) throw new Error(`${entityName}.${name}: an editable record view requires the entity's update Operation.`);
    const projected = projectEntity({
      ...source,
      contract: { ...contract, interfaces: { ...contract.interfaces, web: {
        ...web, ...("context" in definition && definition.context ? { recordContext: definition.context } : {}),
      } } },
      view: { ...readView, detail: namedDetail },
    }, all, providers, update ? namedDetail.groups.items : undefined);
    if (!projected.views.record?.operations.read) throw new Error(`${entityName}.${name}: a record view requires a read Operation.`);
    // Named edits use their own layout, with canonical server-owned/read-only fields excluded.
    const updateGroups = projected.views.record.formGroups?.update ?? [];
    if (update && !updateGroups.some(group => group.fields.length)) throw new Error(`${entityName}.${name}: an editable record view requires writable layout fields.`);
    if (update) for (const group of updateGroups) for (const key of group.fields) {
      if (fields[key] && projected.fields[key]?.supports.update) fields[key].supports.update = true;
    }
    return [name, { ...projected.views.record, id: `${entityName}.${name}`, routes: {},
      modes: update ? ["read" as const, "update" as const] : ["read" as const], operations: { read: projected.views.record.operations.read, ...(update ? { update } : {}) },
      relationships: projected.relationships,
    }];
  }));

  return {
    ...(contract.blueprint ? { blueprint: contract.blueprint } : {}),
    ...(contract.source ? { operationSource: {
      idField: "id",
      collection: { resultField: "items", query: operationEntityCollectionQuery(
        customOperations.list!.id, customOperations.list!.input.schema, customOperations.list!.output.schema, Object.keys(fields),
      )! },
      ...(operations.get ? { record: { bindings: { id: "id" } } } : {}),
    } } : {}),
    ...(contract.transitions
      ? { transitions: contract.transitions.map((status) => ({
          ...status,
          rules: status.rules.map((rule) => ({ ...rule, label: localized(rule.label, rule.key) })),
        })) }
      : {}),
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
      collection: { ...source.collection, ...(contract.interfaces?.web?.collectionFilter ? { filter: contract.interfaces.web.collectionFilter } : {}), ...(tree ? { tree } : {}), ...(table ? { table } : {}), ...(board ? { board } : {}), ...(createUnsupported ? { operations: withoutCreate(source.collection.operations) } : {}) },
      ...(record ? { record } : {}),
      ...(Object.keys(named).length ? { named } : {}),
    },
    relationships,
  };
}

/** Project resolved entity contracts into the versioned browser interface contract. */
/** JSON value type of a context condition, by field base type; dates compare as their ISO strings. */
const contextConditionValueTypes: Record<string, "string" | "number" | "boolean" | undefined> = {
  string: "string", date: "string", datetime: "string", integer: "number", number: "number", boolean: "boolean",
};
