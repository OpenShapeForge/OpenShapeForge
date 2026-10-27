// SPDX-License-Identifier: BUSL-1.1
/** Action-specific record authorization shared by CRUD and plugin Operations. */
import { sql, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { generatedCrudError } from "./catalog.js";
import { primaryKeyEquals } from "./columns.js";
import { notAuthorizedRefusal } from "./authorization-refusal-text.js";
import { operationFailure } from "@openshapeforge/operations";
import type { GeneratedCrudTable, GeneratedEntityRow } from "./types.js";
import { subtypeScope, subtypeScopeWhere } from "./subtype-scope.js";

export type RecordPermissionAction = "view" | "edit" | "delete";

type RecordPermissionSubjects = {
  users: string[];
  groups: string[];
  roles: string[];
};

/**
 * A named action's subjects. Same three human axes as a permission, plus the
 * one axis a permission may never carry: `integrations`, the verified
 * application principals of `platform.api_key_integrations` rows.
 */
export type RecordActionSubjects = RecordPermissionSubjects & {
  integrations: string[];
};

/**
 * The persisted record ACL.
 *
 * Two independent axes. The three fixed PERMISSIONS (view/edit/delete) decide
 * who may see, change and remove the record, and `empty` decides what a valid
 * empty subject set means for them. The named ACTIONS decide who may invoke
 * the operations the entity declared on this record; they neither imply nor
 * are implied by the permissions, they never admit an application principal
 * to view/edit/delete, and an absent or empty entry is always a denial.
 */
export type RecordPermissionsDocument = Record<
  RecordPermissionAction,
  RecordPermissionSubjects
> & {
  actions: Record<string, RecordActionSubjects>;
};

const ACTIONS = new Set<RecordPermissionAction>(["view", "edit", "delete"]);
const SUBJECTS = new Set<keyof RecordPermissionSubjects>([
  "users",
  "groups",
  "roles",
]);
const ACTION_SUBJECTS = new Set<keyof RecordActionSubjects>([
  "users",
  "groups",
  "roles",
  "integrations",
]);
/** Must agree with `app.record_permissions_valid` and the authoring schema. */
export const RECORD_ACTION_NAME = /^[a-z][A-Za-z0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  if (!value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    return undefined;
  }
  return [...value] as string[];
}

function humanSubjects(value: unknown): RecordPermissionSubjects | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !SUBJECTS.has(key as keyof RecordPermissionSubjects))) {
    return undefined;
  }
  const users = stringArray(object.users);
  const groups = stringArray(object.groups);
  const roles = stringArray(object.roles);
  if (!users || !groups || !roles) return undefined;
  return { users, groups, roles };
}

function actionSubjects(value: unknown): RecordActionSubjects | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !ACTION_SUBJECTS.has(key as keyof RecordActionSubjects))) {
    return undefined;
  }
  const { integrations: rawIntegrations, ...rest } = object;
  const human = humanSubjects(rest);
  const integrations = stringArray(rawIntegrations);
  if (!human || !integrations) return undefined;
  return { ...human, integrations };
}

/** Strict parser: only a genuinely valid empty set may use empty=public. */
export function parseRecordPermissions(
  value: unknown,
): RecordPermissionsDocument | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) => key !== "actions" && !ACTIONS.has(key as RecordPermissionAction),
    )
  ) {
    return undefined;
  }
  const result = { actions: {} } as RecordPermissionsDocument;
  for (const action of ACTIONS) {
    const rawSubjects = raw[action];
    if (rawSubjects === undefined) {
      result[action] = { users: [], groups: [], roles: [] };
      continue;
    }
    const subjects = humanSubjects(rawSubjects);
    if (!subjects) return undefined;
    result[action] = subjects;
  }
  if (raw.actions !== undefined) {
    if (!raw.actions || typeof raw.actions !== "object" || Array.isArray(raw.actions)) {
      return undefined;
    }
    for (const [name, rawSubjects] of Object.entries(raw.actions as Record<string, unknown>)) {
      if (!RECORD_ACTION_NAME.test(name) || ACTIONS.has(name as RecordPermissionAction)) {
        return undefined;
      }
      const subjects = actionSubjects(rawSubjects);
      if (!subjects) return undefined;
      result.actions[name] = subjects;
    }
  }
  return result;
}

function subjectAllows(
  subjects: RecordPermissionSubjects,
  session: DbSessionInput,
  empty: "public" | "restricted",
): boolean {
  if (
    subjects.users.length === 0 &&
    subjects.groups.length === 0 &&
    subjects.roles.length === 0
  ) {
    return empty === "public";
  }
  if (session.userId && subjects.users.includes(session.userId)) return true;
  if ((session.roles ?? []).some((role) => subjects.roles.includes(role))) return true;
  const directGroups = (session.relationGroupIds ?? []).filter((group) => UUID.test(group));
  return directGroups.some((group) => subjects.groups.includes(group));
}

export function recordPermissionAllows(
  value: unknown,
  action: RecordPermissionAction,
  session: DbSessionInput,
  empty: "public" | "restricted",
): boolean {
  const document = parseRecordPermissions(value);
  if (!document) return false;
  if (!subjectAllows(document.view, session, empty)) return false;
  return action === "view" || subjectAllows(document[action], session, empty);
}

/**
 * Does this session hold `action` on this ACL document?
 *
 * Mirror of `app.record_action_subject_allows`. Three things make it a
 * different question from {@link recordPermissionAllows}, and all three are
 * the point of the axis:
 *
 *   - `view` is NOT consulted. An action is independently granted, so a
 *     record may authorize an application to start something it cannot read.
 *   - An empty or absent entry denies, whatever the entity authored for
 *     `empty`. There is no public action.
 *   - `integrations` matches the session's VERIFIED application principal
 *     only. A session without one — a person, a direct bearer service
 *     account, a trusted-context bundle — matches nothing in it.
 */
export function recordActionAllows(
  value: unknown,
  action: string,
  session: DbSessionInput,
): boolean {
  if (!RECORD_ACTION_NAME.test(action) || ACTIONS.has(action as RecordPermissionAction)) {
    return false;
  }
  const document = parseRecordPermissions(value);
  const subjects = document?.actions[action];
  if (!subjects) return false;
  if (
    subjects.users.length === 0 &&
    subjects.groups.length === 0 &&
    subjects.roles.length === 0 &&
    subjects.integrations.length === 0
  ) {
    return false;
  }
  if (session.userId && subjects.users.includes(session.userId)) return true;
  if ((session.roles ?? []).some((role) => subjects.roles.includes(role))) return true;
  const directGroups = (session.relationGroupIds ?? []).filter((group) => UUID.test(group));
  if (directGroups.some((group) => subjects.groups.includes(group))) return true;
  const integrationId = session.appPrincipal?.integrationId;
  return Boolean(integrationId) && subjects.integrations.includes(integrationId!);
}

function policy(table: GeneratedCrudTable) {
  return table.source?.authorization?.recordPermissions;
}

function valueFromRow(table: GeneratedCrudTable, row: GeneratedEntityRow): unknown {
  const config = policy(table);
  if (!config) return undefined;
  return row[config.field] ?? row[config.column];
}

/** The actions this entity declared, if any. Nothing else may be stored. */
export function declaredRecordActions(
  table: GeneratedCrudTable,
): ReadonlyArray<{ name: string; principals: ReadonlyArray<"person" | "integration"> }> {
  return policy(table)?.actions ?? [];
}

export function recordActionDeclaration(
  table: GeneratedCrudTable,
  action: string,
): { name: string; principals: ReadonlyArray<"person" | "integration"> } | undefined {
  return declaredRecordActions(table).find((candidate) => candidate.name === action);
}

/**
 * A submitted ACL may only name actions the entity declared, and inside each
 * one only the principal kinds that declaration admits.
 *
 * This is the write half of the opt-in: an entity that declares no actions can
 * never carry one, and an entity that declares `start` for applications can
 * never have `start` quietly granted to a person. Without it a holder of
 * `edit` could store a grant for an action nothing validates, to be honoured
 * the day some Operation starts asking for that name.
 */
function assertDeclaredActions(
  table: GeneratedCrudTable,
  value: unknown,
): void {
  const document = parseRecordPermissions(value);
  if (!document) return; // The validity refusal is the caller's to raise.
  const entries = Object.entries(document.actions);
  if (entries.length === 0) return;
  const config = policy(table)!;
  for (const [name, subjects] of entries) {
    const declaration = recordActionDeclaration(table, name);
    if (!declaration) {
      throw generatedCrudError(
        "The record permissions name an action this entity does not declare.",
        "VALIDATION",
        {
          detail: declaredRecordActions(table).length === 0
            ? `${config.field} carries no actions on this entity.`
            : `${config.field}.actions may only name ${
              declaredRecordActions(table).map((action) => action.name).join(", ")
            }.`,
        },
      );
    }
    const named: Array<["person" | "integration", readonly string[]]> = [
      ["person", subjects.users],
      ["person", subjects.groups],
      ["person", subjects.roles],
      ["integration", subjects.integrations],
    ];
    for (const [kind, members] of named) {
      if (members.length > 0 && !declaration.principals.includes(kind)) {
        throw generatedCrudError(
          "The record permissions name a principal this action does not admit.",
          "VALIDATION",
          { detail: `${config.field}.actions.${name} admits ${declaration.principals.join(", ")} principals only.` },
        );
      }
    }
    for (const integrationId of subjects.integrations) {
      if (!UUID.test(integrationId)) {
        throw generatedCrudError(
          "The record permissions name an application that is not an integration id.",
          "VALIDATION",
          { detail: `${config.field}.actions.${name}.integrations holds integration ids, not names or keys.` },
        );
      }
    }
  }
}

export function recordPermissionsAllowRow(
  table: GeneratedCrudTable,
  row: GeneratedEntityRow,
  permissions: readonly RecordPermissionAction[],
  session: DbSessionInput,
): boolean {
  if (permissions.length === 0) return true;
  const config = policy(table);
  if (!config) return false;
  const value = valueFromRow(table, row);
  return permissions.every((permission) =>
    recordPermissionAllows(value, permission, session, config.empty)
  );
}

export function assertCreateRecordPermissions(
  table: GeneratedCrudTable,
  session: DbSessionInput,
  values: Readonly<Record<string, unknown>>,
): void {
  const config = policy(table);
  if (!config) return;
  const value = values[config.field] ?? values[config.column] ?? config.defaultValue;
  if (!parseRecordPermissions(value)) {
    throw generatedCrudError(
      "The record permissions are not valid.",
      "VALIDATION",
      {
        detail: `${config.field} must contain only view, edit and delete subject sets with users, groups and roles string arrays, and an optional actions object.`,
      },
    );
  }
  assertDeclaredActions(table, value);
  if (
    !config.createRequires.every((permission) =>
      recordPermissionAllows(value, permission, session, config.empty)
    )
  ) {
    throw generatedCrudError(
      "Not authorized to create a record with these permissions.",
      "FORBIDDEN",
    );
  }
}

/** A caller may replace an ACL only with another complete valid document. */
export function assertUpdateRecordPermissions(
  table: GeneratedCrudTable,
  values: Readonly<Record<string, unknown>>,
): void {
  const config = policy(table);
  if (!config) return;
  const hasField = Object.prototype.hasOwnProperty.call(values, config.field);
  const hasColumn = Object.prototype.hasOwnProperty.call(values, config.column);
  if (!hasField && !hasColumn) return;

  // Match the existing create input contract: authored field first, persisted
  // column alias second. Undefined is ignored by normalizeWritableValues and
  // therefore is not a replacement at all.
  const value = values[config.field] ?? values[config.column];
  if (value === undefined) return;
  if (!parseRecordPermissions(value)) {
    throw generatedCrudError(
      "The record permissions are not valid.",
      "VALIDATION",
      {
        detail: `${config.field} must contain only view, edit and delete subject sets with users, groups and roles string arrays, and an optional actions object.`,
      },
    );
  }
  assertDeclaredActions(table, value);
}

export async function assertRecordPermissionInTransaction(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
  permission: RecordPermissionAction,
): Promise<void> {
  const config = policy(table);
  if (!config || !table.primaryKey) {
    throw generatedCrudError(
      "The record authorization contract is incomplete.",
      "INTERNAL_SERVER_ERROR",
    );
  }
  const tenantWhere = table.tenantScoped
    ? sql`and ${sql.id("row_source", "tenant_id")} = ${session.tenantId}`
    : sql``;
  const result = await sql<{ allowed: boolean }>`
    select app.record_permission_allows(
      ${sql.id("row_source", config.column)},
      ${permission},
      ${config.empty === "public"}
    ) as allowed
    from ${sql.id(table.schema, table.table)} as row_source
    where ${primaryKeyEquals(table, id, "row_source")}
      ${tenantWhere}
      ${subtypeScopeWhere(table, "row_source")}
    limit 1
  `.execute(trx);
  if (result.rows[0]?.allowed !== true) {
    throw operationFailure(notAuthorizedRefusal(table, permission));
  }
}

export function assertRecordPermission(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
  permission: RecordPermissionAction,
): Promise<void> {
  return withDbSession(db, session, (trx, resolvedSession) =>
    assertRecordPermissionInTransaction(trx, resolvedSession, table, id, permission)
  );
}

/**
 * Authorize ONE named action on ONE record, as a live read in the caller's
 * transaction.
 *
 * In the transaction on purpose: the grant is a column of the record, so a
 * policy edit or a revocation that commits while this Operation runs must
 * decide the same way the rest of the Operation's reads and writes do. The
 * row is read through `app.record_action_allows`, which is also the only way
 * to reach it — the record itself stays invisible to a session that holds an
 * action and not `view`.
 */
export async function assertRecordActionInTransaction(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
  action: string,
): Promise<void> {
  const config = policy(table);
  const declaration = recordActionDeclaration(table, action);
  // A contract that asks for an action the entity never declared, an entity
  // without the ACL at all, an untenanted table or a keyless one is a
  // compiler-side mistake, not a caller's: refuse without consulting a row.
  if (!config || !declaration || !table.primaryKey || !table.tenantScoped) {
    throw generatedCrudError(
      "The record authorization contract is incomplete.",
      "INTERNAL_SERVER_ERROR",
    );
  }
  const keyColumn = table.columns.find((column) => column.name === table.primaryKey);
  const scope = Object.fromEntries(
    subtypeScope(table).map((entry) => [entry.column, entry.value]),
  );
  const result = await sql<{ allowed: boolean }>`
    select app.record_action_allows(
      ${`${table.schema}.${table.table}`}::regclass,
      ${config.column},
      ${table.primaryKey},
      ${keyColumn?.type === "uuid"},
      ${id},
      ${JSON.stringify(scope)}::jsonb,
      ${action}
    ) as allowed
  `.execute(trx);
  if (result.rows[0]?.allowed !== true) {
    throw operationFailure(notAuthorizedRefusal(table, action));
  }
}

export function assertRecordAction(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
  action: string,
): Promise<void> {
  return withDbSession(db, session, (trx, resolvedSession) =>
    assertRecordActionInTransaction(trx, resolvedSession, table, id, action)
  );
}

/** Row-local action evaluation for Operation offers; never the only gate. */
export function recordActionsAllowRow(
  table: GeneratedCrudTable,
  row: GeneratedEntityRow,
  actions: readonly string[],
  session: DbSessionInput,
): boolean {
  if (actions.length === 0) return true;
  if (!policy(table)) return false;
  const value = valueFromRow(table, row);
  return actions.every((action) => recordActionAllows(value, action, session));
}
