// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
export interface LocalizedText {
  en?: string;
  nl?: string;
  fr?: string;
}

export interface ValidationRule {
  value: number | string | boolean;
  message?: LocalizedText;
}

export interface FieldValidation {
  required?: boolean | ValidationRule;
  minLength?: number | ValidationRule;
  maxLength?: number | ValidationRule;
  minItems?: number | ValidationRule;
  uniqueBy?: string;
  min?: number | ValidationRule;
  max?: number | ValidationRule;
  pattern?: string | ValidationRule;
  format?: string;
  /**
   * Fields that must hold a value whenever this one does — an invoice number
   * without the fiscal year that scopes it is no identity. Persisted as a
   * database CHECK on the row, so no write path can leave the pair half set.
   */
  requires?: string[];
  custom?: {
    name: string;
    message?: LocalizedText;
    params?: Record<string, unknown>;
  }[];
}

export interface FieldReference {
  kind: string;
  group: string;
}

export interface FieldPersisted {
  column: string;
  storageClass: "core" | "profile";
}

export interface FieldRender {
  component: string;
  props?: Record<string, unknown>;
}

export interface FieldPermissions {
  read?: string[];
  write?: string[];
}

export interface EntityPermissions {
  read?: string[];
  create?: string[];
  update?: string[];
  delete?: string[];
}

export interface AuthorizationRoles {
  read: string[];
  create?: string[];
  update?: string[];
  delete?: string[];
}

export interface FieldAuthorizationRoles {
  read?: string[];
  write?: string[];
}

export interface RowAccessOwnerConfig {
  /** Persisted column (snake_case) on this entity holding the owner identifier. */
  column: string;
  /** Postgres session variable from which to read the current user's owner id. */
  session: string;
}

export interface RowAccessGroupConfig {
  /** Persisted uuid column (or belongsTo foreignKey) holding the owning org-unit id. */
  column: string;
  /**
   * How the user's directly-bound org units expand against the closure at
   * session setup. Metadata for the session-setup resolver, not the policy.
   * (Phase 2 wires the group axis end-to-end; Phase 1 only carries the type.)
   */
  expand?: "descendants" | "ancestors" | "exact";
}

export type RecordPermissionAction = "view" | "edit" | "delete";

/**
 * Action-specific subjects stored on each record.
 *
 * The persisted JSON object has fixed `view`, `edit`, and `delete` members;
 * each member contains `users`, `groups`, and `roles` string arrays. Keeping
 * that shape fixed lets the database policy and every Operation adapter use
 * one parser instead of letting each entity invent an authorization dialect.
 */
/** Principal kinds a named record action may be granted to. */
export type RecordActionPrincipal = "person" | "integration";

/**
 * One named action the record ACL may grant, declared by the entity.
 *
 * The axis is opt-in per entity and per action, which is what keeps it from
 * regressing any existing policy: an entity that declares nothing can carry
 * no action, and an action that does not admit `integration` can never be
 * granted to an application. The name is the key under the stored ACL's
 * `actions` member and the value an Operation's `auth.recordAction` names.
 */
export interface RowAccessRecordActionConfig {
  /** lowerCamel identifier; never view, edit or delete. */
  name: RecordActionName;
  /**
   * What a person reading a screen calls this action.
   *
   * The entity that declares an action is the only honest place to name it:
   * core knows the axis, not a product's vocabulary. Optional, so an action
   * authored before this existed keeps compiling — a reader of this field
   * falls back to the action NAME, which is the one label that is always
   * available and never invented.
   */
  labels?: LocalizedText;
  /** Which principal kinds a grant of this action may name. */
  principals: RecordActionPrincipal[];
  /**
   * The ONLY fields a holder of this action may read from the record, as
   * authored field keys.
   *
   * Holding an action does not make the record readable — that is the point of
   * the axis — but an action that cannot read anything cannot be carried out
   * either. This list is the entity's explicit answer to "what does executing
   * this need to see": core reads exactly these columns of exactly that row,
   * through the same owner-scoped lookup that authorized the action, and
   * returns nothing else. The ACL field, a classified field, a computed or
   * localized field and anything unpersisted are refused at compile time, so
   * the projection cannot become a way to reach a draft, a document body or
   * another record.
   *
   * Omitted or empty means the action authorizes an effect and discloses
   * nothing, which is the correct shape for an action whose input the caller
   * already supplies.
   */
  reads?: string[];
  /**
   * How strongly the authorization check locks the record's ACL row.
   *
   * The check and the effect run in one transaction, and the check takes the
   * lock first. That ordering is what fences a concurrent policy change — a
   * revocation waits for an effect in flight, and a check that starts after a
   * revocation waits and then reads it — and both modes below keep it.
   *
   * What differs is how two holders of the SAME action on the SAME record
   * behave:
   *
   *   exclusive  (default) a self-exclusive lock. The second holder waits at
   *              the check until the first commits. An effect that later takes
   *              a row-exclusive lock on the same record is then safe, because
   *              only one holder is ever positioned to upgrade.
   *   shared     both holders pass the check together. Correct for an action
   *              whose effect only reads — and a DEADLOCK if that effect then
   *              locks the same record more strongly, since each holder waits
   *              for a shared lock the other will not release until it has
   *              upgraded. PostgreSQL detects it and aborts one transaction.
   *
   * So `shared` is a throughput choice for a provably read-only effect, and
   * the compiler cannot verify that claim: an effect's SQL is not in scope
   * here. The default is the mode that cannot deadlock.
   */
  lock?: RecordActionLock;
}

export type RecordActionLock = "exclusive" | "shared";

export type RecordActionName = string;

export interface RowAccessRecordPermissionsConfig {
  /** Authored field key for the persisted single jsonb object. */
  field: string;
  /** A valid subject set naming nobody is public or restricted as authored. */
  empty: "public" | "restricted";
  /** Permissions the creator must hold in the submitted ACL. */
  createRequires: RecordPermissionAction[];
  /**
   * Named actions this record ACL may grant, independently of view/edit/delete.
   * Absent on every entity that did not opt in.
   */
  actions?: RowAccessRecordActionConfig[];
}

export interface RowAccessConfig {
  enabled: boolean;
  empty?: "public" | "restricted";
  owner?: RowAccessOwnerConfig;
  /** Group-predicated axis. Phase 2 fills this; Phase 1 only carries the type. */
  group?: RowAccessGroupConfig;
  /** Optional action-specific record ACL, composed with tenant/owner/group RLS. */
  recordPermissions?: RowAccessRecordPermissionsConfig;
}

/**
 * Owner-axis read policy: the rows an owning reference carries are readable
 * with the owner entity's read roles; a command marks its transaction to
 * read every owner's rows. See docs/document-content.md.
 */
export interface OwnerAxisConfig {
  fields: string[];
  command?: { setting: string; values: string[] };
}

/**
 * What the SERVER decided a session is. Not a role, not a scope, not anything
 * a caller states: `person` is a verified human identity, `application` a
 * resolved API-key integration, `service` a verified client-credentials
 * principal with no integration behind it (configured organization automation
 * included), and `unknown` a carrier the server could not classify.
 */
export type EntityPrincipalClass = "person" | "application" | "service" | "unknown";

export interface AuthorizationConfig {
  roles: AuthorizationRoles;
  rowAccess?: RowAccessConfig;
  ownerAxis?: OwnerAxisConfig;
  /**
   * Which principal classes this entity's GENERATED CRUD and the search
   * derived from it admit. A role list says what a session may do; this says
   * what KIND of session may use the generic routes at all — which a role
   * list cannot express, because a service account and the person beside it
   * can hold the very same role.
   *
   * Omitted admits every class, which is what every entity did before this
   * existed. The one exception is derived rather than authored: an entity that
   * declares a named record action for `integration` principals excludes
   * `application` unless it says otherwise. An application reaches such an
   * entity through the grants on individual records, so admitting it to the
   * collection as well would hand a key with a broad role every record of the
   * entity and make the per-record grant decorative. Writing the list out
   * re-admits it deliberately.
   */
  principalClasses?: EntityPrincipalClass[];
}

export interface FieldAuthorizationConfig {
  roles: FieldAuthorizationRoles;
}

export interface ProfileAuthorizationConfig {
  roles: {
    read?: string[];
  };
}

export interface VisibilityCondition {
  field: string;
  operator: "eq" | "neq" | "in" | "notIn" | "gt" | "lt" | "gte" | "lte" | "isEmpty" | "isNotEmpty";
  value?: unknown;
}

export interface VisibilityConfig {
  conditions: VisibilityCondition[];
  logic?: "and" | "or";
}

export type ComputedField =
  | { expression: string; dependencies: string[] }
  | { kind: "temporalThreshold"; field: string; thresholdDays: string };

export interface FieldOptionStatic {
  value: string;
  label: LocalizedText;
  /** Icon key shown with the option, e.g. on a tile; the host resolves it. */
  icon?: string;
}

export interface FieldOptions {
  parameters?: Record<string, string | number | boolean>;
  bindings?: Record<string, string>;

  type: "static" | "referentiedata" | "remote" | "dynamic" | "entity";
  items?: FieldOptionStatic[];
  /** `tiles` renders static options as icon tiles instead of a select. */
  presentation?: "tiles";
  source?: string;
  referentieGroep?: string;
  remoteUrl?: string;
  valueField?: string;
  labelField?: string;
}

export interface OsfTypeLookupDefinition {
  provider: string;
  remoteUrl?: string;
  searchParam?: string;
  filters?: Record<string, string | number | boolean>;
}

export interface DataClassification {
  sensitivity: "public" | "internal" | "confidential" | "pii" | "bsn";
  category?: string;
}

export interface RetentionPolicy {
  title?: LocalizedText;
  mode?: "inline" | "policyRef" | "fieldOverride";
  policy?: string;
  scope?: "record" | "field";
  inherit?: "entity" | "dossier" | "none";
  jurisdiction?: string;
  legalBasis?: {
    type?: "statutory_obligation" | "contract" | "legitimate_interest" | "consent" | "public_task" | "other";
    reference?: string;
  };
  duration?: string | {
    minimum?: string;
    maximum?: string;
    default?: string;
  };
  startsFrom?: {
    strategy?: "createdAt" | "updatedAt" | "field" | "firstNonNull";
    field?: string;
    fields?: string[];
  };
  disposition?: {
    action?: "keep" | "archive" | "delete" | "anonymize" | "mask" | "review" | "cryptoDelete";
    review?: boolean | {
      required?: boolean;
      queue?: string;
    };
    cryptoDelete?: {
      keyReference: string;
    };
  };
  holds?: {
    suspendDestruction?: boolean;
    /** Boolean entity field whose true value means a hold is active. */
    activeField?: string;
  };
  tenantOverride?: {
    allowExtension?: boolean;
    allowShortening?: boolean;
  };
  reason?: LocalizedText;
}

export interface ContextHints {
  aiInstructions?: string;
  sourceHint?: string;
  requirements?: string;
}

export interface HookEntry {
  handler: string;
  failMessage?: LocalizedText;
}

export interface EntityHooks {
  beforeCreate?: HookEntry[];
  afterCreate?: HookEntry[];
  beforeUpdate?: HookEntry[];
  afterUpdate?: HookEntry[];
  beforeDelete?: HookEntry[];
  afterDelete?: HookEntry[];
}

export interface ItemAction {
  type: "open";
  target: "page" | "sheet" | "modal" | "none";
  view?: string;
}

/**
 * Canonical action definition — single source of truth for all action shapes
 * across the platform: view actions, workflow awaitAction/userInput nodes,
 * and formDefinition action bars.
 *
 * When this interface changes, all downstream consumers automatically align
 * because they extend or import from here.
 */
export interface ActionDefinition {
  key: string;
  label?: LocalizedText;
  description?: LocalizedText;
  tone?: "primary" | "default" | "destructive";
  icon?: string;
  visibleWhen?: VisibilityConfig;
  disabledWhen?: VisibilityConfig;
  disabledMessage?: LocalizedText;
  /** Optional per-action form fields shown in a modal before triggering: the one authored field contract. */
  formFields?: import("./field-definition.js").FieldDefinition[];
}

/**
 * View-level action: extends ActionDefinition with navigation/mutation behaviour
 * specific to UI views (list, detail, form, etc.).
 * `actionRef` is view-only — workflow actions are always self-contained.
 */
export interface ViewAction extends ActionDefinition {
  /** Reference to a top-level ViewActionDefinition. Resolved at compile time. */
  actionRef?: string;
  route?: string;
  mutation?: string;
  targetRef?: string;
  surface?: "modal" | "sheet" | "inline";
  inputRef?: string;
  payload?: Record<string, string | number | boolean>;
  confirm?: LocalizedText;
}

/**
 * Named reusable action definition — referenced by ViewAction.actionRef.
 * Does not carry visibleWhen/disabledWhen (those belong on the usage site).
 */
export interface ViewActionDefinition {
  label?: LocalizedText;
  icon?: string;
  route?: string;
  mutation?: string;
  targetRef?: string;
  surface?: "modal" | "sheet" | "inline";
  inputRef?: string;
  payload?: Record<string, string | number | boolean>;
  confirm?: LocalizedText;
  tone?: "primary" | "default" | "destructive";
}

export interface ViewRowAction extends ActionDefinition {
  /** Row actions always resolve via a named definition. */
  actionRef: string;
  payload?: Record<string, string | number | boolean>;
  confirm?: LocalizedText;
}
