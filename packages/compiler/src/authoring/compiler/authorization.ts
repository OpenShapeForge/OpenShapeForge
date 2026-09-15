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
      const matchingRelationship = (coreEntity.relationships ?? []).find(
        (r) => r.kind === "belongsTo" && r.foreignKey === col,
      );
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
      if (persistedField && !scalarSessionOwner) {
        throw new AuthorizationCompileError(
          coreEntity.entity,
          `authorization.rowAccess.${axis}.column "${col}" must reference a belongsTo foreignKey (auto-emitted as uuid) — ` +
            `the persisted field "${col}" has valueType "${persistedField.valueType}". ` +
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
      // The owner axis maps to `rowScope.userColumns`, whose emitter hardcodes
      // `= app.current_user_id()` (generate.ts). The runtime only ever sets the
      // `app.user_id` GUC — no code populates an arbitrary per-account session
      // var — so we constrain owner.session to the identity user id at compile
      // time rather than shipping a dead GUC surface.
      if (owner.session !== "app.current_user_id") {
        throw new AuthorizationCompileError(
          coreEntity.entity,
          `authorization.rowAccess.owner.session must be "app.current_user_id" — the runtime only exposes the current user id GUC. Per-account session vars are not supported.`,
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
        field.valueType !== "object" ||
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
      compiledRecordPermissions = {
        field: recordPermissions.field,
        column: field.persisted.column,
        empty: recordPermissions.empty,
        createRequires: [...recordPermissions.createRequires],
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

  return {
    entitySlug: slug,
    roles,
    compositeRoles,
    fieldAuthorizations,
    profileAuthorizations,
    rowAccess,
  };
}

function isValidRecordPermissionsDocument(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const document = value as Record<string, unknown>;
  if (Object.keys(document).some((key) => !["view", "edit", "delete"].includes(key))) {
    return false;
  }
  return Object.values(document).every((subjects) => {
    if (!subjects || typeof subjects !== "object" || Array.isArray(subjects)) return false;
    const record = subjects as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["users", "groups", "roles"].includes(key))) {
      return false;
    }
    return Object.values(record).every((entries) =>
      Array.isArray(entries) &&
      entries.every((entry) => typeof entry === "string" && entry.length > 0)
    );
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
