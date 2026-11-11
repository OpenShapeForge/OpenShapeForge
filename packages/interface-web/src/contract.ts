// SPDX-License-Identifier: BUSL-1.1
import type {
  FieldValuePolicy,
  OperationConcurrency,
  OperationConfirmation,
  OperationPrerequisite,
  OperationReference,
} from "@openshapeforge/operations";

export type LocalizedText = { en: string; nl: string };

export type WebOperationIntent = "list" | "get" | "create" | "update" | "delete";
export type WebOperationPrerequisite = OperationPrerequisite;
export type WebCollectionQueryContract = {
  filterMode?: "structured";
  kind: "collection-query";
  /** Entity fields accepted by the canonical list Operation as filters. */
  filterFields: readonly string[];
  /** Entity fields accepted by the canonical list Operation as sort keys. */
  sortFields: readonly string[];
  pagination: {
    kind: "cursor";
    defaultLimit: number;
    maxLimit: number;
  };
};

export type WebListOperationRef = OperationReference<"list"> & {
  /** Interface-neutral list input projected from the canonical Operation. */
  input: WebCollectionQueryContract;
};

export type WebBuiltinOperationRef = OperationReference<WebOperationIntent> & {
  /** Canonical server-enforced controls; browsers derive lease timing from this value. */
  concurrency?: OperationConcurrency;
  /** Canonical server-enforced instructions that must be completed first. */
  prerequisites?: readonly WebOperationPrerequisite[];
  /** Present for list Operations generated from the canonical collection query. */
  input?: WebCollectionQueryContract;
};

/** Full JSON-schema contract shared by invoke and plugin-backed CRUD forms. */
/** Literal JSON form defaults, including the web channel's current locale. */
export type FormDefault = string | number | boolean | null | FormDefault[] | { [key: string]: FormDefault } | { from: "uiLocale" };

export type WebSchemaOperationRef<
  TIntent extends "invoke" | "create" | "update" | "delete" =
    "invoke" | "create" | "update" | "delete",
> = OperationReference<TIntent> & {
  /** Authored key inside the entity Operations map. */
  key: string;
  name: LocalizedText;
  description: LocalizedText;
  target: {
    entityId: string;
    entityName: string;
    scope: "collection" | "record";
    inputField?: string;
    /**
     * Operation input key -> route parameter of the collection's own route,
     * for a `collection`-scoped action on a PARAMETERIZED collection.
     *
     * A collection reached at `/integrations/:integrationId/record-actions`
     * already binds that parameter into its list Operation
     * (`operationSource.collection.bindings`); an action invoked on that
     * collection is invoked in the same context, so it binds the same way.
     * A host fills these inputs from the current route and must not present
     * them as fields to type — the parameter is the page the user is on, and
     * the server re-authorizes it regardless.
     */
    routeBindings?: Record<string, string>;
  };
  input: { kind: "json-schema"; schema: Readonly<Record<string, unknown>> };
  output: { kind: "json-schema"; schema: Readonly<Record<string, unknown>> };
  /** Record-value gate authored at the operation's entity placement. */
  visibleWhen?: {
    conditions: Array<{ field: string; operator: "eq" | "neq" | "in" | "notIn" | "gt" | "lt" | "gte" | "lte" | "isEmpty" | "isNotEmpty"; value?: unknown }>;
    logic?: "and" | "or";
  };
  /** Opaque result presentation key; absent uses structured schema rendering. */
  resultRenderer?: WebRendererKey;
  /** Unlisted inputs are available unless hidden. Defaults can contain { from: "uiLocale" }, resolved to the normalized web language before submission. */
  form?: { showOnlyGroupedFields?: boolean; defaults?: Record<string, FormDefault>; groups: Array<{ title: LocalizedText; fields: string[]; collapsed?: boolean }> };
  effects: {
    data: "read" | "write" | "delete";
    external: "none" | "read" | "write";
  };
  reliability: {
    idempotency: {
      mode: "natural" | "keyed" | "none";
      inputField?: string;
    };
  };
  concurrency?: OperationConcurrency;
  confirmation: OperationConfirmation;
  /** Canonical caller policy, also used by Operation-backed entity projections. */
  auth?:
    | { mode: "public" }
    | { mode: "session"; roles?: readonly string[]; scopes?: readonly string[] }
    | { mode: "control"; roles: readonly string[] };
  prerequisites?: readonly WebOperationPrerequisite[];
  /** Authenticated browser execution endpoint, including honest binary output. */
  rest?: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    response: {
      status?: number;
      kind: "json" | "binary" | "stream";
      contentType?: string;
    };
  };
};

export type WebCustomOperationRef = WebSchemaOperationRef<"invoke">;
export type WebEntityPluginOperationRef = WebSchemaOperationRef<"create" | "update" | "delete"> & {
  implementation: { type: "plugin"; plugin: string; handler: string };
  prerequisites?: readonly WebOperationPrerequisite[];
};
export type WebOperationRef = WebBuiltinOperationRef | WebEntityPluginOperationRef | WebCustomOperationRef;
export type WebViewMode = "read" | "create" | "update";

/** Opaque layout-renderer registry key. A host must reject unknown keys clearly. */
export type WebRendererKey = string;

export type WebVariableSource = {
  key: string;
  resolver: "chips" | "entityFields" | "templateParameters" | "workflowGraphVariables";
  params?: Record<string, unknown>;
};

export type WebFieldSuggestions = {
  sourceField?: string;
  sourceKey?: string;
};

export type WebFieldOption = {
  color?: string;
  value: string;
  label: LocalizedText;
  /** Icon key, e.g. for a choice tile. The host resolves it; an unknown key renders no icon. */
  icon?: string;
};

/** Same condition shape as field visibility; `logic` defaults to `and`. */
export type WebVisibilityCondition = {
  conditions: Array<{ field: string; operator: "eq" | "neq" | "in" | "notIn" | "gt" | "lt" | "gte" | "lte" | "isEmpty" | "isNotEmpty"; value?: unknown }>;
  logic?: "and" | "or";
};

export type WebEqualityConstraint = { eq: string | number | boolean };
export type WebRelationshipConstraints = Record<
  string,
  WebEqualityConstraint | { any: Record<string, WebEqualityConstraint> }
>;

export type WebFieldOptionSource =
  | { type: "referentiedata"; group: string }
  | { type: "entity"; source: string; valueField: string }
  | { type: "remote" | "dynamic"; source: string; parameters?: Record<string, string | number | boolean>; bindings?: Record<string, string> };

/**
 * Semantic field projection. A renderer registry resolves presentation from
 * osfType, baseType, cardinality, surface and mode; fields never name a
 * component or renderer as their default behaviour.
 */
export type WebFieldProjection = {
  document?: { content: "file" | "blocks"; mimeTypes?: string[]; maxBytes?: number; documentType?: string };
  /** Canonical editor profile and lock metadata; the API remains authoritative. */
  authoring?: {profile?:string;pinned?:boolean;locked?:boolean;lockedKeys?:string[];singleton?:boolean;visibleProperties?:string[]};
  /** Canonical protection metadata; the server remains the enforcement boundary. */
  fieldPolicy?: FieldValuePolicy;
  /**
   * Configured Web presentation, composed from catalogue/type/field authoring.
   * Renderer hint, e.g. `ChoiceTiles` for static options authored with `presentation: tiles`.
   * A host without that renderer uses its default input for the field.
   */
  presentation?: { component: string; props?: Record<string, unknown> };
  id: string;
  key: string;
  label: LocalizedText;
  description: LocalizedText;
  /**
   * The one type axis: a base type, a osf-type key or an entity name.
   * The renderer registry keys on it; `baseType` is its structural base.
   */
  osfType: string;
  /** Effective unit: presentation props override a field-authored unit. */
  unit?: string;
  baseType: "string" | "integer" | "number" | "boolean" | "date" | "datetime" | "object";
  /** Logical dynamic form metadata; physical storage stays server-side. */
  entityValue?: { definitionField: string; parameterBindings?: boolean };
  valueFieldsFrom?: { reference: string; field: string };
  typedBy?: { definitionField: string; documentField?: string; encrypted?: boolean };
  allowedDefinitions?: string[];
  relationship?: {
    targetEntityId: string;
    constraints?: WebRelationshipConstraints;
    /** Canonical compound create used when satisfying constraints needs related writes. */
    createOperation?: OperationReference<"invoke">;
  };
  variables?: "none" | "whole" | "template" | "both";
  suggestions?: WebFieldSuggestions;
  visibility?: WebVisibilityCondition;
  options?: WebFieldOption[];
  optionSource?: WebFieldOptionSource;
  cardinality: "one" | "many";
  required: boolean;
  maxLength?: number;
  /** Authored literal create default; never replaces an existing record value. */
  defaultValue?: unknown;
  defaultTemplate?: string;
  /** Nested canonical field metadata for read presentation; not a second schema. */
  children?: WebFieldProjection[];
  item?: WebFieldProjection;
  /** Static capabilities only. Effective rights arrive in operation offers. */
  supports: { read: boolean; create: boolean; update: boolean };
};

export type WebFieldGroup = {
  /** Target-owned view embedded beside the current record fields. */
  relationshipId?: string;
  targetView?: string;
  /** One compound control editing the named existing fields, without a stored object. */
  control?: { component: string; props?: Record<string, unknown>; bindings: Record<string, string> };
  id: string;
  title: LocalizedText;
  fields: string[];
  /** Icon key shown with the group; the host resolves it. */
  icon?: string;
  /** The group applies only while these conditions hold for the draft being edited. */
  visibleWhen?: WebVisibilityCondition;
  /** Per-field presentation-renderer overrides authored on a FieldRef; keyed by field key, sparse. */
  fieldOverrides?: Record<string, { render: { component: WebRendererKey; props?: Record<string, unknown> } }>;
};

export type WebTimelinePresentation = {
  kind: "timeline";
  iconField?: string;
  icons?: Record<string, "phone" | "email" | "whatsapp" | "chat" | "check" | "clock">;
  titleField: string;
  timestampField: string;
  descriptionField?: string;
  relatedField?: string;
};


/** Declarative table values. Membership values refer to the association, never the target record. */
export type WebCollectionTableValue = {
  binding?: string;
  boundPath?: string[];
  boundCurrency?: string[];
  schema?: Readonly<Record<string, unknown>>;
  path?: WebValuePath;
  text?: LocalizedText;
  format?: "money" | "percentage" | "frequency" | "chip";
  currency?: WebValuePath;
  /** Every path in this value, including currency and when, must resolve to zero or one result.
   * Consumers refuse partial, unavailable or multiple results rather than selecting the first. */
  select?: "one";
  when?: { path: WebValuePath; equals: string | number | boolean };
  defaultValue?: string | number;
};
export type WebCollectionTable = {
  bindings?: Record<string, { entityId: string; operation: WebCustomOperationRef; schema: Readonly<Record<string, unknown>>; refreshOn?: string[]; parameters?: Record<string, string | number | boolean> }>;
  navigation?: Array<{ route: string; label: LocalizedText }>;
  rowLabel?: WebValuePath;
  membershipDescription?: WebValuePath;
  groupRows?: "plain" | "bundle";
  viewSwitch?: boolean;
  /** Collection controls the web table offers; `false` hides one. Other channels keep their Operations. */
  toolbar?: { visible?: boolean; search?: boolean; create?: boolean };
  recordPanel?: {
    actions?: Array<"edit" | "openFull">;
    primaryMembership?: { field: string; equals: string };
    avatar?: string;
    summaryColumns?: string[];
    sections?: Array<{
      title: LocalizedText;
      scope?: "treeParent" | "recordAndTreeParent";
      relationship: string;
      orderBy?: string;
      presentation?: "options" | "rows";
      groupBy?: WebValuePath;
      where?: Record<string, string>;
      label: WebCollectionTableValue;
      description?: WebCollectionTableValue;
      details?: WebCollectionTableValue[];
      values: WebCollectionTableValue[];
    }>;
    title: LocalizedText; layout?: { tabs: Array<{ id: string; label: LocalizedText; groups: Array<{ id?: string; title?: LocalizedText; fields: string[] }> }> }; binding?: string; includeRecord?: boolean; view?: string; heading?: string; subtitle?: string; currency?: string; fields?: string[]; collection?: { field: string; columns: string[]; title: LocalizedText }; note?: LocalizedText };
  heading: { title: LocalizedText; subtitle?: LocalizedText };
  views: { tree: LocalizedText; flat: LocalizedText };
  label: LocalizedText;
  description?: string;
  groupBy?: string;
  ungrouped?: LocalizedText;
  columns: Array<{ key: string; label: LocalizedText; values: WebCollectionTableValue[]; membershipValues?: WebCollectionTableValue[] }>;
  summary?: { field: string; labels?: Record<string, LocalizedText> };
  /**
   * Footer: the read is executed with `{ filter }` (the list's matching filter) and answers
   * `{ status, count, totals: [{ currencyCode, amount }], excluded }`. Currencies are never added together;
   * `excluded` counts records whose amount is not known, which are never zero.
   */
  totals?: { entityId: string; operation: WebCustomOperationRef; count: LocalizedText; label: LocalizedText; note?: LocalizedText };
};

export type WebCollectionView = {
  filter?: Readonly<Record<string, unknown>>;
  table?: WebCollectionTable;
  /**
   * Collapsible tree presentation of this same collection: each record is a
   * group of the records its `children` relationship holds, nested without a
   * depth limit. `label` and `count` name fields of the entity shown on the
   * group heading; without `count` the renderer counts the children.
   */
  tree?: { children: string; parent?: string; label?: string; count?: string; through?: { record: string; orderBy?: string } };
  board?: { groupBy: string; scopeBy?: string; groupSummary?: string; aggregate?: { sum: WebValuePath; currency: WebValuePath }; card: { title: WebValuePath[]; timestamp?: WebValuePath; indicator?: string; subtitle?: WebValuePath[]; amount?: { value: WebValuePath; currency: WebValuePath }; body: WebValuePath[] } };
  presentation?: WebTimelinePresentation;
  id: string;
  kind: "collection";
  renderer: WebRendererKey;
  modes: readonly ["read"];
  route: string;
  operations: {
    read: WebOperationRef;
    create?: WebOperationRef;
    /** Ordered server-authored collection actions shown by the browser. */
    actions?: WebCustomOperationRef[];
  };
  title: LocalizedText;
  emptyState?: { title: LocalizedText; description?: LocalizedText; illustration?: "empty-collection"; primaryAction?: "create" };
  searchPlaceholder: LocalizedText;
  displayField: string;
  columns: Array<{ fieldId: string; key: string; label: LocalizedText }>;
  defaultSort?: { key: string; direction: "asc" | "desc" };
};

/** A typed read path; relationships are traversed before reading the optional terminal field. */
export type WebValuePath = {
  path: Array<{ entityId: string; relationshipId: string }>;
  targetEntityId: string;
  field?: string;
  osfType: string;
  cardinality: "one" | "many";
};

export type WebRelationshipProjection = {
  id: string;
  key: string;
  label: LocalizedText;
  kind: "belongsTo" | "hasMany";
  targetEntityId: string;
  targetRoute: string;
  foreignKey?: string;
  recordField?: string;
  fieldKey?: string;
  inverse?: string;
  ownership?: "owned" | "reference";
  /** A single reference to a versioned target: pinned to one immutable version, or the current head (default). */
  version?: "pinned" | "current";
  /** Boolean field of the owned child; the owner's update, move and remove refuse a child whose flag is set. */
  childLock?: string;
  cardinality?: "single" | "collection" | { min?: number; max?: number | "unbounded" };
  sortable?: boolean;
  positionColumn?: string;
  via?: string;
  through?: { field: string; column: string; target: string };
  /** Canonical target list is scoped by its inverse association, not by target IDs in the browser. */
  association?: { entityId: string; relationship: string; parentField: string };
  mutationSupport?: "unsupported" | "atomic";
  allowedDefinitions?: string[];
  constraints?: WebRelationshipConstraints;
  /**
   * Present when the target is a provider-backed entity: no foreign key exists.
   * The browser runs the target's Operations, filling each input field named
   * in `bindings` from the field of the current record it maps to.
   */
  source?: {
    kind: "provider";
    bindings: Record<string, string>;
    createBindings?: Record<string, string>;
    /** Canonical list capabilities narrowed for this relationship placement. */
    query?: NonNullable<WebEntityInterface["operationSource"]>["collection"]["query"];
  };
  operations: {
    list?: WebOperationRef;
    get?: WebOperationRef;
    create?: WebOperationRef;
    insert?: WebCustomOperationRef;
    move?: WebCustomOperationRef;
    update?: WebCustomOperationRef;
    remove?: WebCustomOperationRef;
  };
  collection?: WebCollectionView;
};

export type WebRecordTab = {
  /** Supplemental data remains addressable through context and editable in forms. */
  showInReadNavigation?: boolean;
  id: string;
  label: LocalizedText;
  groups: WebFieldGroup[];
  /** The tab applies only while these conditions hold for the record shown; its groups carry it too. */
  visibleWhen?: WebVisibilityCondition;
  relationshipId?: string;
  /** Named view owned by the relationship target selected by this placement. */
  targetView?: string;
};

export type WebRecordView = {
  id: string;
  kind: "record";
  renderer: WebRendererKey;
  preset: "main" | "main-context" | "inbox-main-context";
  modes: WebViewMode[];
  routes: {
    read?: string;
    create?: string;
  };
  operations: {
    read?: WebOperationRef;
    create?: WebOperationRef;
    update?: WebOperationRef;
    delete?: WebOperationRef;
    /** Ordered server-authored record actions shown by the browser. */
    actions?: WebCustomOperationRef[];
  };
  titleTemplate: string;
  /** Authored forms; named editable records project update groups from their own layout, excluding server-owned/read-only fields. */
  formGroups?: { create?: WebFieldGroup[]; update?: WebFieldGroup[] };
  subtitleTemplate?: string;
  badges?: string[];
  layout: {
    tabs: WebRecordTab[];
    workspaceTabs?: boolean;
    context: { groups: WebFieldGroup[]; relationships: string[]; contacts?: WebContactContext; records?: WebRelatedRecordContext[] };
  };
  variableSources?: WebVariableSource[];
  labels: {
    createTitle?: LocalizedText;
    updateTitle?: LocalizedText;
    createSubmit?: LocalizedText;
    updateSubmit?: LocalizedText;
  };
};

export type WebNamedView =
  | (WebCollectionView & { collectionLayout: "table"; itemView?: string; tabLabel?: string; showItemTitle?: boolean })
  | (WebRecordView & { relationships?: Record<string, WebRelationshipProjection> })
  /** Compatibility with manifests compiled before named record layouts. */
  | { kind: "record"; fields: string[] }
  | {
      kind: "record";
      titleTemplate?: string;
      layout: { tabs: WebRecordTab[] };
    }
  | { kind: "collection"; collectionLayout: "table" | "tabs" | "stack"; itemView?: string; tabLabel?: string; showItemTitle?: boolean }
  | { kind: "collection"; collectionLayout: "matrix"; matrix: { rowField: string; columnField: string; valueField: string; aggregate: "sum" } };

export type WebEntityView = WebCollectionView | WebRecordView | WebNamedView;

/**
 * A status field declared as a state machine. Each rule is also one of the
 * entity's `operations` (by `operation` id) and appears in a record's offer
 * list only while the record's status is in `from`; the renderer shows the
 * offered rules as the record's transition buttons.
 */
export type WebStatusTransitions = {
  field: string;
  initial: string;
  rules: Array<{
    key: string;
    operation: string;
    from: string[];
    to: string;
    label: LocalizedText;
    recordPermission?: "edit";
    preconditions?: Array<{ field: string; present?: boolean; via?: string; in?: Array<string | number | boolean>; refusal?: { en?: string; nl?: string } }>;
    writes?: Array<{ field: string; required: boolean; agreesOn?: string[] }>;
    stamps?: Array<{ field: string; value: "now" | "actor"; actor?: "relation" | "user" }>;
  }>;
};

export type WebEntityInterface = {
  blueprint?: { mode?: "copy"; fields: string[]; labelField: string; operations: { list: string; status: string; reset: string; publish: string } };
  /** Status state machines declared on this entity's fields. */
  transitions?: WebStatusTransitions[];
  /** Canonical record label used outside a particular view, including selectors. */
  displayTemplate?: string;
  entityId: string;
  entitySlug: string;
  title: LocalizedText;
  fields: Record<string, WebFieldProjection>;
  operations: Record<string, WebOperationRef | WebCustomOperationRef>;
  /**
   * A provider-backed entity read through canonical module Operations rather
   * than generated SQL CRUD. The normal entity/view model remains intact;
   * this block only tells a generic renderer how to bind routes and unwrap the
   * bounded provider response.
   */
  operationSource?: {
    idField: string;
    create?: { bindings?: Record<string, string> };
    collection: {
      resultField: string;
      /** Operation input field -> route parameter. Equal names need no entry. */
      bindings?: Record<string, string>;
      /** Canonical query capabilities declared by the list Operation itself. */
      query?: {
        input: WebCollectionQueryContract;
        nextCursorField: string;
        /**
         * Where to read the collection's total from. ABSENT when the backing
         * Operation declares its total as unknown — a listing bounded by the
         * caller's own row authorization cannot state one without reading past
         * that authorization. A renderer with no field here derives progress
         * from `nextCursorField` and must not substitute the number of rows it
         * has loaded for a total it was not given.
         */
        totalCountField?: string;
      };
    };
    record?: {
      resultField?: string;
      bindings?: Record<string, string>;
    };
    related?: Array<{
      entityId: string;
      label: LocalizedText;
      route: string;
    }>;
  };
  /** Authored Operations that cannot be submitted through the generic interface yet. */
  unsupportedOperations?: Partial<Record<WebOperationIntent, { code: string; message: string }>>;
  views: {
    collection: WebCollectionView;
    record?: WebRecordView;
    named?: Record<string, WebNamedView>;
  };
  relationships: Record<string, WebRelationshipProjection>;
  /**
   * Present on an entity whose tenants may define fields of their own. The
   * definitions are read and changed through `definitionsPath`/<action>
   * (POST: list, create, update, deprecate, restore, delete, reorder,
   * affected-records); only `manageRoles` may change them. Named
   * `customFields` so it cannot be confused with a renderer's record
   * extensions.
   */
  customFields?: WebCustomFields;
  /**
   * Present on an entity that a tenant reference field may point at: the
   * POST route (`:id` is the record) that counts, per source entity and
   * field, the records referring to it.
   */
  referencedByPath?: string;
};

export type WebCustomFields = {
  manageRoles: string[];
  definitionsPath: string;
  limits: { fields: number; filtersPerQuery: number; formulaDepth: number; syncFanOut: number };
  /** osfTypes a tenant field may use; a reference field names one of `targets` instead. */
  allowedOsfTypes: string[];
  /** Entities a tenant reference field may point at. */
  targets: string[];
  /** Field kinds this runtime accepts; computed kinds join as their engine work lands. */
  kinds: WebCustomFieldKind[];
};

export type WebCustomFieldKind = "stored" | "formula" | "lookup" | "rollup";

/**
 * A standalone Operation: authored in an operation catalog rather than on an
 * entity, so it has no record target. It is shown on a page, executed through
 * its REST projection with the caller's own session, and — when it is a
 * landing operation — run as soon as its page opens.
 */
export type WebStandaloneOperationRef = Omit<WebSchemaOperationRef<"invoke">, "target"> & {
  /**
   * Present when an operation-backed entity lists the Operation as one of its
   * actions: a collection action needs no record, a record action binds the
   * current record by `inputField`. Absent on page Operations.
   */
  target?: {
    entityId: string;
    entityName: string;
    scope: "collection" | "record";
    inputField?: string;
    /**
     * Operation input key -> route parameter of the collection's own route,
     * for a `collection`-scoped action on a PARAMETERIZED collection. Filled
     * from the route the action is invoked on; see the same field on
     * {@link WebSchemaOperationRef}.
     */
    routeBindings?: Record<string, string>;
  };
  /** Who may invoke it; the web hides what the session cannot invoke. */
  auth:
    | { mode: "public" }
    | { mode: "session"; roles?: readonly string[]; roleGroups?: readonly (readonly string[])[]; scopes?: readonly string[] }
    | { mode: "control"; roles: readonly string[] };
  prerequisites?: readonly WebOperationPrerequisite[];
  page: string;
  landing?: boolean;
  order?: number;
};

/** A page of standalone Operations: a menu entry that is not an entity. */
export type WebPage = {
  id: string;
  title: LocalizedText;
  description?: LocalizedText;
  icon?: string;
  order?: number;
  route: string;
  /** Operation ids in display order; the landing operation, if any, first. */
  operations: string[];
};

/**
 * What an application entry opens. A reference only: fields, layout, inputs
 * and permissions stay with the entity view, page or host page it names.
 */
export type WebAppEntryTarget =
  /** An entity's canonical collection, or the named collection view `view`. */
  | { kind: "entityView"; entityId: string; view?: string }
  /** A page of standalone Operations. */
  | { kind: "operationPage"; pageId: string }
  /** A route the host renders itself; it has no compiled surface. */
  | { kind: "hostPage" };

/** Why an entry is not offered as an MCP application. */
export type WebAppEntryMcpExclusion = "host-page" | "authored";

/**
 * One addressable destination of the application: a sidebar item in the
 * browser, a named opener in an MCP host. The id is the authored menu key and
 * never derives from a label or a route.
 */
export type WebAppEntry = {
  id: string;
  label: LocalizedText;
  icon?: string;
  target: WebAppEntryTarget;
  /** The parameterless route the target resolves to. Navigation only, never a grant. */
  route: string;
  /**
   * Canonical Operations whose discoverability admits the entry: a session
   * that can discover any one may be offered it. Empty for a host page, whose
   * visibility the host decides. The Operations keep the authorization.
   */
  discoverOperations: string[];
  mcp: { exposed: true } | { exposed: false; reason: WebAppEntryMcpExclusion };
};

/** Sidebar grouping and order; the entries themselves are defined once in `entries`. */
export type WebAppEntryGroup = { id: string; label?: LocalizedText; entries: string[] };

/** The application's entries, projected from the authored shell and the web manifest. */
export type WebAppEntriesV1 = {
  contract: "openshapeforge.web-app-entries";
  version: 1;
  entries: Record<string, WebAppEntry>;
  navigation: WebAppEntryGroup[];
};

/** Compiler-owned security metadata; the server independently enforces the ceiling. */
export type WebAuthorizationOperation = {
  id:string; entity:string; roles:readonly string[]; grantable:boolean;
  fields:Readonly<Record<string,{type:string;display?:boolean}>>;
};

export type WebManifestV1 = {
  authorizationOperations?: readonly WebAuthorizationOperation[];
  contract: "openshapeforge.web-manifest";
  version: 1;
  locale: "en" | "nl";
  entities: Record<string, WebEntityInterface>;
  /** Standalone Operations keyed by canonical id; absent when none are projected. */
  operations?: Record<string, WebStandaloneOperationRef>;
  /** Pages of standalone Operations keyed by page id. */
  pages?: Record<string, WebPage>;
  /** Normal entity field definitions projected for use inside entityValue fields. */
  entityValueDefinitions?: Record<string, {
    entityName: string;
    label: LocalizedText;
    fields: WebFieldProjection[];
    materializeOperationId?: string;
  }>;
};

export type WebManifestOptions = {
  authorizationOperations?: readonly WebAuthorizationOperation[];
  /** Fail build when visible operation fields or choices lack bilingual UI copy. */
  requireTranslations?: boolean;
  locale?: "en" | "nl";
  /** Context to prefer when an entity exposes multiple compiled view contexts. */
  context?: string;
  /** Route language may differ from the default content language. */
  routeLocale?: "en" | "nl";
};


export type WebContactContext = {
  channels?: Array<{ key: string; types: string[]; label?: LocalizedText; when?: Record<string, string | boolean> }>;
  relationshipId: string;
  channelField: string;
  valueField: string;
  preferredChannelField?: string;
  language?: { relationshipId: string; field: string };
};

export type WebRelatedRecordContext = {
  key: string; label: LocalizedText;
  path: Array<{ entityId: string; relationshipId: string }>;
  targetEntityId: string; displayField: string;
  when?: Record<string, string | number | boolean | null>;
  tone?: "default" | "subtle";
  labelEmphasis?: boolean;
  status?: { field: string; values: Record<string, "off" | "success" | "danger" | "warning"> };
};
