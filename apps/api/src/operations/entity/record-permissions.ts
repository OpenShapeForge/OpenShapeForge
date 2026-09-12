// SPDX-License-Identifier: BUSL-1.1
/** Action-specific record authorization shared by CRUD and plugin Operations. */
import { sql, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { generatedCrudError } from "./catalog.js";
import type { GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

export type RecordPermissionAction = "view" | "edit" | "delete";

type RecordPermissionSubjects = {
  users: string[];
  groups: string[];
  roles: string[];
};

export type RecordPermissionsDocument = Record<
  RecordPermissionAction,
  RecordPermissionSubjects
>;

const ACTIONS = new Set<RecordPermissionAction>(["view", "edit", "delete"]);
const SUBJECTS = new Set<keyof RecordPermissionSubjects>([
  "users",
  "groups",
  "roles",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  if (!value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    return undefined;
  }
  return [...value] as string[];
}

/** Strict parser: only a genuinely valid empty set may use empty=public. */
export function parseRecordPermissions(
  value: unknown,
): RecordPermissionsDocument | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !ACTIONS.has(key as RecordPermissionAction))) {
    return undefined;
  }
  const result = {} as RecordPermissionsDocument;
  for (const action of ACTIONS) {
    const rawSubjects = raw[action];
    if (rawSubjects === undefined) {
      result[action] = { users: [], groups: [], roles: [] };
      continue;
    }
    if (!rawSubjects || typeof rawSubjects !== "object" || Array.isArray(rawSubjects)) {
      return undefined;
    }
    const object = rawSubjects as Record<string, unknown>;
    if (Object.keys(object).some((key) => !SUBJECTS.has(key as keyof RecordPermissionSubjects))) {
      return undefined;
    }
    const users = stringArray(object.users);
    const groups = stringArray(object.groups);
    const roles = stringArray(object.roles);
    if (!users || !groups || !roles) return undefined;
    result[action] = { users, groups, roles };
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
  const directGroups = (session.groups ?? []).filter((group) => UUID.test(group));
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

function policy(table: GeneratedCrudTable) {
  return table.source?.authorization?.recordPermissions;
}

function valueFromRow(table: GeneratedCrudTable, row: GeneratedEntityRow): unknown {
  const config = policy(table);
  if (!config) return undefined;
  return row[config.field] ?? row[config.column];
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
        detail: `${config.field} must contain only view, edit and delete subject sets with users, groups and roles string arrays.`,
      },
    );
  }
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
    where ${sql.id("row_source", table.primaryKey)}::text = ${id}
      ${tenantWhere}
    limit 1
  `.execute(trx);
  if (result.rows[0]?.allowed !== true) {
    throw generatedCrudError(
      `Not authorized to ${permission} ${table.source?.authoringEntityName ?? table.name}.`,
      "FORBIDDEN",
    );
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
