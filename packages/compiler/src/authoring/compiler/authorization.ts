// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
/**
 * Authorization sub-compiler — transforms YAML authorization declarations into
 * compiled authorization metadata.
 *
 * Pipeline position: called after model compilation so compiled fields (with
 * resolved classification from semantic types) are available for field-level
 * role collection.
 *
 * Design rules (post-cleanup):
 *
 *   1. Entity YAMLs are authoritative for which roles authorize which
 *      operations. They reference role names from the team's existing realm
 *      vocabulary (defined in packages/compiler/config/authoring/authorization.yaml).
 *
 *   2. The compiler does NOT invent role names. Every entity must list at least
 *      one role per CRUD op explicitly — there are no `${slug}:read` fallbacks.
 *      This enforces the "block everything without defined" rule end-to-end.
 *
 *   3. The slug stays as an internal identifier (`entitySlug` on the runtime
 *      artifact). It does not appear as a granted role anywhere.
 *
 *   4. Validation against `authorization.yaml` happens in a separate pass
 *      (see authorization-validation.ts) so this module stays a pure
 *      transform.
 *
 * Input:  CoreEntity, EntityProfile[], CompiledField[]
 * Output: CompiledAuthorization | undefined (undefined when entity has no
 *         authorization block)
 */
import type { CoreEntity, EntityProfile } from "../types/authoring.js";
import type {
  CompiledField,
  CompiledAuthorization,
  CompiledAuthorizationRole,
  CompiledFieldAuthorization,
} from "../types/compiled.js";
import { fieldSqlType, isCollectionField } from "./helpers.js";
import { buildCrud } from "./crud.js";

const OWNER_SESSIONS = new Set(["app.current_user_id", "app.current_relation_id"]);

/**
 * Derive a kebab-case slug from a PascalCase entity name. Used internally as
 * the artifact key — never as a granted role name.
 *
 * e.g. "NaturalPerson" → "natural-person"
 */
export function toEntitySlug(entityName: string): string {
  return entityName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export class AuthorizationCompileError extends Error {
  constructor(
    public readonly entityName: string,
    message: string,
  ) {
    super(`[${entityName}] ${message}`);
    this.name = "AuthorizationCompileError";
  }
}

export function buildAuthorization(
  coreEntity: CoreEntity,
  profiles: EntityProfile[],
  compiledFields: CompiledField[],
): CompiledAuthorization {
  if (!coreEntity.authorization) {
    throw new AuthorizationCompileError(
      coreEntity.entity,
      `entity YAML has no \`authorization:\` block. Every entity must declare ` +
        `read/create/update/delete role lists explicitly — entities without an ` +
        `authorization block are denied at runtime by the Pothos auth-guard ` +
        `(fail-closed). Add an \`authorization:\` section referencing existing ` +
        `roles from authorization.yaml (e.g. Algemeen.All.ReadWrite).`,
    );
  }

  const slug = toEntitySlug(coreEntity.entity);
  const authConfig = coreEntity.authorization;

  // Only exposed mutations need entity CRUD grants. Value definitions expose
  // plugin Operations with their own auth, not fictional standalone CRUD.
  const enabled = buildCrud(coreEntity).operations;
  const ops: Array<"read" | "create" | "update" | "delete"> = [
    "read",
    "create",
    "update",
    "delete",
  ];
  for (const op of ops) {
    if (coreEntity.schemaVersion >= 2 && op !== "read" && !enabled[op]) continue;
    const roles = authConfig.roles?.[op];
    if (!roles || roles.length === 0) {
      throw new AuthorizationCompileError(
        coreEntity.entity,
        `authorization.roles.${op} must be present and list at least one role. ` +
          `Add an explicit role from authorization.yaml (e.g. Relaties.All.Read). ` +
          `Fail-closed: entities without explicit role lists are denied at runtime.`,
      );
    }
  }

  const roles = {
    read: authConfig.roles.read,
    create: authConfig.roles.create ?? [],
    update: authConfig.roles.update ?? [],
    delete: authConfig.roles.delete ?? [],
  };

  // Field-level authorizations — explicit only. Every field-level role must
  // be referenced by name from the realm vocabulary. We no longer auto-derive
  // a `${slug}:field:${field.key}:read` role from `classification.sensitivity`
  // — that synthesized a role nobody could be granted because it didn't exist
  // in authorization.yaml. If a sensitive field needs gating, the YAML must
  // declare which existing role authorizes it (e.g. `Relaties.Bsn.Read`).
  const fieldAuthorizations: CompiledFieldAuthorization[] = [];
  collectFieldAuthorizations(compiledFields, fieldAuthorizations);

  for (const profile of profiles) {
    if (!profile.fields) continue;
    for (const field of profile.fields) {
      if (field.authorization) {
        fieldAuthorizations.push({
          fieldKey: field.key,
          readRoles: field.authorization.roles.read ?? [],
          writeRoles: field.authorization.roles.write ?? [],
        });
      }
    }
  }

  // Profile-level authorization
  const profileAuthorizations: Record<string, { readRoles: string[] }> = {};
  for (const profile of profiles) {
    if (profile.authorization?.roles?.read) {
      profileAuthorizations[profile.profile] = {
        readRoles: profile.authorization.roles.read,
      };
    }
  }

  // Composite roles — empty by design. The previous implementation emitted
  // `${slug}:manage`, `${slug}:full`, `${slug}:pii` composites. Nothing in the
  // realm or runtime granted or checked them; they were dead weight in the
  // realm export. The CompiledAuthorization shape keeps the field for
  // forward compatibility but we no longer populate it.
  const compositeRoles: CompiledAuthorizationRole[] = [];

  // Row-level access config.
  //   - No owner/group axis: plain tenant scoping. `empty` carries the
  //     public/restricted intent (validated downstream in the backend manifest;
  //     `empty: restricted` with no axis is a fail-closed error there).
  //   - owner-predicated: rows filtered by `"<column>" = app.current_user_id()`
  //     when an `owner` block is declared.
  //   - group-predicated: rows filtered by `"<column>" = ANY(<groups-fn>())`
  //     (org-unit hierarchy) when a `group` block is declared. `expand` selects
  //     the reader function (descendants|ancestors|exact) — Phase 2.
  //   - owner and group are independently combinable on one entity (both emit
  //     OR-branches downstream).
  // `empty` is honored as authored: `public` keeps NULL-column rows visible via
  // an OR-NULL branch, `restricted` hides them. The default is `public` when an
  // axis is present, `restricted` otherwise (guarded downstream).
  let rowAccess: CompiledAuthorization["rowAccess"];
  if (authConfig.rowAccess?.enabled) {
    const owner = authConfig.rowAccess.owner;
    const group = authConfig.rowAccess.group;
    const recordPermissions = authConfig.rowAccess.recordPermissions;

    // We look up against the raw authoring `Field[]` (core + profile) rather
    // than `compiledFields`, because `CompiledField` does not carry
    // `persisted` — that data is consumed by the storage compiler from the
    // authoring layer directly.
    const allAuthoringFields = [
      ...(coreEntity.fields ?? []),
      ...profiles.flatMap((p) => p.fields ?? []),
    ];

    // Shared column-existence validation for owner and group axes. Two valid
    // sources, in this order:
    //   1. An explicit field with persisted.column === col (uuid type)
    //   2. A belongsTo relationship's foreignKey === col (foreign-key columns
    //      are auto-emitted as uuid by the storage compiler; we accept them so
    //      authors don't declare an explicit field shadowing the relationship).
    // Catches typos and stops generation before SQL emits a broken policy.
    const validateAxisColumn = (col: string, axis: "owner" | "group") => {
      // Strict identifier allowlist BEFORE any downstream SQL emission. The
      // owner/group column is emitted verbatim into RLS predicates via
      // quoteIdent(); reject anything outside plain lowercase snake_case so a
      // hostile name cannot inject into or restructure the row-security policy.
      if (!/^[a-z_][a-z0-9_]*$/.test(col)) {
        throw new AuthorizationCompileError(
          coreEntity.entity,
          `authorization.rowAccess.${axis}.column "${col}" is not a valid column identifier — ` +
            `it must match /^[a-z_][a-z0-9_]*$/ (lowercase letters, digits, and underscores; not starting with a digit). ` +
            `This value is emitted into generated RLS policies and cannot contain other characters.`,
        );
      }
      const persistedField = allAuthoringFields.find(
        (f) => f.persisted?.column === col,
      );
      const matchingRelationship = allAuthoringFields.find((field) => field.persisted?.column === col &&
        field.relationship?.kind === "belongsTo" && field.relationship.target &&
        fieldSqlType(field) === "uuid")?.relationship;
      if (!persistedField && !matchingRelationship) {
        throw new AuthorizationCompileError(
          coreEntity.entity,
          `authorization.rowAccess.${axis}.column "${col}" does not match any persisted field or belongsTo foreignKey on this entity. ` +
            `The ${axis} column must reference either a uuid field's 'persisted.column' or a relationship's 'foreignKey'.`,
        );
      }
      // Session ownership is a subject UUID, not necessarily an entity FK.
      // Reuse the storage compiler's canonical UUID-format lowering. A plain
      // string or a UUID collection is still rejected (text/jsonb storage).
      // Group axes retain their relationship-only contract.
      const scalarSessionOwner = axis === "owner" && persistedField &&
        fieldSqlType(persistedField) === "uuid";
      if (persistedField && !scalarSessionOwner && !(matchingRelationship && fieldSqlType(persistedField) === "uuid")) {
        throw new AuthorizationCompileError(
          coreEntity.entity,
          `authorization.rowAccess.${axis}.column "${col}" must reference a belongsTo foreignKey (auto-emitted as uuid) — ` +
            `the persisted field "${col}" has baseType "${persistedField.baseType}". ` +
            (axis === "owner"
              ? "A session owner may instead be a scalar string with validation.format: uuid."
              : "Model the group as a belongsTo relationship."),
        );
      }
      // Relationship FKs are always uuid (storage compiler invariant), no type
      // check needed when matchingRelationship is the source.
    };

    if (owner) {
      validateAxisColumn(owner.column, "owner");
      // The owner axis compares against one of the two identities the
      // runtime writes per session (applyDbSession): the login
      // (`app.current_user_id`, rowScope.userColumns) or the Relation it acts
      // as (`app.current_relation_id`, rowScope.relationColumns) — the owner
      // of a person-owned record. No other session var is ever populated, so
      // anything else would compile to a dead policy.
      if (!OWNER_SESSIONS.has(owner.session)) {
        throw new AuthorizationCompileError(
          coreEntity.entity,
          `authorization.rowAccess.owner.session must be "app.current_user_id" or "app.current_relation_id" — the runtime only exposes those session identities.`,
        );
      }
    }
    if (group) {
      validateAxisColumn(group.column, "group");
    }

    let compiledRecordPermissions:
      | NonNullable<CompiledAuthorization["rowAccess"]>["recordPermissions"]
      | undefined;
    if (recordPermissions) {
      const field = allAuthoringFields.find((candidate) =>
        candidate.key === recordPermissions.field
      );
      if (!field) {
        throw new AuthorizationCompileError(
          coreEntity.entity,
          `authorization.rowAccess.recordPermissions.field "${recordPermissions.field}" does not match an entity field.`,
        );
      }
      if (
        field.baseType !== "object" ||
        isCollectionField(field) ||
        field.required !== true ||
        !field.persisted?.column
      ) {
        throw new AuthorizationCompileError(
          coreEntity.entity,
          `authorization.rowAccess.recordPermissions.field "${recordPermissions.field}" must be a required, persisted, single object field.`,
        );
      }
      if (!/^[a-z_][a-z0-9_]*$/.test(field.persisted.column)) {
        throw new AuthorizationCompileError(
          coreEntity.entity,
          `authorization.rowAccess.recordPermissions field column "${field.persisted.column}" is not a valid column identifier.`,
        );
      }
      if (
        field.defaultValue !== undefined &&
        !isValidRecordPermissionsDocument(field.defaultValue)
      ) {
        throw new AuthorizationCompileError(
          coreEntity.entity,
          `authorization.rowAccess.recordPermissions field "${recordPermissions.field}" has a malformed defaultValue. ` +
            `Use an object with optional view/edit/delete members whose users/groups/roles values are arrays of non-empty strings.`,
        );
      }
      const actions = compileRecordActions(
        coreEntity, recordPermissions.actions, allAuthoringFields, recordPermissions.field,
      );
      if (
        field.defaultValue !== undefined &&
        !defaultRecordActionsAreDeclared(field.defaultValue, actions)
      ) {
        throw new AuthorizationCompileError(
          coreEntity.entity,
          `authorization.rowAccess.recordPermissions field "${recordPermissions.field}" has a defaultValue ` +
            `granting an action this entity does not declare, or naming a principal kind that action does not admit. ` +
            `Declare the action under authorization.rowAccess.recordPermissions.actions first.`,
        );
      }
      compiledRecordPermissions = {
        field: recordPermissions.field,
        column: field.persisted.column,
        empty: recordPermissions.empty,
        createRequires: [...recordPermissions.createRequires],
        ...(actions.length > 0 ? { actions } : {}),
        ...(field.defaultValue !== undefined
          ? { defaultValue: structuredClone(field.defaultValue) as Record<string, unknown> }
          : {}),
      };
    }

    if (owner || group || compiledRecordPermissions) {
      rowAccess = {
        enabled: true,
        // Honor the authored `empty` (default public when an axis is present).
        // `public` keeps NULL-column rows visible via the emitter's OR-NULL
        // branch; `restricted` hides them.
        empty: (authConfig.rowAccess.empty ?? "public") as "public" | "restricted",
        ...(owner ? { owner: { column: owner.column, session: owner.session } } : {}),
        ...(group
          ? {
              group: {
                column: group.column,
                // Default expand mode is descendants (matches the schema).
                expand: (group.expand ?? "descendants") as
                  | "descendants"
                  | "ancestors"
                  | "exact",
              },
            }
          : {}),
        ...(compiledRecordPermissions
          ? { recordPermissions: compiledRecordPermissions }
          : {}),
      };
    } else {
      rowAccess = {
        enabled: true,
        empty: (authConfig.rowAccess.empty ?? "restricted") as "public" | "restricted",
      };
    }
  } else {
    rowAccess = undefined;
  }

  let ownerAxis: CompiledAuthorization["ownerAxis"];
  if (authConfig.ownerAxis) {
    for (const key of authConfig.ownerAxis.fields) {
      // Ownership is the derived inverse collection's; the backend manifest checks it once the target is known.
      const field = coreEntity.fields.find((candidate) => candidate.key === key);
      if (!field?.relationship || field.relationship.kind !== "belongsTo" || isCollectionField(field) || field.required) {
        throw new AuthorizationCompileError(
          coreEntity.entity,
          `authorization.ownerAxis.fields "${key}" must be an optional single entity reference.`,
        );
      }
    }
    ownerAxis = {
      fields: [...authConfig.ownerAxis.fields],
      ...(authConfig.ownerAxis.command
        ? { command: { setting: authConfig.ownerAxis.command.setting, values: [...authConfig.ownerAxis.command.values] } }
        : {}),
    };
  }

  const principalClasses = compilePrincipalClasses(
    coreEntity,
    authConfig.principalClasses,
    compiledRecordActionsFor(rowAccess),
  );

  return {
    entitySlug: slug,
    roles,
    compositeRoles,
    fieldAuthorizations,
    profileAuthorizations,
    rowAccess,
    ...(ownerAxis ? { ownerAxis } : {}),
    ...(principalClasses ? { principalClasses } : {}),
  };
}

const PRINCIPAL_CLASSES = ["application", "person", "service", "unknown"] as const;

function compiledRecordActionsFor(
  rowAccess: CompiledAuthorization["rowAccess"],
): ReadonlyArray<{ principals: string[] }> {
  return rowAccess?.recordPermissions?.actions ?? [];
}

/**
 * Which principal classes may use this entity's generated CRUD and the search
 * derived from it.
 *
 * An authored list is taken as written, after validation. What is NOT authored
 * is the interesting part:
 *
 *   - an entity with no record action compiles to `undefined`: every class is
 *     admitted, exactly as before this axis existed. 117 entities keep
 *     byte-identical output;
 *   - an entity that declares an action for `integration` principals compiles
 *     to every class EXCEPT `application`. Such an entity has decided that an
 *     application reaches it one record at a time, by grant. Leaving the
 *     collection, the record read and the derived search open to any key whose
 *     service account happens to hold the entity's role would hand it every
 *     record of the entity and make the per-record grant decorative. The
 *     default closes that without the entity having to remember to.
 *
 * Re-admitting `application` is a deliberate authored list, which is the
 * point: it is a decision with a reviewer, not an omission.
 */
function compilePrincipalClasses(
  coreEntity: CoreEntity,
  authored: import("../types/common.js").EntityPrincipalClass[] | undefined,
  actions: ReadonlyArray<{ principals: string[] }>,
): import("../types/common.js").EntityPrincipalClass[] | undefined {
  if (authored !== undefined) {
    const classes = [...new Set(authored)];
    if (classes.length === 0 ||
      classes.some((candidate) => !PRINCIPAL_CLASSES.includes(candidate as never))) {
      throw new AuthorizationCompileError(
        coreEntity.entity,
        `authorization.principalClasses must list at least one of ${PRINCIPAL_CLASSES.join(", ")}. ` +
          `An empty list would deny every session, which is spelled by disabling the entity's ` +
          `generated CRUD rather than by an unsatisfiable principal policy.`,
      );
    }
    return classes.sort();
  }
  const admitsApplications = actions.some((action) => action.principals.includes("integration"));
  if (!admitsApplications) return undefined;
  return PRINCIPAL_CLASSES.filter((candidate) => candidate !== "application");
}

const RECORD_ACTION_NAME = /^[a-z][A-Za-z0-9]*$/;
const RECORD_PERMISSIONS = ["view", "edit", "delete"];

/**
 * Validate and normalize the entity's declared record actions.
 *
 * Must agree with the authoring schema, `app.record_permissions_valid` and
 * the API's parser: a name is a lowerCamel identifier that never restates a
 * record permission, and an action admits at least one principal kind. The
 * compiler is where a typo becomes a build failure rather than a grant
 * nothing ever honours.
 */
function compileRecordActions(
  coreEntity: CoreEntity,
  authored: import("../types/common.js").RowAccessRecordActionConfig[] | undefined,
  fields: ReadonlyArray<Record<string, unknown>>,
  aclField: string,
): import("../types/common.js").RowAccessRecordActionConfig[] {
  if (!authored || authored.length === 0) return [];
  const seen = new Set<string>();
  return authored.map((action) => {
    if (typeof action?.name !== "string" || !RECORD_ACTION_NAME.test(action.name) ||
      RECORD_PERMISSIONS.includes(action.name)) {
      throw new AuthorizationCompileError(
        coreEntity.entity,
        `authorization.rowAccess.recordPermissions.actions name ${JSON.stringify(action?.name)} must be a ` +
          `lowerCamel identifier matching /^[a-z][A-Za-z0-9]*$/ and must not be view, edit or delete — ` +
          `the named-action axis is independent of the record permissions and may not shadow one.`,
      );
    }
    if (seen.has(action.name)) {
      throw new AuthorizationCompileError(
        coreEntity.entity,
        `authorization.rowAccess.recordPermissions.actions declares "${action.name}" twice.`,
      );
    }
    seen.add(action.name);
    const principals = [...new Set(action.principals ?? [])];
    if (principals.length === 0 ||
      principals.some((principal) => principal !== "person" && principal !== "integration")) {
      throw new AuthorizationCompileError(
        coreEntity.entity,
        `authorization.rowAccess.recordPermissions.actions "${action.name}" must declare at least one of ` +
          `"person" or "integration" in principals. An action nobody may be granted is a dead policy, ` +
          `and an undeclared principal kind is refused at write time.`,
      );
    }
    const reads = compileRecordActionReads(coreEntity, action, fields, aclField);
    // The lock the check takes, always emitted. Leaving it implicit would put
    // the deadlock-safe default in three places (schema, compiler, migration)
    // and make a changed default silently rewrite deployed SQL; carrying it
    // means the manifest states which mode each action was compiled with.
    if (action.lock !== undefined && action.lock !== "exclusive" && action.lock !== "shared") {
      throw new AuthorizationCompileError(
        coreEntity.entity,
        `authorization.rowAccess.recordPermissions.actions "${action.name}" declares lock ` +
          `${JSON.stringify(action.lock)}; it must be "exclusive" (the default, which cannot deadlock) ` +
          `or "shared" (only for an effect that provably never locks the record more strongly).`,
      );
    }
    return {
      name: action.name,
      principals: principals.sort(),
      ...(reads.length > 0 ? { reads } : {}),
      lock: action.lock ?? "exclusive",
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The fields a holder of this action may read, validated against what the
 * projection can safely carry.
 *
 * Each refusal below is a way the projection could otherwise become a read of
 * something the action never authorized: the ACL itself (who else holds what),
 * a classified field (PII, a BSN, a confidential value), a computed or
 * localized field (resolved elsewhere, so the stored column is not the value),
 * a relationship (another record), and anything unpersisted (no column to
 * read). A field that survives all of them is one plain stored column of the
 * one row the action names.
 */
function compileRecordActionReads(
  coreEntity: CoreEntity,
  action: import("../types/common.js").RowAccessRecordActionConfig,
  fields: ReadonlyArray<Record<string, unknown>>,
  aclField: string,
): string[] {
  const reads = [...new Set(action.reads ?? [])].sort();
  const refuse = (key: string, reason: string): never => {
    throw new AuthorizationCompileError(
      coreEntity.entity,
      `authorization.rowAccess.recordPermissions.actions "${action.name}" cannot read "${key}": ${reason}. ` +
        `A record action's read projection carries plain stored columns of the record it names and nothing else.`,
    );
  };
  for (const key of reads) {
    if (key === aclField) refuse(key, "it is the record ACL itself");
    const field = fields.find((candidate) => candidate.key === key);
    if (!field) refuse(key, "it is not a field of this entity");
    if (!(field!.persisted as { column?: string } | undefined)?.column) {
      refuse(key, "it is not persisted, so there is no column to read");
    }
    if (field!.relationship) refuse(key, "it is a relationship, which would reach another record");
    if (field!.computed) refuse(key, "it is computed rather than stored");
    if (field!.localized) refuse(key, "it is localized, so the stored column is not the value");
    if (field!.classification) {
      refuse(key, `it is classified ${JSON.stringify(field!.classification)}`);
    }
    if (field!.authorization || field!.permissions) {
      refuse(key, "it carries its own field authorization, which this projection cannot apply");
    }
  }
  return reads;
}

function isValidSubjectSets(value: unknown, allowIntegrations: boolean): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = allowIntegrations
    ? ["users", "groups", "roles", "integrations"]
    : ["users", "groups", "roles"];
  if (Object.keys(record).some((key) => !allowed.includes(key))) return false;
  return Object.values(record).every((entries) =>
    Array.isArray(entries) &&
    entries.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

function isValidRecordPermissionsDocument(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const document = value as Record<string, unknown>;
  if (Object.keys(document).some((key) =>
    key !== "actions" && !RECORD_PERMISSIONS.includes(key))) {
    return false;
  }
  for (const [key, member] of Object.entries(document)) {
    if (key === "actions") {
      if (!member || typeof member !== "object" || Array.isArray(member)) return false;
      for (const [name, subjects] of Object.entries(member as Record<string, unknown>)) {
        if (!RECORD_ACTION_NAME.test(name) || RECORD_PERMISSIONS.includes(name)) return false;
        if (!isValidSubjectSets(subjects, true)) return false;
      }
      continue;
    }
    if (!isValidSubjectSets(member, false)) return false;
  }
  return true;
}

/**
 * A seeded ACL may only grant actions the entity declares, to principal kinds
 * that action admits — the same rule the runtime enforces on every write. A
 * default that violates it would seed a grant no write could ever restore.
 */
function defaultRecordActionsAreDeclared(
  value: unknown,
  actions: import("../types/common.js").RowAccessRecordActionConfig[],
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const granted = (value as Record<string, unknown>).actions;
  if (!granted || typeof granted !== "object" || Array.isArray(granted)) return true;
  return Object.entries(granted as Record<string, unknown>).every(([name, subjects]) => {
    const declaration = actions.find((action) => action.name === name);
    if (!declaration) return false;
    const sets = (subjects ?? {}) as Record<string, unknown[]>;
    const names = (kind: "person" | "integration") =>
      kind === "integration"
        ? [sets.integrations]
        : [sets.users, sets.groups, sets.roles];
    return (["person", "integration"] as const).every((kind) =>
      declaration.principals.includes(kind) ||
      names(kind).every((entries) => !Array.isArray(entries) || entries.length === 0));
  });
}

function collectFieldAuthorizations(
  fields: CompiledField[],
  result: CompiledFieldAuthorization[],
): void {
  for (const field of fields) {
    if (field.authorization) {
      result.push({
        fieldKey: field.key,
        readRoles: field.authorization.roles.read ?? [],
        writeRoles: field.authorization.roles.write ?? [],
      });
    }
  }
}
