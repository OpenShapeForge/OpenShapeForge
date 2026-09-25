// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
import type {
  OperationConcurrency,
  OperationConfirmation,
  OperationPrerequisite,
} from "@openshapeforge/operations";
import type {
  LocalizedText,
  FieldValidation,
  FieldRender,
  OsfTypeLookupDefinition,
  EntityPermissions,
  FieldOptions,
  DataClassification,
  RetentionPolicy,
  ContextHints,
  EntityHooks,
  AuthorizationConfig,
  ProfileAuthorizationConfig,
} from "./common.js";
import type { UIDefinition } from "./views.js";
import type {
  FieldDefinition,
  FieldDefinitionAuthoringMetadata,
  FieldDefinitionCardinality,
  FieldDefinitionRelationship,
  FieldDefinitionValueType,
  FieldDefinitionRuntimeMetadata,
  FieldDefinitionSuggestions,
  FieldDefinitionWorkflowInspector,
} from "./field-definition.js";

/**
 * Entity-authoring compatibility surface. Its structural contract comes from
 * FieldDefinition; the remaining properties are legacy entity-only escape
 * hatches that have not yet moved into the enforced authoring schema.
 */
export interface Field extends FieldDefinition {
  /**
   * Compiler-derived base of `osfType`: the type itself for a base type, the
   * catalog entry's `baseType` otherwise. Never authored.
   */
  baseType?: FieldDefinitionValueType;
  /**
   * Escape hatch to override the emitted GraphQL type for a non-persisted
   * field. When set, the GraphQL codegen skips the default `FIELD_TO_GQL_TYPE`
   * mapping and wires a runtime resolver (e.g. `ctx.labelService.resolve`)
   * that returns a value shaped like this type. Use together with an absent
   * `persisted` block so storage compilation skips the field.
   */
  graphqlType?: string;
  shape?: Field[];
  children?: Field[];
  item?: Field;
}

export type FieldCardinality = FieldDefinitionCardinality;
export type FieldAuthoringMetadata = FieldDefinitionAuthoringMetadata;
export type FieldSuggestions = FieldDefinitionSuggestions;
export type FieldRelationship = FieldDefinitionRelationship;
export type FieldRuntimeMetadata = FieldDefinitionRuntimeMetadata;
export type FieldWorkflowInspector = FieldDefinitionWorkflowInspector;

export interface ComponentDefinition {
  kind: "view" | "field" | "relationship" | "custom";
  description: string;
  props: string[];
}

export interface ComponentCatalog {
  schemaVersion: number;
  kind: "componentCatalog";
  defaults: Record<
    string,
    { label?: LocalizedText; component: string; readOnly?: boolean }
  >;
  viewDefaults: Record<string, { component: string }>;
  components: Record<string, ComponentDefinition>;
}

export interface OsfTypeDefinition {
  /** Derived from the entity corpus, never authored in the osf-type catalog. */
  entityIdentity?: boolean;
  /** Derived: the entity declares `versioning`, so a reference to it may say `version: current`. */
  versioned?: boolean;
  /** Derived: this entity is the immutable version entity of the named versioned entity, so a reference to it may be `version: pinned`. */
  versionEntityOf?: string;
  /**
   * `scalar` and `object` are authored. `entity` (a loaded entity, the
   * relationship target), `entityId` (its identity alias, `<entity>Id`) and
   * `provider` (an Operation-catalog entity) are derived from the corpus by
   * `deriveEntityOsfTypes` / `deriveProviderOsfTypes`; an authored entry
   * under a derived key is a compile error.
   */
  kind?: "scalar" | "entityId" | "entity" | "object" | "provider";
  label: LocalizedText;
  pluralLabel?: LocalizedText;
  /** The base type every transport maps this type to: storage, GraphQL and JSON Schema. */
  baseType:
    | "string"
    | "integer"
    | "number"
    | "boolean"
    | "date"
    | "datetime"
    | "object";
  cardinality?: FieldCardinality;
  validation?: FieldValidation;
  options?: FieldOptions;
  /**
   * The complete value schema of this type: a `$ref` into the bundled
   * field-definition definitions. A type that declares one is projected
   * through it instead of through `baseType` and `shape`, which is how a
   * recursive contract (a stored FieldDefinition) is a catalog type like any
   * other, with no engine code that knows its name.
   */
  schema?: OsfTypeSchemaReference;
  lookup?: OsfTypeLookupDefinition;
  render?: {
    display: string;
    input: string;
  };
  format?: string;
  props?: Record<string, unknown>;
  classification?: DataClassification;
  retention?: RetentionPolicy;
  audit?: boolean;
  hints?: ContextHints;
  shape?: Field[];
  children?: Field[];
  item?: Field;
  /**
   * Lucide-react icon name (e.g. "AtSign", "Phone") used by the renderer
   * when displaying field rows that need a type indicator — most visibly in
   * the array-field item rows, where the icon sits between the drag handle
   * and the field label. Resolution falls back to a per-field-type icon
   * map in the renderer when this is unset.
   */
  icon?: string;
  /**
   * For derived entity, entity-ID and provider types: the name of the entity
   * this type identifies or references, spelled as the entity's own osfType
   * (PascalCase), so a consumer can resolve from an `osfType` string back
   * to the entity without a second spelling.
   */
  entity?: string;
  /**
   * For entity-ID types: where a picker enumerates the records a value of
   * this type identifies — the entity itself, resolved through its list
   * Operation. Absent when the entity has no list Operation. A field that
   * declares its own `options` keeps them.
   */
  optionSource?: FieldOptions;
  /**
   * Copied from the entity's `displayTemplate`. Variable pickers and
   * cards render instances with this template.
   */
  displayTemplate?: string;
  /**
   * Copied from the entity's `filterField`. Typeahead filtering inside
   * pickers uses `filter: { [filterField]: userInput }`.
   */
  filterField?: string;
}

export type OsfTypeSchemaReference = { $ref: string } & Record<string, unknown>;

export interface OsfTypeCatalog {
  schemaVersion: number;
  kind: "osfTypeCatalog";
  types: Record<string, OsfTypeDefinition>;
}

export interface RetentionPolicyCatalog {
  schemaVersion: number;
  kind: "retentionPolicyCatalog";
  policies: Record<string, RetentionPolicy>;
}

export interface AuthoredEntityIndex {
  /**
   * Index identifier. Must be unique per entity. Persisted as the SQL index
   * name, so keep it descriptive and snake_case (e.g.
   * `billing_run_items_tenant_idempotency_uidx`).
   */
  name: string;
  /**
   * Entity field keys (camelCase) that compose the index. The compiler
   * resolves each to the corresponding persisted column name.
   */
  fields: string[];
  /**
   * When true, generates `CREATE UNIQUE INDEX` instead of `CREATE INDEX`.
   * On a tenant-scoped entity the compiler leads the index with `tenant_id`
   * when `tenantId` is not among the fields: uniqueness is per tenant.
   */
  unique?: boolean;
  /**
   * Partial index: only rows whose field equals the value (`{ field:
   * isDefault, equals: true }`) or holds one at all (`{ field: invoiceNumber,
   * present: true }`) take part, so a unique index enforces at most one such
   * row per key and leaves the rows without the value alone.
   */
  where?: { field: string; equals: boolean | string | number } | { field: string; present: boolean };
}

export type CrudOperationKey = "list" | "get" | "create" | "update" | "delete";

export interface CrudConfig {
  /** Defaults to true when omitted. `false` disables every generated CRUD operation. */
  enabled?: boolean;
  /** Per-operation upper bounds; each defaults to true while CRUD is enabled. */
  operations?: Partial<Record<CrudOperationKey, boolean>>;
}

export type RestOperationKey = CrudOperationKey;

export interface RestConfig {
  /** Defaults to true when the `rest` block is present. */
  enabled?: boolean;
  /** URL segment without slashes; defaults to the entity's table name with `_` → `-`. */
  basePath?: string;
  /** Per-operation flags; each defaults to true when REST is enabled. */
  operations?: Partial<Record<RestOperationKey, boolean>>;
}

/** MCP exposes the same five CRUD operations REST does. */
export type McpOperationKey = RestOperationKey;

/**
 * How an entity's operations are surfaced as MCP tools.
 *
 * `dedicated` emits one tool per operation (`relation_list`, `relation_get`,
 * …). The authored labels, descriptions, and enumerations land directly in
 * each tool's schema, which is what makes them usable by a model — so this is
 * the default. `generic` routes the entity through the shared
 * `osf_list`/`osf_get`/… tools instead, trading that per-tool detail for a
 * flat tool count. Large catalogs need the trade: tool-selection quality
 * degrades well before a hundred tools.
 */
export type McpToolStyle = "dedicated" | "generic";

export interface McpResourceConfig {
  /**
   * Absolute URI of the entity's MCP catalogue resource, e.g.
   * `app://things`. The single-record resource template is derived from it
   * as `<uri>/{id}`. Restricted to `scheme://path` with safe characters,
   * because it is emitted verbatim into the MCP resource listing that the
   * runtime dispatches on.
   */
  uri: string;
  /** Human-readable resource name; defaults to the entity's plural label. */
  name?: string;
  /** Resource description; defaults to a composed one naming the entity. */
  description?: string;
  /** Description of the derived single-record template. */
  templateDescription?: string;
}

/**
 * Canonical URL fields on a row interpreted as a declarative adapter.
 * Operations may select only an entry authored in `baseUrlTemplates`; callers
 * and connection values never supply an origin.
 */
export interface McpDeclarativeAdapterUrls {
  baseUrlTemplate: string;
  baseUrlTemplates?: Record<string, string>;
}

/** Canonical URL selector inside a declarative operation definition. */
export interface McpDeclarativeOperationUrl {
  baseUrlKey?: string;
}

/** One authored, fixed HTTP header target fed by a declared operation input. */
export interface McpDeclarativeRequestHeaderMapping {
  field: string;
  header: string;
}

/** Canonical provider-request placement rules carried by an operation row. */
export interface McpDeclarativeRequestMapping {
  queryParams?: Array<{ field: string; param: string }>;
  bodyPaths?: Array<{ field: string; path: string }>;
  /** Header names are authored metadata; callers supply only field values. */
  headers?: McpDeclarativeRequestHeaderMapping[];
}

/**
 * Where a derived tool's ordered binding rows live: an owned hasMany
 * collection whose target carries the binding vocabulary.
 */
/**
 * Version 2 entity authoring keeps behaviour in canonical operations and lets
 * interfaces only opt into those operations.  The first supported
 * implementation kind is generated entity CRUD; custom/plugin operations can
 * be added without changing this entity contract.
 */
export type EntityOperationAction = CrudOperationKey;

/**
 * Transport-neutral request for server-issued secure input on an Operation.
 * The `into` field is server-owned: generated entity inputs must never accept
 * it directly from a model, browser form, REST body or GraphQL mutation.
 */
export type EntityOperationSecureInput = {
  type: "secureInput";
  sourceField: string;
  sourceEntity: string;
  definitionsField: string;
  into: string;
  message?: string;
};

/**
 * A value owned by the canonical Operation rather than any of its interface
 * payloads. `actorRelation` deliberately differs from `actorUserId`: a human
 * attribution may require the tenant-confirmed Relation, while background and
 * system actors must keep their explicit identity and can never masquerade as
 * that Relation.
 */
export type EntityOperationStamp = {
  field: string;
  source: "now" | "actorRelation" | "actorUserId";
};

export interface EntityOperationDefinition {
  /** Stable canonical id for a plugin Operation; defaults to `<Entity>.<key>`. */
  id?: string;
  name: string | LocalizedText;
  description: string | LocalizedText;
  guidance?: { assistant?: string | LocalizedText };
  prerequisites?: OperationPrerequisite[];
  stamps?: EntityOperationStamp[];
  implementation:
    | { type: "collection"; action: "insert" | "move" | "update" | "remove"; field: string }
    | {
        type: "entity";
        action: EntityOperationAction;
      }
    | {
        /** Runtime code only; the YAML remains the canonical contract. */
        type: "plugin";
        plugin: string;
        handler: string;
        /** Canonical entity CRUD intent implemented by this handler. */
        action?: "create" | "update" | "delete";
      };
  /** How a record-scoped plugin Operation binds the current record to input. */
  target?:
    | { scope: "collection" }
    | { scope: "record"; inputField: string };
  input?: { schema: Record<string, unknown> };
  output?: { schema: Record<string, unknown> };
  errors?: Array<{
    status: number;
    code: string;
    description: string;
    schema?: Record<string, unknown>;
    rest?: { body?: unknown; contentType?: string };
  }>;
  auth?: import("../../plugins.js").PluginOperationAuth;
  tenancy?: {
    mode: "required" | "derived" | "none";
    description?: string;
  };
  effects: {
    data: "read" | "write" | "delete";
    external: "none" | "read" | "write";
  };
  reliability: {
    idempotency: {
      mode: "natural" | "keyed" | "none";
      /** Required for keyed plugin Operations; populated from Idempotency-Key on REST. */
      inputField?: string;
      header?: string;
    };
  };
  concurrency?: OperationConcurrency;
  confirmation: OperationConfirmation;
  interaction?: EntityOperationSecureInput;
}

export interface EntityInterfaceOperationProjectionConfig {
  /** MCP-only wording may refine, but never redefine, the operation. */
  instructions?: string | LocalizedText;
}

export interface EntityRestOperationProjectionConfig
  extends EntityInterfaceOperationProjectionConfig {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path?: string;
  response?: {
    status?: number;
    kind: "json" | "binary" | "stream";
    contentType?: string;
  };
}

export interface EntityWebOperationProjectionConfig extends EntityInterfaceOperationProjectionConfig {
  /** Presentation only; never changes the operation result or its authorization. */
  resultRenderer?: string;
}

export interface EntityMcpOperationProjectionConfig
  extends EntityInterfaceOperationProjectionConfig {
  name?: string;
}

export interface EntityGraphqlOperationProjectionConfig
  extends EntityInterfaceOperationProjectionConfig {
  kind?: "query" | "mutation";
  field?: string;
}

/** `false` is an explicit interface-local exclusion; omission inherits projection. */
export type EntityInterfaceOperationProjection =
  | false
  | EntityInterfaceOperationProjectionConfig;

export type EntityWebNamedViewDefinition =
  | { kind: "record"; fields: string[] }
  | {
      kind: "record";
      title?: string;
      layout: { tabs: import("./views.js").ViewGroup[] };
    }
  | { kind: "collection"; collectionLayout: "table" | "tabs" | "stack"; itemView?: string; tabLabel?: string };

export interface EntityWebViewDefinition {
  /** Additional target-owned views, addressable by relationship placements. */
  named?: Record<string, EntityWebNamedViewDefinition>;
  /** Authoring shorthand: every non-reserved key is a target-owned named view. */
  [name: string]: unknown;
  collection: {
    /** Opaque host renderer-registry key; omission uses the generic collection renderer. */
    renderer?: string;
    route: string | LocalizedText;
    title?: LocalizedText;
    /** Ordered collection-scoped plugin Operations shown by Web consumers. */
    actions?: string[];
    columns: { key: string; label?: LocalizedText; sortable?: boolean }[];
    defaultSort?: { key: string; direction: "asc" | "desc" };
  };
  record?: {
    /** Opaque host renderer-registry key; omission uses the generic record renderer. */
    renderer?: string;
    routes?: { read?: string | LocalizedText; create?: string | LocalizedText };
    title: string;
    subtitle?: string;
    badges?: string[];
    variableSources?: import("./views.js").FormVariableSource[];
    actions?: string[];
    layout: {
      tabs: import("./views.js").ViewGroup[];
      /** Deliberately selected summary, independent of the full record tabs. */
      context?: { fields: string[]; relationships?: string[] };
    };
    modes?: {
      create?: { title: LocalizedText; groups: import("./views.js").ViewGroup[] };
      update?: { title: LocalizedText; groups?: import("./views.js").ViewGroup[] };
    };
  };
}

export interface EntityInterfacesDefinition {
  rest?: {
    basePath?: string;
    operations?: Record<
      string,
      false | EntityRestOperationProjectionConfig
    >;
  };
  graphql?: {
    operations?: Record<
      string,
      false | EntityGraphqlOperationProjectionConfig
    >;
  };
  mcp?: {
    /** Technical tool projection; defaults to one dedicated tool per operation. */
    tools?: McpToolStyle;
    operations?: Record<string, false | EntityMcpOperationProjectionConfig>;
    resource?: McpResourceConfig;
  };
  web?: {
    fields?: Record<string, { render: FieldRender }>;
    operations?: Record<string, false | EntityWebOperationProjectionConfig>;
    views?: EntityWebViewDefinition;
  };
}

/** One web page of standalone Operations (a menu entry without an entity). */
export interface OperationCatalogWebPage {
  title: LocalizedText;
  description?: LocalizedText;
  /** Battery icon key, e.g. `buildings`. */
  icon?: string;
  order?: number;
}

/** Where a standalone Operation appears on the web. */
export interface OperationCatalogWebOperation {
  page: string;
  /** Runs when the page opens and shows its result first; read operations without required input only. */
  landing?: boolean;
  order?: number;
}

export interface OperationCatalogWebInterface {
  pages: Record<string, OperationCatalogWebPage>;
  operations: Record<string, OperationCatalogWebOperation>;
  /** Provider-backed resources that use normal entity collection/detail views. */
  entities?: Record<string, {
    title: LocalizedText;
    route: string;
    recordRoute?: string;
    idField: string;
    displayField: string;
    fields: string[];
    columns: string[];
    operations: {
      list: { operation: string; resultField: string; bindings?: Record<string, string> };
      get?: { operation: string; resultField?: string; bindings?: Record<string, string> };
      collectionActions?: string[];
      recordActions?: Array<string | { operation: string; visibleWhen?: VisibilityConfig }>;
    };
    related?: Array<{ entity: string; label: LocalizedText; route: string }>;
  }>;
}

/** YAML-owned module/global Operations that have no honest entity target. */
export interface OperationCatalogDefinition {
  schemaVersion: 1;
  kind: "operationCatalog";
  plugin: string;
  operations: Record<string, EntityOperationDefinition>;
  interfaces: Omit<EntityInterfacesDefinition, "web"> & { web?: OperationCatalogWebInterface };
}

export interface CoreEntity {
  /** Explicit safe scalar content copied from a published blueprint. */
  blueprint?: { fields: string[] };
  /** Named cross-tenant worker; enforced together with the dedicated DB role. */
  workerAccess?: string;
  schemaVersion: number;
  kind: "coreEntity";
  module: string;
  entity: string;
  title: string;
  description?: string | LocalizedText;
  language: string;
  labels?: LocalizedText;
  /** Plural labels carried by derived inverse collections; absent, the English label is pluralised and other locales keep their singular. */
  pluralLabels?: LocalizedText;
  domains?: string[];
  retention?: RetentionPolicy;
  baseEntity?: boolean;
  /**
   * Canonical human-readable display template for an entity instance.
   * Mustache-style placeholders reference entity field keys, e.g.
   * `"{{title}}"` or `"{{street}} {{houseNumber}}"`. Consumed by variable
   * pickers, relationship cards, workflow node inspectors, and anywhere
   * the UI needs to show a "name" for a record. Required at the canonical
   * layer — every entity should have a sensible display template.
   */
  displayTemplate?: string;
  /**
   * Field key used when filtering a list of this entity by free-text user
   * input (e.g. the typeahead in a variable picker). The compiler wires
   * this into the generated `FilterInput` usage so consumers can do
   * `filter: { [filterField]: userInput }` with `ilike %value%` semantics.
   * When absent, consumers fall back to the entity's default display
   * field or skip filtering entirely.
   */
  filterField?: string;
  /**
   * Optional storage-level indexes for this entity. Compiled into
   * TableDefinition.indexes and emitted as `CREATE [UNIQUE] INDEX IF NOT
   * EXISTS` in the generated DB schema. Use sparingly — only declare an index
   * here when it backs a runtime contract the engine relies on (e.g.
   * tenant-scoped uniqueness for `ON CONFLICT (...) DO NOTHING` idempotency
   * inserts in append-only financial ledgers).
   *
   * `fields` references entity field keys (camelCase); the compiler resolves
   * each to its persisted column name when emitting SQL. Always include
   * `tenantId` first for tenant-scoped uniqueness so the constraint is
   * naturally tenant-isolated.
   */
  indexes?: AuthoredEntityIndex[];
  /**
   * Opt-in immutable publication history for an editable entity head.
   * The compiler supplies lifecycle fields and the canonical publish Operation;
   * the version entity stores the frozen snapshot.
   */
  versioning?: {
    strategy: "publishedSnapshot";
    versionEntity: string;
    versionsField: string;
    snapshot?: { ownedRelationships?: "recursive" };
  };
  /** Optional shared-runtime hard-delete restrictions. */
  hardDelete?: {
    requireNeverPublished: true;
  };
  fields: Field[];
  authorization?: AuthorizationConfig;
  /** Derived by the compiler from `interfaces.web`; never authored. */
  ui?: UIDefinition;
  /**
   * Canonical Operations: every behaviour of the entity, including generated
   * CRUD, is one of these. Exposure per transport is declared under
   * `interfaces`, which may narrow this set but never widen it.
   */
  operations?: Record<string, EntityOperationDefinition>;
  /** Thin interface projections (REST, GraphQL, MCP, web). */
  interfaces?: EntityInterfacesDefinition;
}

export interface ThirdPartyApiEndpoint {
  method: string;
  endpoint: string;
}

export interface EntityProfile {
  schemaVersion: number;
  kind: "entityProfile";
  profile: string;
  entity: string;
  extends: string;
  title?: string;
  description?: string | LocalizedText;
  language: string;
  domains?: string[];
  retention?: RetentionPolicy;
  baseEntity?: boolean;
  /**
   * Profile-specific display template. If absent, consumers fall back to
   * the core entity's displayTemplate. Useful when profile-flavoured entities
   * want to render using profile field keys (e.g. `{{code}}` or
   * `{{naam}}`).
   */
  displayTemplate?: string;
  /**
   * Profile-specific filter field for typeahead pickers. If absent,
   * consumers fall back to the core entity's filterField.
   */
  filterField?: string;
  fields?: Field[];
  authorization?: ProfileAuthorizationConfig;
  projection?: {
    thirdPartyApi?: {
      purpose?: string;
      entityName: string;
      endpoints: Record<string, ThirdPartyApiEndpoint>;
    };
  };
  ui?: UIDefinition;
  storage?: {
    profileTable: string;
  };
}

export interface FieldMapping {
  source: string;
  target: string;
  transform?: string;
  mappingType: "direct" | "fallback" | "derived";
  notes?: string;
}

export interface ProfileExtension {
  field: string;
  reason: string;
}

export interface EntityMapping {
  schemaVersion: number;
  kind: "entityMapping";
  profile: string;
  sourceEntity: string;
  targetEntity: string;
  identityMapping: {
    source: string;
    target: string;
    notes?: string;
  };
  fieldMappings: FieldMapping[];
  profileExtensions?: ProfileExtension[];
}

export interface AuthorizationRealmRole {
  description?: string;
  composite?: boolean;
  attributes?: Record<string, string[]>;
  /** Per-client explicit composite role mapping: {clientId: [roleName, ...]}. */
  composites?: Record<string, string[]>;
  /** Wildcard-expansion patterns (e.g. "*:full") over entity-derived roles. */
  includes?: string[];
}

/**
 * A client role that groups roles from one or more resource clients.
 *
 * This is the audience-scoped counterpart of a realm-role composite: hosts can
 * expose product personas on their own API audience without promoting those
 * personas to realm-global roles.
 */
export interface AuthorizationClientRoleComposite {
  description?: string;
  attributes?: Record<string, string[]>;
  /** Per-client composite role mapping: {clientId: [roleName, ...]}. */
  composites: Record<string, string[]>;
}

export interface AuthorizationRealmSettings {
  // Legacy v1 fields (still honored).
  eventsEnabled?: boolean;
  adminEventsEnabled?: boolean;
  eventsListeners?: string[];
}

export interface AuthorizationRealmConfig {
  name?: string;
  displayName?: string;
  enabled?: boolean;
  sslRequired?: "none" | "external" | "all";
  loginTheme?: string;
  accountTheme?: string;
  adminTheme?: string;
  emailTheme?: string;
  registrationAllowed?: boolean;
  loginWithEmailAllowed?: boolean;
  duplicateEmailsAllowed?: boolean;
  resetPasswordAllowed?: boolean;
  editUsernameAllowed?: boolean;
  bruteForceProtected?: boolean;
  organizationsEnabled?: boolean;
  accessTokenLifespan?: number;
  ssoSessionIdleTimeout?: number;
  ssoSessionMaxLifespan?: number;
  events?: {
    enabled?: boolean;
    adminEnabled?: boolean;
    listeners?: string[];
  };
  /**
   * WebAuthn / passkey settings. Every generated realm is passkey-only for
   * humans (see generators/keycloak-passkeys.ts); the one value the compiler
   * cannot work out for itself is authored here.
   */
  webAuthn?: {
    /**
     * The WebAuthn relying-party id: a BARE HOSTNAME (no scheme, no port, no
     * path) that must be Keycloak's browser-facing hostname or a registrable
     * parent it shares with the app — e.g. `example.com` for a login page on
     * `auth.example.com`. May be a `${env:VAR:-devDefault}` reference.
     * Required for a production realm; a development realm falls back to
     * `localhost`, which it never actually uses because local login is
     * relaxed to passwords by scripts/keycloak/kc-dev-password-login.py.
     */
    rpId?: string;
  };
}

export interface AuthorizationClient {
  id: string;
  kind: "gateway" | "bearerOnly" | "serviceAccount";
  name?: string;
  /**
   * Client secret. To keep real credentials out of the committed config it may
   * be an env reference of the form `${env:VAR_NAME}` (optionally with a
   * `${env:VAR_NAME:-fallback}` default), which is resolved at generate time.
   * A literal secret is only permitted on a dev realm — use `devSecret` for
   * that so its dev-only nature is explicit. Generation fails if a non-dev
   * realm carries a literal (unreferenced) secret.
   */
  secret?: string;
  /**
   * Dev-only literal client secret. Only honored when the realm is a
   * development realm (see isDevRealm in generators/keycloak.ts); generation
   * fails if a non-dev realm still carries a devSecret. Keeps the docker-compose
   * dev stack working without shipping a usable credential to production.
   */
  devSecret?: string;
  /**
   * Explicit redirect-URI allow-list for a gateway (standard-flow) client.
   * Required for gateway clients; "*" is forbidden. Ignored for other kinds.
   */
  redirectUris?: string[];
  /**
   * Explicit web-origin (CORS) allow-list for a gateway client. "*" is
   * forbidden. Ignored for other kinds.
   */
  webOrigins?: string[];
  /**
   * Client roles granted to this client's own service account
   * (`serviceAccount` kind only). Emitted as a synthetic
   * `service-account-<id>` user carrying `serviceAccountClientId` so the
   * realm import wires the mappings. Used to grant the auth-api service
   * account the `realm-management` capabilities the SPI admin endpoints
   * require (e.g. `{ "realm-management": ["manage-realm"] }`).
   */
  serviceAccountClientRoles?: Record<string, string[]>;
  /** Tenant fixed to this service-account client by host-owned authorization. */
  serviceAccountTenantId?: string;
  /** Marks the client as an organization automation identity, never a human login. */
  organizationAutomation?: boolean;
}

/**
 * One Keycloak identity-provider mapper, emitted into the realm export's
 * flattened `identityProviderMappers` list bound to its provider's alias.
 * `identityProviderMapper` is Keycloak's mapper type id (e.g.
 * `oidc-user-attribute-idp-mapper`, `hardcoded-role-idp-mapper`). `config` is
 * passed through as-is except that scalars are normalized to the strings
 * Keycloak's representation requires.
 */
export interface AuthorizationIdentityProviderMapper {
  name: string;
  identityProviderMapper: string;
  config?: Record<string, string | number | boolean>;
}

/**
 * One external identity provider (Keycloak `identityProviders[]` entry).
 *
 * Provider-agnostic on purpose: OSF ships the provider IMPLEMENTATIONS (the
 * Keycloak built-ins and the Apple provider jar in the Keycloak image) and
 * this contract, but never a provider. Which providers exist, and every ID,
 * URL, scope and mapping they carry, is the consuming host's authored value
 * and is emitted unchanged. Nothing here is enabled unless a realm authors it.
 *
 * `providerId` is Keycloak's provider type: a built-in (`google`, `microsoft`,
 * `github`, `oidc`, `saml`, …), `apple` (from the bundled provider jar), or any
 * other provider id an approved custom provider registers. It is not
 * validated against a list so approved custom providers keep working.
 */
export interface AuthorizationIdentityProvider {
  /** Realm-unique alias; also the login-URL segment and mapper binding key. */
  alias: string;
  providerId: string;
  displayName?: string;
  /** Defaults to true. */
  enabled?: boolean;
  /** Defaults to false: a broker-asserted email is not trusted by default. */
  trustEmail?: boolean;
  /** Defaults to false: provider tokens are not stored unless a host opts in. */
  storeToken?: boolean;
  /** Defaults to false. */
  linkOnly?: boolean;
  /** Defaults to false. */
  hideOnLogin?: boolean;
  firstBrokerLoginFlowAlias?: string;
  postBrokerLoginFlowAlias?: string;
  /**
   * Non-secret Keycloak provider config (clientId, issuer, authorizationUrl,
   * tokenUrl, jwksUrl, defaultScope, teamId, keyId, …). Emitted unchanged
   * except that scalars become strings and `${env:VAR}` references are
   * resolved. Secret-like keys (secret, password, privateKey, p8Key, token —
   * case-insensitive substrings) are refused here; they belong in `secrets`.
   */
  config?: Record<string, string | number | boolean>;
  /**
   * Sensitive Keycloak config keys (e.g. `clientSecret`; for Apple, the raw
   * `.p8` private-key content). In production every value must be a
   * `${env:VAR}` reference whose variable is set; a literal fails generation.
   */
  secrets?: Record<string, string>;
  /**
   * Development-only literal secrets, taking precedence over `secrets` in
   * development mode. Refused outright in production.
   */
  devSecrets?: Record<string, string>;
  mappers?: AuthorizationIdentityProviderMapper[];
}

/** Nested Keycloak group tree; `path` in the export is `/parent/child`. */
export interface AuthorizationGroupNode {
  name: string;
  realmRoles?: string[];
  clientRoles?: Record<string, string[]>;
  subGroups?: AuthorizationGroupNode[];
}

export interface AuthorizationUser {
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  password: string;
  tid?: string;
  realmRoles?: string[];
  /** Keycloak group paths; must match emitted `groups[].path` values. */
  groups?: string[];
  clientRoles?: Record<string, string[]>;
  enabled?: boolean;
}

/**
 * What a role means to the person holding it, per language. `label` is the
 * title-case name a persona is shown as; `phrase` the lower-case wording
 * inside a sentence. Display only.
 */
export interface AuthorizationRoleLabel {
  label?: Record<string, string>;
  phrase?: Record<string, string>;
}

export interface AuthorizationConfigFile {
  schemaVersion: number;
  kind: "authorizationConfig";

  /** v2 top-level realm config. */
  realm?: AuthorizationRealmConfig;

  keycloak: {
    /** v1 legacy: the client that receives entity-derived roles. */
    client?: string;
    /** v2: the client that receives entity-derived roles. */
    entityRoleClient?: string;
    /** v1 legacy: admin events config. */
    realm?: AuthorizationRealmSettings;
    /** v1 legacy: realm roles. Prefer top-level `realmRoles` in v2. */
    realmRoles?: Record<string, AuthorizationRealmRole>;
    /** v2: clients to emit into realm-export.json. */
    clients?: AuthorizationClient[];
    /**
     * v2: external identity providers (social / corporate OIDC / SAML). Host
     * authored and host owned; none is emitted unless listed here.
     */
    identityProviders?: AuthorizationIdentityProvider[];
  };

  /** v2 top-level realm roles (preferred over keycloak.realmRoles). */
  realmRoles?: Record<string, AuthorizationRealmRole>;

  /** v2 hand-authored client roles per clientId (merged with entity-derived). */
  clientRoles?: Record<string, string[]>;

  /**
   * v2 audience-scoped composite roles, keyed first by owning clientId and then
   * by role name. Their grants may target any declared client role set.
   */
  clientRoleComposites?: Record<
    string,
    Record<string, AuthorizationClientRoleComposite>
  >;

  /**
   * v2 Keycloak group hierarchy for dev/demo (organizational labels, optional
   * realm role mappings on groups).
   */
  groups?: AuthorizationGroupNode[];

  /** v2 dev test users. */
  users?: AuthorizationUser[];

  /**
   * Who a login is, in entity terms: the party it acts as, the person record
   * beside it, where its e-mail lives and which role administers the
   * organization. Declared once per deployment; emitted as identity.json.
   */
  identity?: {
    administratorRole: string;
    memberRoles: string[];
    actingParty: {
      entity: string;
      nameField: string;
      typeField: string;
      personType: string;
      organizationType: string;
      statusField: string;
      activeStatus: string;
      /** The field the organization resource shows as its profile text. */
      profileField: string;
    };
    person: {
      entity: string;
      relationField: string;
      firstNameField: string;
      lastNameField: string;
    };
    loginContact: {
      entity: string;
      relationField: string;
      typeField: string;
      emailType: string;
      valueField: string;
      primaryField: string;
      statusField: string;
      activeStatus: string;
    };
  };
  /** What each role means to its holder, keyed by role name (display only). */
  roleLabels?: Record<string, AuthorizationRoleLabel>;
}

export interface TransformDefinition {
  type: "enumMap" | "cast" | "fallbackChain";
  input: string;
  output: string;
  description: string;
  mappings?: Record<string, string>;
  candidates?: string[];
}

export interface TransformCatalog {
  schemaVersion: number;
  kind: "transformCatalog";
  transforms: Record<string, TransformDefinition>;
}
