// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
import type {
  LocalizedText,
  FieldValidation,
  SemanticTypeLookupDefinition,
  EntityPermissions,
  FieldOptions,
  DataClassification,
  RetentionPolicy,
  ContextHints,
  EntityHooks,
  AuthorizationConfig,
  ProfileAuthorizationConfig,
} from "./common.js";
import type { Relationship, UIDefinition } from "./views.js";
import type {
  FieldDefinition,
  FieldDefinitionAuthoringMetadata,
  FieldDefinitionCardinality,
  FieldDefinitionRelationship,
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

export interface SemanticTypeDefinition {
  /**
   * Discriminator for entity-ID semantic types. When set to `"entityId"`,
   * the entry MUST also declare `entity`, `listUrl`, `displayTemplate`,
   * `filterField`, `icon`, and `render.{display,input}` (see the catalog
   * JSON schema and `checks.ts` for enforcement). Absent on value-shape
   * semantic types.
   */
  kind?: "scalar" | "entityId" | "entity" | "object";
  label: LocalizedText;
  pluralLabel?: LocalizedText;
  valueType:
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
  lookup?: SemanticTypeLookupDefinition;
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
   * For entity-ID semantic types (`kind: "entityId"`): the kebab-case slug
   * of the entity this type identifies. Lets downstream consumers
   * (variable pickers, workflow inspector, the core-entity-options route)
   * resolve from a `semanticType` string back to the entity it represents.
   */
  entity?: string;
  /**
   * For entity-ID semantic types: the canonical workflow-designer options
   * URL, always shaped as
   * `/api/workflow/designer/core-entity-options?entity=<entity-slug>`.
   */
  listUrl?: string;
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

export interface SemanticTypeCatalog {
  schemaVersion: number;
  kind: "semanticTypeCatalog";
  types: Record<string, SemanticTypeDefinition>;
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
   * resolves each to the corresponding persisted column name. For
   * tenant-scoped uniqueness include `tenantId` first.
   */
  fields: string[];
  /** When true, generates `CREATE UNIQUE INDEX` instead of `CREATE INDEX`. */
  unique?: boolean;
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

export interface McpOperationConfig {
  /** Defaults to true. */
  enabled?: boolean;
  /**
   * Override the complete generated tool name for this operation, replacing
   * the `<toolPrefix>_<operation>` default (`dedicated` style only — the
   * shared `osf_*` tools cannot be renamed per entity). Emitted verbatim into
   * tool names, so the compiler restricts it to `^[a-z][a-z0-9_]*$` and
   * fails closed on a duplicate across the catalog.
   */
  name?: string;
  /**
   * Override the generated tool description for this operation (`dedicated`
   * style only). Use for short, operational, entity-specific guidance; the
   * compiler-composed default is used when absent.
   */
  description?: string;
}

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

export interface McpDerivedVisibilityConfig {
  /** Row field that gates projection. */
  field: string;
  /** Value the field must equal for the row to project as a tool. */
  equals: string;
}

export interface McpDerivedConnectConfig {
  /** Tool name for the provider-connection handoff, e.g. `connect_service`. */
  name: string;
  /** Override the composed tool description. */
  description?: string;
  /** Roles allowed to create or replace a shared tenant connection. */
  roles: string[];
}

export interface McpDerivedPersonalizationConfig {
  /** Entity whose rows hold one person's instruction for a derived tool. */
  entity: string;
  /**
   * Field on the preference row referencing the defining row's id; an empty
   * value means the instruction applies to every tool of this projection.
   */
  serviceRef: string;
  /** Field holding the person's instruction text. */
  instructionField: string;
  /** The audience-facing tool that stores the caller's own instruction. */
  set: { name: string; description?: string };
}

export interface McpDerivedDryRunConfig {
  /** Tool name for the composition preview, e.g. `dry_run_service`. */
  name: string;
  /** Override the composed tool description. */
  description?: string;
  /**
   * Roles offered the dry run — typically the definition AUTHORS, not the
   * derived tools' audience: the composed requests expose provider URLs and
   * header shapes that are authoring detail.
   */
  roles: string[];
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

export interface McpDerivedToolsConfig {
  /**
   * Roles whose sessions are offered the derived tools. Deliberately separate
   * from the entity's CRUD roles: the audience of the derived tools is
   * usually NOT the audience allowed to manage the defining rows.
   */
  roles: string[];
  /** Field whose value names the derived tool (sanitized to snake_case). */
  keyField: string;
  /** Field whose value becomes the derived tool's title. */
  titleField?: string;
  /** Field whose value becomes the derived tool's description. */
  descriptionField: string;
  /**
   * Field holding the collection of canonical FieldDefinition objects that
   * the runtime translates into the derived tool's input JSON Schema.
   */
  inputFieldsField: string;
  /**
   * Optional field holding canonical FieldDefinition objects for model-visible
   * outputs. Core uses it to bound runtime authorization decisions.
   */
  outputFieldsField?: string;
  versionField?: string;
  /**
   * Opt-in declarative execution: calling a derived tool runs its bindings
   * against the referenced operation/provider/connection rows, whose fields
   * follow the canonical OSF integration vocabulary (transport, method,
   * pathTemplate, baseUrlTemplate, auth, egressHosts, responseMapping, …).
   * Absent, a derived tool call answers 501.
   */
  execution?: McpDerivedExecutionConfig;
  /**
   * Only rows matching this predicate project as tools — the publication
   * gate: a draft definition is invisible to its audience until published.
   */
  visibleWhen?: McpDerivedVisibilityConfig;
  /**
   * Opt-in per-row audience restriction: names an authored field holding a
   * role list. A row whose list is non-empty projects (and answers) only
   * for sessions holding one of those roles — how an administrative
   * definition stays invisible to the wider audience.
   */
  visibleToRolesField?: string;
  /** Boolean field whose true rows are callable only through internal MCP dispatch. */
  internalOnlyField?: string;
  /**
   * Opt-in personal-connection handoff tool: given one projected row, the
   * runtime validates the row's execution chain and returns a provider
   * authorization URL (PKCE) for the CALLER to open. Requires `execution`.
   */
  connect?: McpDerivedConnectConfig;
  /**
   * Opt-in composition preview tool: given a derived tool's name and
   * arguments, the runtime composes the exact provider request(s) the call
   * would make — method, URL, headers with placeholder credentials, body —
   * WITHOUT sending them, and works on rows the visibility gate still hides,
   * so authors verify a definition before publishing it. Requires
   * `execution`.
   */
  dryRun?: McpDerivedDryRunConfig;
  /**
   * Opt-in per-person instructions: each audience member may store one
   * instruction per derived tool (or one for all of them), which the
   * projection appends to that tool's description FOR THAT PERSON — under
   * the authored description, labelled as subordinate to it. This is how a
   * person's standing preferences reach every client they use, without a
   * new runtime concept on the assistant's side.
   */
  personalization?: McpDerivedPersonalizationConfig;
}

export interface McpElicitOnCreateConfig {
  /** Local field whose value references the source row (e.g. a relation id). */
  sourceField: string;
  /** Entity whose row carries the field definitions to elicit. */
  sourceEntity: string;
  /** Field on the source row holding the FieldDefinition collection. */
  definitionsField: string;
  /**
   * Local field the elicited values are stored into. Excluded from the
   * create tool's input schema: these values come from the person at the
   * client, never from the model, and anything the model passes anyway is
   * discarded before the elicited values are stored.
   */
  into: string;
  /** Optional custom prompt shown above the elicitation form. */
  message?: string;
}

export interface McpDiscoveryConfig {
  /** Tool name, e.g. `discover_provider`; same alphabet as other tool names. */
  name: string;
  /** Override the composed tool description. */
  description?: string;
}

export interface McpTestConfig {
  /** Tool name, e.g. `test_connection`; same alphabet as other tool names. */
  name: string;
  /** Override the composed tool description. */
  description?: string;
}

export interface McpGuideConfig {
  /** Tool name, e.g. `setup_provider_guide`. */
  name: string;
  /** Tool description; say WHEN to call it (e.g. "call this first when ..."). */
  description: string;
  /** Roles whose sessions see the guide. */
  roles: string[];
  /** The playbook itself, returned verbatim as the tool result. */
  content: string;
  /**
   * Enforce the "call this first" that descriptions alone cannot: a stateful
   * session that has not called this guide is refused CREATE operations on
   * the guide's own entity, with the guide named as the next step. Exists
   * because agents carrying cached local procedures skip voluntary guidance.
   */
  requireBeforeCreate?: boolean;
}

export interface McpConfig {
  /** Defaults to true when the `mcp` block is present. */
  enabled?: boolean;
  /**
   * Tool-name prefix for `dedicated` style; defaults to the entity name in
   * snake_case (`ContactDetail` → `contact_detail`). Emitted verbatim into
   * tool names, so the compiler restricts it to `^[a-z][a-z0-9_]*$`.
   */
  toolPrefix?: string;
  /** Defaults to `dedicated`. */
  tools?: McpToolStyle;
  /**
   * Per-operation flags; each defaults to true when MCP is enabled. The
   * object form additionally overrides the generated tool name and/or
   * description for that operation.
   */
  operations?: Partial<Record<McpOperationKey, boolean | McpOperationConfig>>;
  /**
   * Opt-in MCP resource exposure: a direct catalogue resource at `uri` plus
   * a derived `<uri>/{id}` template for one record. Reads are authorized like
   * the entity's read operations.
   */
  resource?: McpResourceConfig;
  /**
   * Opt-in schema discovery tool: given a row id, the runtime fetches the
   * row's declared schema document (canonical fields `discovery`, `schemaUrl`,
   * `egressHosts`) and returns a compact operation summary. Visibility follows
   * the entity's read role.
   */
  discovery?: McpDiscoveryConfig;
  /**
   * Opt-in authored playbook, projected as a zero-argument tool returning
   * the content verbatim. This is how a product pins a fixed process for
   * assistants — choreography that field schemas alone cannot carry.
   */
  guide?: McpGuideConfig;
  /**
   * Opt-in runtime projection of this entity's ROWS as MCP tools: each stored
   * record becomes one tool, named from keyField and typed from the canonical
   * FieldDefinition collection in inputFieldsField. This is how a deployment's
   * own admins author new tools as data instead of code.
   */
  derivedTools?: McpDerivedToolsConfig;
  /**
   * Opt-in MCP elicitation on the create operation: the runtime collects the
   * values for the source row's field definitions directly from the person at
   * the client via a standard elicitation form, so tenant configuration and
   * secrets never travel through model context or tool arguments.
   */
  elicitOnCreate?: McpElicitOnCreateConfig;
  /**
   * Opt-in verification tool for rows whose values were elicited: given a row
   * id, the runtime checks the stored values against the source row's
   * definitions and auth contract, and — when the source declares a `probe`
   * request — exercises them against the provider. Requires `elicitOnCreate`
   * (the wiring to the source row comes from it); visibility follows the
   * entity's read role.
   */
  test?: McpTestConfig;
}

export interface CoreEntity {
  schemaVersion: number;
  kind: "coreEntity";
  module: string;
  entity: string;
  title: string;
  description?: string | LocalizedText;
  language: string;
  labels?: LocalizedText;
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
  fields: Field[];
  relationships?: Relationship[];
  hooks?: EntityHooks;
  permissions?: EntityPermissions;
  authorization?: AuthorizationConfig;
  ui?: UIDefinition;
  /**
   * Common generated-CRUD policy shared by every transport. Absent or `true`
   * preserves the historical all-operations default; `false` disables the
   * entity completely. The object form can make an entity read-only or expose
   * any smaller operation set. REST, MCP, workflow and later layers may narrow
   * this policy but never widen it.
   */
  crud?: boolean | CrudConfig;
  /**
   * Opt-in generated REST exposure for this entity. Absent or `false` means
   * no REST routes are generated (fail closed, mirroring the generatedCrud
   * allowlist). `true` enables every operation under a base path derived
   * from the entity name (plural kebab-case, e.g. `RelationGroup` →
   * `relation-groups`). The object form allows per-operation flags and a
   * custom base path; `basePath` is emitted verbatim into route strings and
   * OpenAPI paths, so the loader restricts it to `^[a-z][a-z0-9-]*$`.
   */
  rest?: boolean | RestConfig;
  /**
   * Opt-in generated MCP (Model Context Protocol) exposure for this entity.
   * Absent or `false` means no tools are generated — fail closed, exactly as
   * `rest` does. `true` emits one tool per operation under a prefix derived
   * from the entity name (snake_case, e.g. `ContactDetail` →
   * `contact_detail`). The object form allows per-operation flags, a custom
   * prefix, and the `generic` tool style for large catalogs.
   */
  mcp?: boolean | McpConfig;
  workflow?: {
    nodes?: {
      actions?: {
        create?:
          | boolean
          | {
              enabled?: boolean;
              readableFields?: string[];
              writableFields?: string[];
            };
        getOne?:
          | boolean
          | {
              enabled?: boolean;
              readableFields?: string[];
              writableFields?: string[];
            };
        list?:
          | boolean
          | {
              enabled?: boolean;
              readableFields?: string[];
              writableFields?: string[];
              defaultSort?: {
                field: string;
                direction: "asc" | "desc";
              };
            };
        update?:
          | boolean
          | {
              enabled?: boolean;
              readableFields?: string[];
              writableFields?: string[];
            };
        delete?:
          | boolean
          | {
              enabled?: boolean;
              readableFields?: string[];
              writableFields?: string[];
            };
        wait?:
          | boolean
          | {
              enabled?: boolean;
              readableFields?: string[];
              writableFields?: string[];
            };
        awaitAction?:
          | boolean
          | {
              enabled?: boolean;
              readableFields?: string[];
              writableFields?: string[];
            };
      };
    };
  };
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
  relationships?: Relationship[];
  authorization?: ProfileAuthorizationConfig;
  projection?: {
    thirdPartyApi?: {
      purpose?: string;
      entityName: string;
      endpoints: Record<string, ThirdPartyApiEndpoint>;
    };
  };
  ui?: UIDefinition;
  crud?: boolean | CrudConfig;
  workflow?: {
    nodes?: {
      actions?: Partial<
        Record<
          | "create"
          | "getOne"
          | "list"
          | "update"
          | "delete"
          | "wait"
          | "awaitAction",
          | boolean
          | {
              enabled?: boolean;
              readableFields?: string[];
              writableFields?: string[];
            }
        >
      >;
    };
  };
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
   * v2 Keycloak group hierarchy for dev/demo (organizational labels, optional
   * realm role mappings on groups).
   */
  groups?: AuthorizationGroupNode[];

  /** v2 dev test users. */
  users?: AuthorizationUser[];
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
