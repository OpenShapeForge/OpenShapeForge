// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
import type {
  LocalizedText,
  FieldValidation,
  FieldPermissions,
  FieldAuthorizationConfig,
  EntityPermissions,
  VisibilityConfig,
  ComputedField,
  FieldOptions,
  SemanticTypeLookupDefinition,
  DataClassification,
  RetentionPolicy,
  ContextHints,
  EntityHooks,
  ItemAction,
  ViewAction,
  ViewActionDefinition,
  ViewRowAction,
} from "./common.js";
import type {
  ListColumn,
  ListFilter,
  RelationshipOverrides,
  ListPresentation,
  DetailPresentation,
  FormPresentation,
  FormVariableSource,
  PresentationDefinition,
  WorkspaceLayoutVariant,
} from "./views.js";
import type {
  AuthoredEntityIndex,
  CrudOperationKey,
  FieldMapping,
  FieldRelationship,
  FieldSuggestions,
  McpOperationKey,
  McpToolStyle,
  RestOperationKey,
  ThirdPartyApiEndpoint,
} from "./authoring.js";
import type { CanonicalCompilerKernel } from "../compiler/canonical/index.js";

export interface CompiledViewRender {
  component: string;
}

export interface CompiledColumn {
  field: string;
  column: string;
  type: string;
  nullable: boolean;
  storageClass: "core" | "profile";
  profile?: string;
}

export interface CompiledRender {
  component: string;
  props?: Record<string, unknown>;
}

export interface CompiledField {
  key: string;
  valueType: "string" | "integer" | "number" | "boolean" | "date" | "datetime" | "object";
  cardinality: "single" | "collection";
  variables?: "none" | "whole" | "template" | "both";
  sortable?: boolean;
  required: boolean;
  /** Presentation only — picks the display component over the input one. */
  readOnly?: boolean;
  /**
   * API contract: settable at create, refused on update by every generated
   * transport. Reaches the runtime through the manifest column, the way
   * `classification` does (#177).
   */
  immutable?: boolean;
  label: LocalizedText;
  description?: LocalizedText;
  help?: LocalizedText;
  render: CompiledRender;
  semanticType?: string;
  unit?: string;
  defaultValue?: unknown;
  validation?: FieldValidation;
  visibility?: VisibilityConfig;
  computed?: ComputedField;
  graphqlType?: string;
  options?: FieldOptions;
  lookup?: SemanticTypeLookupDefinition;
  permissions?: FieldPermissions;
  authorization?: FieldAuthorizationConfig;
  classification?: DataClassification;
  retention?: RetentionPolicy;
  audit?: boolean;
  hints?: ContextHints;
  suggestions?: FieldSuggestions;
  relationship?: FieldRelationship;
  layoutFraction?: number;
  localized?: boolean;
  children?: CompiledField[];
  item?: CompiledField;
}

export interface CompiledRelationship {
  key: string;
  kind: "belongsTo" | "hasMany" | "manyToMany";
  target: string;
  foreignKey?: string;
  via?: string;
  label?: LocalizedText;
}

export interface GraphQLField {
  name: string;
  type: string;
  source: "core" | "profile";
  /**
   * When set, the field is resolved at runtime by the GraphQL context
   * (e.g. `ctx.labelService`) rather than exposed from a DB column.
   * Used for non-persisted computed fields like `labels`.
   */
  computedResolver?: "labels";
}

export interface GraphQLRelationship {
  name: string;
  target: string;
  type: string;
  resolve: string;
  foreignKey?: string;
  via?: string;
}

export interface GraphQLProfileType {
  typeName: string;
  fieldName: string;
  description?: string;
  fields: {
    name: string;
    type: string;
    column?: string;
    label?: LocalizedText;
    description?: string;
    semanticType?: string;
    render?: CompiledRender;
    displayRender?: CompiledRender;
    validation?: FieldValidation;
    options?: FieldOptions;
    classification?: DataClassification;
    retention?: RetentionPolicy;
    audit?: boolean;
  }[];
}

export interface GraphQLSection {
  typeName: string;
  description?: string;
  fields: GraphQLField[];
  relationships: GraphQLRelationship[];
  profileTypes: Record<string, GraphQLProfileType>;
  queries: {
    single: { name: string; args: { name: string; type: string }[] };
    list: { name: string; args: { name: string; type: string }[] };
  };
  mutations: {
    create: { name: string; input: string };
    update: { name: string; input: string };
    delete: { name: string; args: { name: string; type: string }[] };
  };
}

export interface McpSection {
  /**
   * Tool-name prefix for `dedicated` style (e.g. "contact_detail", yielding
   * `contact_detail_list`). Validated at load and again at compile against
   * ^[a-z][a-z0-9_]*$ because it is emitted verbatim into MCP tool names,
   * which the protocol constrains and the runtime dispatches on.
   */
  toolPrefix: string;
  /**
   * `dedicated` emits one tool per enabled operation; `generic` routes the
   * entity through the shared osf_* tools instead, keeping the advertised
   * tool count flat for large catalogs.
   */
  tools: McpToolStyle;
  operations: Record<McpOperationKey, boolean>;
  /**
   * Authored per-operation tool name/description overrides (`dedicated`
   * style only). generate-mcp.ts consumes these when it emits the catalog;
   * an absent entry means the compiler-composed default applies.
   */
  toolOverrides?: Partial<Record<McpOperationKey, { name?: string; description?: string }>>;
  /**
   * Authored MCP resource exposure, validated but not defaulted — the
   * catalog generator resolves the name/description fallbacks because it
   * owns the label helpers.
   */
  resource?: {
    uri: string;
    name?: string;
    description?: string;
    templateDescription?: string;
  };
  /** Authored schema-discovery tool, validated at compile. */
  discovery?: { name: string; description?: string };
  /** Authored create-time elicitation config, validated at compile. */
  elicitOnCreate?: {
    sourceField: string;
    sourceEntity: string;
    definitionsField: string;
    into: string;
    message?: string;
  };
  /** Authored row-to-tool projection config, validated at compile. */
  derivedTools?: {
    roles: string[];
    keyField: string;
    titleField?: string;
    descriptionField: string;
    inputFieldsField: string;
    execution?: {
      bindingsField: string;
      operationRef: string;
      operationEntity: string;
      providerRef: string;
      providerEntity: string;
      connectionEntity: string;
      connectionProviderRef: string;
      connectionValuesField: string;
    };
    visibleWhen?: { field: string; equals: string };
    connect?: { name: string; description?: string };
  };
}

export interface RestSection {
  /**
   * URL segment without slashes (e.g. "relations", "relation-groups"). The
   * runtime prefixes it with the versioned REST mount point (/api/rest/v1/).
   * Validated at load time against ^[a-z][a-z0-9-]*$ because it is emitted
   * verbatim into route strings and OpenAPI paths.
   */
  basePath: string;
  operations: Record<RestOperationKey, boolean>;
}

export interface CrudSection {
  operations: Record<CrudOperationKey, boolean>;
}

export interface CompiledListView {
  name?: string;
  kind?: "page" | "embedded";
  type?: "list";
  render: CompiledViewRender;
  search: { render: CompiledViewRender; placeholder?: LocalizedText };
  filterBar?: { render: CompiledViewRender; filters: ListFilter[] };
  title?: LocalizedText;
  subtitle?: LocalizedText;
  columns: ListColumn[];
  defaultSort?: { key: string; direction: "asc" | "desc" };
  rowLink?: string;
  pageSize?: number;
  emptyState?: LocalizedText;
  itemAction?: ItemAction;
  actions?: CompiledViewAction[];
  rowActions?: CompiledViewRowAction[];
}

export interface CompiledFieldEntry {
  key: string;
  renderOverride?: CompiledViewRender;
  fieldDisplayMode?: "hidden";
}

export type CompiledTimelineInclude =
  | "self"
  | {
      relationship: string;
    };

export interface CompiledTimelineConfig {
  include?: CompiledTimelineInclude[];
}

export interface CompiledViewGroup {
  id: string;
  title?: LocalizedText;
  label?: LocalizedText;
  icon?: string;
  render?: CompiledViewRender;
  fields?: (string | CompiledFieldEntry)[];
  relationships?: CompiledRelationshipUsage[];
  relationship?: CompiledRelationshipUsage;
  groups?: CompiledViewGroup[];
  timeline?: CompiledTimelineConfig;
}

export interface CompiledViewAction extends ViewAction {}

export interface CompiledViewActionDefinition extends ViewActionDefinition {}

export interface CompiledViewRowAction extends ViewRowAction {}

export interface CompiledDetailView {
  name?: string;
  kind?: "page";
  type?: "detail";
  render?: CompiledViewRender;
  header: { render: CompiledViewRender; title: string; subtitle?: string; badges?: { render: CompiledViewRender; items: string[] } };
  actions?: CompiledViewAction[];
  groups: { render: CompiledViewRender; items: CompiledViewGroup[] };
}

export interface CompiledFormVariant {
  title: LocalizedText;
  extends?: string;
  groups: CompiledViewGroup[];
  fieldOverrides?: Record<string, Record<string, unknown>>;
  submit: { render: CompiledViewRender; label: LocalizedText };
}

export interface CompiledFormView {
  name?: string;
  kind?: "page";
  type?: "form";
  variants: Record<string, CompiledFormVariant>;
  actions?: CompiledViewAction[];
  /**
   * WEB-020 — Form-level variable sources (opt-in; resolved by the renderer
   * once per form mount and shared across all fields).
   */
  variableSources?: FormVariableSource[];
}

export interface CompiledSummaryView {
  name: string;
  kind: "embedded";
  type: "summary";
  title?: LocalizedText;
  fields: (string | CompiledFieldEntry)[];
  emptyState?: LocalizedText;
  itemAction?: ItemAction;
  actions?: CompiledViewAction[];
}

export interface CompiledCardsView {
  name: string;
  kind: "embedded";
  type: "cards";
  title?: LocalizedText;
  titleField?: string;
  fields?: (string | CompiledFieldEntry)[];
  metaFields?: (string | CompiledFieldEntry)[];
  emptyState?: LocalizedText;
  itemAction?: ItemAction;
  actions?: CompiledViewAction[];
}

export interface CompiledListItemView {
  name: string;
  kind: "embedded";
  type: "listItem";
  title?: LocalizedText;
  titleField: string;
  subtitleField?: string;
  fields?: (string | CompiledFieldEntry)[];
  emptyState?: LocalizedText;
  actions?: CompiledViewAction[];
}

export interface CompiledWorkspacePaneSizing {
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  weight?: number;
  resizable?: boolean;
}

export interface CompiledWorkspacePresentationSlot extends CompiledWorkspacePaneSizing {
  presentation: string;
}

export interface CompiledWorkspaceGroupSlot extends CompiledWorkspacePaneSizing {
  title?: LocalizedText;
  groups: CompiledViewGroup[];
}

export interface CompiledWorkspaceView {
  name?: string;
  kind?: "page";
  type?: "workspace";
  render?: CompiledViewRender;
  title?: LocalizedText;
  subtitle?: LocalizedText;
  selectionParam?: string;
  defaultSelectionSource?: "firstRow" | "none";
  actions?: CompiledViewAction[];
  layout: {
    variant: WorkspaceLayoutVariant;
  };
  slots: {
    sidebar?: CompiledWorkspaceGroupSlot;
    list: CompiledWorkspacePresentationSlot;
    body: CompiledWorkspacePresentationSlot;
    related?: CompiledWorkspaceGroupSlot;
  };
}

export type CompiledNamedPresentation =
  | CompiledListView
  | CompiledDetailView
  | CompiledFormView
  | CompiledSummaryView
  | CompiledCardsView
  | CompiledListItemView
  | CompiledWorkspaceView;

export interface CompiledRelationshipUsage {
  render: CompiledViewRender;
  name: string;
  via?: string;
  view?: string;
  overrides?: RelationshipOverrides;
}

export interface CompiledViewContext {
  page: CompiledViewRender;
  routes: Record<string, LocalizedText | string>;
  actionDefinitions?: Record<string, CompiledViewActionDefinition>;
  presentations: Record<string, CompiledNamedPresentation>;
  list?: CompiledListView;
  detail?: CompiledDetailView;
  form?: CompiledFormView;
  workspace?: CompiledWorkspaceView;
}

export interface CompiledProfileApi {
  purpose: string;
  entityName: string;
  endpoints: Record<string, ThirdPartyApiEndpoint>;
}

export interface CompiledProfile {
  entityName: string;
  profileTable: string;
  thirdPartyApi?: CompiledProfileApi;
  mapping: {
    identity: { source: string; target: string };
    fieldMappings: FieldMapping[];
  };
  /** Profile-specific display template override. Falls back to core entity's. */
  displayTemplate?: string;
  /** Profile-specific filter field override. Falls back to core entity's. */
  filterField?: string;
}

export interface CompiledAuthorizationRole {
  name: string;
  description: string;
  composite: boolean;
  composites?: string[];
}

export interface CompiledFieldAuthorization {
  fieldKey: string;
  readRoles: string[];
  writeRoles: string[];
}

export interface CompiledAuthorization {
  entitySlug: string;
  roles: {
    read: string[];
    create: string[];
    update: string[];
    delete: string[];
  };
  compositeRoles: CompiledAuthorizationRole[];
  fieldAuthorizations: CompiledFieldAuthorization[];
  profileAuthorizations: Record<string, { readRoles: string[] }>;
  rowAccess?: {
    enabled: boolean;
    empty: "public" | "restricted";
    /**
     * When set, the generated RLS policy adds `"<column>" = app.current_user_id()`
     * (owner axis). The backend manifest maps this to `rowScope.userColumns`.
     * `owner.session` is constrained to `"app.current_user_id"` at compile time
     * — the runtime only exposes the current user id GUC.
     */
    owner?: {
      column: string;
      session: string;
    };
    /**
     * Group-predicated axis. NEW — Phase 2 fills this end-to-end (translation,
     * closure tables, session expansion). Carried here so the type is stable;
     * Phase 1 does not wire group translation. `expand` is defaulted at compile.
     */
    group?: {
      column: string;
      expand: "descendants" | "ancestors" | "exact";
    };
  };
}

export interface CompiledEntityContract {
  contractVersion: number;
  kind: "compiledEntityContract";
  entity: {
    id: string;
    name: string;
    module: string;
    title: string;
    description?: string | LocalizedText;
    labels?: LocalizedText;
    domains: string[];
    /** Canonical display template for an instance (e.g. "{{title}}"). */
    displayTemplate?: string;
    /** Default field key for free-text typeahead filtering. */
    filterField?: string;
    /** Authored entity-level indexes resolved by the backend manifest. */
    indexes?: AuthoredEntityIndex[];
  };
  storage: {
    table: string;
    columns: CompiledColumn[];
  };
  model: {
    fields: CompiledField[];
    relationships: CompiledRelationship[];
  };
  /** Common upper bound for generated CRUD across every transport. */
  crud: CrudSection;
  graphql: GraphQLSection;
  /** Present only when the entity opts into generated REST exposure. */
  rest?: RestSection;
  /** Present only when the entity opts into generated MCP exposure. */
  mcp?: McpSection;
  retention?: {
    entity?: RetentionPolicy;
    policies?: Record<string, RetentionPolicy>;
  };
  hooks?: EntityHooks;
  permissions?: EntityPermissions;
  authorization: CompiledAuthorization;
  views: Record<string, CompiledViewContext>;
  canonical: CanonicalCompilerKernel;
  profiles: Record<string, CompiledProfile>;
}
