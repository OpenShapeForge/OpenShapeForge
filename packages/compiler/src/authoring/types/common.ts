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
  min?: number | ValidationRule;
  max?: number | ValidationRule;
  pattern?: string | ValidationRule;
  format?: string;
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

export interface RowAccessConfig {
  enabled: boolean;
  empty?: "public" | "restricted";
  owner?: RowAccessOwnerConfig;
  /** Group-predicated axis. Phase 2 fills this; Phase 1 only carries the type. */
  group?: RowAccessGroupConfig;
}

export interface AuthorizationConfig {
  roles: AuthorizationRoles;
  rowAccess?: RowAccessConfig;
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

export interface ComputedField {
  expression: string;
  dependencies: string[];
}

export interface FieldOptionStatic {
  value: string;
  label: LocalizedText;
}

export interface FieldOptions {
  type: "static" | "referentiedata" | "remote" | "dynamic";
  items?: FieldOptionStatic[];
  source?: string;
  referentieGroep?: string;
  remoteUrl?: string;
  valueField?: string;
  labelField?: string;
}

export interface SemanticTypeLookupDefinition {
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
  };
  holds?: {
    suspendDestruction?: boolean;
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
 * Canonical form field definition — used in userInput and per-action formFields.
 * Single source of truth shared across compiler, workflow service, and web client.
 */
export interface FormFieldDefinition {
  key: string;
  valueType: string;
  cardinality?: "single" | "collection";
  semanticType?: string;
  label: LocalizedText;
  required?: boolean;
  description?: LocalizedText | null;
  options?: Record<string, unknown>;
  render?: Record<string, unknown>;
  validation?: Record<string, unknown>;
  children?: FormFieldDefinition[];
  item?: FormFieldDefinition;
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
  /** Optional per-action form fields shown in a modal before triggering. */
  formFields?: FormFieldDefinition[];
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
