// @ts-nocheck
import type {
  LocalizedText,
  FieldValidation,
  SemanticTypeLookupDefinition,
  FieldReference,
  FieldPersisted,
  FieldRender,
  FieldPermissions,
  EntityPermissions,
  VisibilityConfig,
  ComputedField,
  FieldOptions,
  DataClassification,
  RetentionPolicy,
  ContextHints,
  EntityHooks,
  AuthorizationConfig,
  FieldAuthorizationConfig,
  ProfileAuthorizationConfig,
} from "./common.js";
import type { Relationship, UIDefinition } from "./views.js";

export interface Field {
  key: string;
  valueType: "string" | "integer" | "number" | "boolean" | "date" | "datetime" | "object";
  cardinality?: FieldCardinality;
  variables?: "none" | "whole" | "template" | "both";
  sortable?: boolean;
  required?: boolean;
  readOnly?: boolean;
  label?: LocalizedText;
  description?: LocalizedText;
  placeholder?: LocalizedText;
  help?: LocalizedText;
  semanticType?: string;
  unit?: string;
  currency?: string;
  value?: unknown;
  defaultValue?: unknown;
  validation?: FieldValidation;
  relationship?: FieldRelationship;
  visibility?: VisibilityConfig;
  computed?: ComputedField;
  /**
   * Escape hatch to override the emitted GraphQL type for a non-persisted
   * field. When set, the GraphQL codegen skips the default `FIELD_TO_GQL_TYPE`
   * mapping and wires a runtime resolver (e.g. `ctx.labelService.resolve`)
   * that returns a value shaped like this type. Use together with an absent
   * `persisted` block so storage compilation skips the field.
   */
  graphqlType?: string;
  options?: FieldOptions;
  persisted?: FieldPersisted;
  render?: FieldRender;
  permissions?: FieldPermissions;
  authorization?: FieldAuthorizationConfig;
  classification?: DataClassification;
  retention?: RetentionPolicy;
  audit?: boolean;
  hints?: ContextHints;
  suggestions?: FieldSuggestions;
  runtime?: FieldRuntimeMetadata;
  workflowInspector?: FieldWorkflowInspector;
  layoutFraction?: number;
  /**
   * When `true`, the field's *value* is `LocalizedText`-shaped
   * (`{ nl?, en?, fr? }`) and the renderer scopes reads/writes to the active
   * `ctx.lang`. Use for any scalar leaf whose content needs to differ per
   * language (labels, descriptions, button text, …).
   */
  localized?: boolean;
  shape?: Field[];
  authoring?: FieldAuthoringMetadata;
  children?: Field[];
  item?: Field;
}

export type FieldCardinality =
  | "single"
  | "collection"
  | {
      min?: number;
      max?: number | "unbounded";
    };

export interface FieldAuthoringMetadata {
  profile?: string;
  pinned?: boolean;
  locked?: boolean;
  singleton?: boolean;
  visibleProperties?: string[];
}

export interface FieldSuggestions {
  /** Key of a sibling field whose value determines the available variable suggestions. */
  sourceField?: string;
  /**
   * WEB-020 — Key of a form-level `FormVariableSource` the field opts into for
   * its `$`-triggered variable picker. Replaces the per-field `sourceField`
   * indirection for forms that declare their own variable sources.
   */
  sourceKey?: string;
}

export interface FieldRelationship {
  kind: "belongsTo" | "hasMany";
  entity: string;
  foreignKey?: string;
  displayField?: string;
}

export interface FieldRuntimeMetadata {
  aliases?: string[];
  required?: boolean;
}

export interface FieldWorkflowInspector {
  objectPresentation?: "inlineChildren";
  displayMode?: "hidden" | "display" | "readOnly";
}

export interface ComponentDefinition {
  kind: "view" | "field" | "relationship" | "custom";
  description: string;
  props: string[];
}

export interface ComponentCatalog {
  schemaVersion: number;
  kind: "componentCatalog";
  defaults: Record<string, { label?: LocalizedText; component: string; readOnly?: boolean }>;
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
  valueType: "string" | "integer" | "number" | "boolean" | "date" | "datetime" | "object";
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
  workflow?: {
    nodes?: {
      actions?: {
        create?:
        | boolean
        | { enabled?: boolean; readableFields?: string[]; writableFields?: string[] };
        getOne?:
        | boolean
        | { enabled?: boolean; readableFields?: string[]; writableFields?: string[] };
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
        | { enabled?: boolean; readableFields?: string[]; writableFields?: string[] };
        delete?:
        | boolean
        | { enabled?: boolean; readableFields?: string[]; writableFields?: string[] };
        wait?:
        | boolean
        | { enabled?: boolean; readableFields?: string[]; writableFields?: string[] };
        awaitAction?:
        | boolean
        | { enabled?: boolean; readableFields?: string[]; writableFields?: string[] };
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
  workflow?: {
    nodes?: {
      actions?: Partial<Record<
        "create" | "getOne" | "list" | "update" | "delete" | "wait" | "awaitAction",
        | boolean
        | {
          enabled?: boolean;
          readableFields?: string[];
          writableFields?: string[];
        }
      >>;
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
  secret?: string;
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
