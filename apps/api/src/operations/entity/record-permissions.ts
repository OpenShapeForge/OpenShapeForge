// SPDX-License-Identifier: BUSL-1.1
/** Action-specific record authorization shared by CRUD and plugin Operations. */
import { sql, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { resolvePrincipalClass, withDbSession, type DbSessionInput } from "../../db/session.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { generatedCrudError } from "./catalog.js";
import { primaryKeyEquals } from "./columns.js";
import { notAuthorizedRefusal } from "./authorization-refusal-text.js";
import { operationFailure } from "@openshapeforge/operations";
import type { GeneratedCrudTable, GeneratedEntityRow } from "./types.js";
import { subtypeScopeWhere } from "./subtype-scope.js";

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
 *   - A subject kind is matched against the session's VERIFIED principal
 *     class, not merely against its roles. A person subject is satisfiable
 *     only by a session the server classified as a person, and `integrations`
 *     only by one carrying a resolved API-key integration. So a service
 *     account that happens to hold the same role as a person acquires no
 *     person-only action, and a session the server could not classify holds
 *     no action at all.
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
  // Mirrors app.record_action_subject_allows: one class, one set of subjects.
  switch (resolvePrincipalClass(session)) {
    case "person": {
      if (session.userId && subjects.users.includes(session.userId)) return true;
      if ((session.roles ?? []).some((role) => subjects.roles.includes(role))) return true;
      const directGroups = (session.relationGroupIds ?? [])
        .filter((group) => UUID.test(group));
      return directGroups.some((group) => subjects.groups.includes(group));
    }
    case "application": {
      const integrationId = session.appPrincipal?.integrationId;
      return Boolean(integrationId) && subjects.integrations.includes(integrationId!);
    }
    default:
      return false;
  }
}

function policy(table: GeneratedCrudTable) {
  return table.source?.authorization?.recordPermissions;
}

function valueFromRow(table: GeneratedCrudTable, row: GeneratedEntityRow): unknown {
  const config = policy(table);
  if (!config) return undefined;
  return row[config.field] ?? row[config.column];
}

export type RecordActionDeclaration = {
  name: string;
  principals: ReadonlyArray<"person" | "integration">;
  /** Fields a holder may read; absent for an action that discloses nothing. */
  reads?: ReadonlyArray<string>;
};

/** The actions this entity declared, if any. Nothing else may be stored. */
export function declaredRecordActions(
  table: GeneratedCrudTable,
): ReadonlyArray<RecordActionDeclaration> {
  return policy(table)?.actions ?? [];
}

export function recordActionDeclaration(
  table: GeneratedCrudTable,
  action: string,
): RecordActionDeclaration | undefined {
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
 * Authorize ONE named action on ONE record.
 *
 * Delegates to `app.record_action_allows`, the owner-scoped point lookup
 * installed by db/migrations/record-actions.ts. Three properties come from
 * there rather than from here, and this function must not try to reproduce
 * them:
 *
 *   - the record stays unreadable. The lookup's definer role is admitted to
 *     the key, tenant and ACL columns of this entity and to nothing else, so
 *     a session holding `start` and not `view` learns one boolean and no
 *     record data;
 *   - the entity, its ACL column and its declared actions are compiled into
 *     that function. Only an entity name, a record key and an action name
 *     cross the boundary, so nothing a caller supplies can widen it;
 *   - the ACL row is locked in THIS transaction and held until it commits.
 *     That is the single lock ordering: ACL row first, then the effect, with
 *     a concurrent policy change waiting its turn either side. The strength
 *     is the action's declared `lock` — `exclusive` by default, so two
 *     parallel holders serialize here instead of deadlocking when the effect
 *     locks the same record more strongly.
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
  const entity = table.source?.authoringEntityName;
  // A contract asking for an action the entity never declared, an entity
  // without the ACL at all, an untenanted table or one the manifest gave no
  // authoring name is a compiler-side mistake, not a caller's: refuse without
  // consulting a row.
  if (!config || !declaration || !entity || !table.tenantScoped) {
    throw generatedCrudError(
      "The record authorization contract is incomplete.",
      "INTERNAL_SERVER_ERROR",
    );
  }
  // A subtype shares its base's physical table, and the lookup is keyed on
  // the base entity. Authorizing a subtype action through the base row would
  // let a sibling projection's record answer for it, so refuse rather than
  // decide on the wrong contract.
  if (table.subtype) {
    throw generatedCrudError(
      "Record actions are not available on an entity subtype.",
      "INTERNAL_SERVER_ERROR",
    );
  }
  await assertActionPrincipalLive(trx, table, action);
  const result = await sql<{ allowed: boolean }>`
    select app.record_action_allows(${entity}, ${id}, ${action}) as allowed
  `.execute(trx);
  if (result.rows[0]?.allowed !== true) {
    throw operationFailure(notAuthorizedRefusal(table, action));
  }
}

/**
 * Is the credential behind this session still live? Asked FIRST, in the
 * action's own transaction, and refused with the same message as a missing
 * grant.
 *
 * Why it is a statement of its own rather than a conjunct of the lookup: the
 * two take locks, and the ordering is part of the contract. The fence locks
 * the integration row and then the credential row; the lookup locks the ACL
 * row. Folding them into one expression would leave the order to the planner,
 * and a reader could no longer tell which lock a waiting transaction is on.
 * See `app.record_action_principal_live` (db/migrations/record-actions.ts)
 * for the order itself and for why it is the one a disable writes in.
 *
 * Why the refusal is indistinguishable from "no grant": a holder learns that
 * it may not act, and not whether the reason was the record's policy or its
 * own credential. The management surface — which is authenticated as a human
 * (auth/api-key/ceiling.ts) — is where the state of a key is legible.
 *
 * A session of any other principal class passes this unchanged: there is no
 * API-key credential to withdraw, so the function answers true without
 * reading a row or taking a lock.
 *
 * The answer is POINT-IN-TIME, at this statement. A revoke or a disable cannot
 * interleave with the effect that follows — the fence's `for share` locks
 * serialize against their UPDATE in both directions — but an EXPIRY that falls
 * due while the effect runs does not retract an admission already given: the
 * invocation commits, and every later check, including the bounded read's own
 * call to this function inside the same transaction, refuses. See
 * `app.record_action_principal_live` (db/migrations/record-actions.ts) for the
 * full semantics and
 * `auth/api-key/__tests__/record-action-credential-chain.e2e.test.ts` for the
 * proof on a real credential.
 */
async function assertActionPrincipalLive(
  trx: Transaction<DB>,
  table: GeneratedCrudTable,
  action: string,
): Promise<void> {
  const live = await sql<{ live: boolean }>`
    select app.record_action_principal_live() as live
  `.execute(trx);
  if (live.rows[0]?.live !== true) {
    throw operationFailure(notAuthorizedRefusal(table, action));
  }
}

/**
 * The record a holder of this action may read, and nothing else.
 *
 * A session that holds `start` and not `view` cannot see the record — so an
 * action that has to DO something with it would be stuck. The entity answers
 * that explicitly: the action declares the fields its execution needs, and
 * this returns exactly those fields of exactly that record.
 *
 * What makes it bounded rather than a bypass:
 *
 *   - the fields are compiled into `app.record_action_read` and the resolver
 *     role holds SELECT on only those columns, so an undeclared column is a
 *     privilege error and not a disclosure. The ACL column and the tenant
 *     column are refused outright, so a holder never learns who else holds
 *     what;
 *   - the row is the one the action named, in the session's own tenant, and
 *     the authorization is the same lookup under the same lock. There is no
 *     list, no second record, and no session-wide widening — the app role's
 *     own view of the table is unchanged throughout;
 *   - an action that declares nothing reads nothing. Refused here as a
 *     contract mistake rather than answered with an empty object, so a
 *     handler cannot mistake "nothing declared" for "nothing there".
 */
export async function readRecordForActionInTransaction(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
  action: string,
): Promise<Readonly<Record<string, unknown>>> {
  const declaration = recordActionDeclaration(table, action);
  const entity = table.source?.authoringEntityName;
  if (!policy(table) || !declaration || !entity || !table.tenantScoped || table.subtype) {
    throw generatedCrudError(
      "The record authorization contract is incomplete.",
      "INTERNAL_SERVER_ERROR",
    );
  }
  if (!declaration.reads?.length) {
    throw generatedCrudError(
      `The ${action} action declares no record fields to read.`,
      "INTERNAL_SERVER_ERROR",
    );
  }
  // The projection re-authorizes through the same lookup, so it needs the
  // same credential fence: a withdrawn key must not keep disclosing the
  // fields its action declared, even though the grant on the record is
  // untouched. Asked here rather than only in the assert above, because
  // `platform.records.readForAction` reaches this body directly.
  await assertActionPrincipalLive(trx, table, action);
  const result = await sql<{ payload: Record<string, unknown> | null }>`
    select app.record_action_read(${entity}, ${id}, ${action}) as payload
  `.execute(trx);
  const payload = result.rows[0]?.payload;
  // Null is the only failure the lookup reports, and it covers every reason:
  // not authorized, wrong tenant, no such row. They are one refusal, so a
  // caller cannot use the distinction to probe for records.
  if (!payload) throw operationFailure(notAuthorizedRefusal(table, action));
  return Object.freeze(payload);
}

export function readRecordForAction(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
  action: string,
): Promise<Readonly<Record<string, unknown>>> {
  return withDbSession(db, session, (trx, resolvedSession) =>
    readRecordForActionInTransaction(trx, resolvedSession, table, id, action)
  );
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
