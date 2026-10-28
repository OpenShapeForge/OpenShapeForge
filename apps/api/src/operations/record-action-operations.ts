// SPDX-License-Identifier: BUSL-1.1
/**
 * The core `osf-record-actions` runtime: the ONE Operation that may change a
 * record's named-action axis
 * (packages/compiler/config/authoring/operations/record-actions.yaml).
 *
 * WHY IT EXISTS AT ALL
 * --------------------
 * The record ACL carries two axes in one document. Rewriting view/edit/delete
 * hands a person the access the record's own editor already has, so the
 * record's `edit` permission is the right authority for it and that stays an
 * ordinary entity update. Granting a NAMED ACTION can hand a tenant's
 * integration the right to invoke an Operation on this record — without the
 * record ever becoming readable — and a record editor holds no integration
 * management right. Those are not the same decision and must not share one
 * authority, so the axis is unwritable through every ordinary path
 * (entity/record-permissions.ts) and reachable only here.
 *
 * WHAT AUTHORITY IT ASKS FOR, AND WHERE EACH PART COMES FROM
 * ----------------------------------------------------------
 * Nothing new is invented; each check is an existing one, applied here:
 *
 *   the entity's update roles    readGeneratedCrudTable(entity, "update") —
 *                                the same gate an ordinary update passes;
 *   the record's `edit`          assertRecordPermissionInTransaction — the
 *                                same gate an ordinary update passes, under
 *                                the same ACL-row lock;
 *   a verified person            the credential and the verified principal
 *                                class, as an allow-list of the two carriers
 *                                a person arrives on. Default-deny: a session
 *                                this server could not classify as a person
 *                                does not delegate. An api-key session doing
 *                                it is a ladder — the holder would grant
 *                                itself what any record it can edit may
 *                                reach, one rung at a time — which is exactly
 *                                the rule auth/api-key/ceiling.ts already
 *                                states for key management;
 *   integration management       assertMayManageApiKeys, the existing
 *                                privilege ceiling of the provisioning
 *                                surface (`Platform.ApiKeys.Manage`), asked
 *                                for only when an application subject is
 *                                named or removed. Provisioning the
 *                                integration took that role; handing it a
 *                                record takes it too.
 *
 * WHY A DELTA AND NOT A REPLACE
 * -----------------------------
 * A replace loses a concurrent administrator's grant and turns a stale read
 * into a silent revocation. The delta is applied to the document read under
 * `for update` in this transaction, so two delegations serialize and neither
 * can overwrite the other, and a caller that read the record ten minutes ago
 * still only adds or removes what it named.
 *
 * WHAT IT DELIBERATELY DOES NOT TAKE
 * ----------------------------------
 * An entity's edit lease and confirmation challenge guard CONTENT edits of a
 * record, and this changes no content. A delegation does bump the record's
 * version token, so a lease holder's next save sees an ordinary
 * `VERSION_CONFLICT` and reloads — which is the truthful answer, because the
 * record it is about to write did change underneath it.
 */
import { sql, type Transaction } from "kysely";
import { operationFailure } from "@openshapeforge/operations";
import { ApiKeyAuthorizationError, assertMayManageApiKeys } from "../auth/api-key/ceiling.js";
import type { SessionCredential, TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DB } from "../generated/db/types.js";
import { resolvePrincipalClass, withDbSession, UUID_PATTERN } from "../db/session.js";
import type { ModuleOperationContext, ModuleOperationHandler } from "../modules/contract.js";
import {
  assertRecordPermissionInTransaction,
  canonicalRecordActionAxis,
  storedRecordActionAxis,
  parseRecordPermissions,
  getGeneratedCrudTables,
  primaryKeyEquals,
  recordActionAxisOf,
  recordActionDeclaration,
  requireEntityOperation,
  type RecordActionSubjects,
} from "./entity/index.js";
import { subtypeScopeWhere } from "./entity/subtype-scope.js";
import type { GeneratedCrudTable } from "./entity/types.js";
import type { OperationContract } from "./runtime.js";
import { assertAdmittedBeforeEffects } from "./execution-policy.js";

/** The plugin name the delegation Operation is authored under. */
export const RECORD_ACTIONS_PLUGIN = "osf-record-actions";

const SUBJECT_KINDS = ["users", "groups", "roles", "integrations"] as const;
type SubjectKind = (typeof SUBJECT_KINDS)[number];

/** The principal kind each subject list names, as the declaration spells it. */
const PRINCIPAL_OF: Record<SubjectKind, "person" | "integration"> = {
  users: "person",
  groups: "person",
  roles: "person",
  integrations: "integration",
};

type SubjectDelta = Record<SubjectKind, string[]>;

function refuse(code: string, message: string, detail?: string): never {
  throw operationFailure({ code, message, ...(detail ? { detail } : {}) });
}

function requireSession(
  context: ModuleOperationContext,
): { db: OpenShapeForgeDatabase; session: TrustedSessionContext } {
  const { db, session } = context;
  if (!db) {
    throw operationFailure({
      code: "DATABASE_NOT_CONFIGURED",
      message: "The database is unavailable.",
      retryable: true,
    });
  }
  if (!session?.tenantId || !session.userId) {
    refuse("UNAUTHENTICATED", "An authenticated tenant session is required.");
  }
  return { db, session };
}

function text(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    refuse("BAD_USER_INPUT", `${name} is missing or malformed.`);
  }
  return value;
}

/** One side of the delta, validated into the four subject lists. */
function subjectDelta(value: unknown, side: "grant" | "revoke"): SubjectDelta {
  const empty = { users: [], groups: [], roles: [], integrations: [] } as SubjectDelta;
  if (value === undefined || value === null) return empty;
  if (typeof value !== "object" || Array.isArray(value)) {
    refuse("BAD_USER_INPUT", `${side} must be an object of subject lists.`);
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!SUBJECT_KINDS.includes(key as SubjectKind)) {
      refuse("BAD_USER_INPUT", `${side} may only name users, groups, roles and integrations.`);
    }
  }
  const result = { ...empty };
  for (const kind of SUBJECT_KINDS) {
    const entries = input[kind];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || entry === "")) {
      refuse("BAD_USER_INPUT", `${side}.${kind} must be an array of non-empty strings.`);
    }
    const values = [...new Set(entries as string[])];
    // A subject that identifies a row is a uuid here as it is in storage, so a
    // display name or a key prefix cannot be stored as one and silently never
    // match. Roles are realm names and stay free text.
    if (kind !== "roles" && values.some((entry) => !UUID_PATTERN.test(entry))) {
      refuse("VALIDATION", `${side}.${kind} holds record ids, not names or keys.`);
    }
    result[kind] = values;
  }
  return result;
}

function touchedKinds(...deltas: SubjectDelta[]): SubjectKind[] {
  return SUBJECT_KINDS.filter((kind) => deltas.some((delta) => delta[kind].length > 0));
}

/**
 * The carriers a delegation may arrive on. An allow-list, so a credential
 * added to the platform tomorrow is refused here until someone decides it is
 * a person's — never admitted by having escaped a list of machines.
 */
const DELEGATING_CARRIERS: readonly SessionCredential[] = ["bearer", "trusted-context"];

/**
 * Is this session a person the SERVER verified? Default-deny on a POSITIVE
 * fact: the deployment must have classified the principal as a person, and
 * nothing else counts.
 *
 * `bearer` carries the verdict the bearer path derived from verified claims
 * (`auth/bearer-session.ts`); `trusted-context` carries the one the in-mesh
 * hop signed INSIDE its HMAC (packages/auth, payload v3), which apps/web
 * signs only for a session it established through an interactive login.
 *
 * Absence is refused rather than read as a person. That is the one rule this
 * gate shares with the credential ceiling (`auth/api-key/ceiling.ts`,
 * `mayCarryKeyManagement`) and it closes the same four doors: a Keycloak
 * service account holding the management role, a verified token that is
 * neither person nor service account, an in-mesh hop that forwards an
 * identity it never authenticated — the payload-v2 bundle this deployment
 * still accepts for ordinary work — and any future carrier added to
 * `SessionCredential` without a decision here. A v2 producer reaches this
 * surface by being redeployed to sign v3, not by this gate guessing.
 *
 * Everything else is a machine or unclassifiable: an api-key session (a
 * credential that can delegate record actions can delegate them to itself),
 * a bearer service account of that same integration taking the route its key
 * is denied, a capability grant, and a control-realm operator who is not a
 * member of this tenant at all.
 */
function isVerifiedDelegatingPerson(session: TrustedSessionContext): boolean {
  if (!DELEGATING_CARRIERS.includes(session.credential)) return false;
  // `appPrincipal` is restated rather than left to the resolver so a later
  // change to either one cannot quietly widen this gate; `resolvePrincipalClass`
  // answers `person` only for a server-set `principalKind` of "person".
  if (session.appPrincipal) return false;
  return resolvePrincipalClass(session) === "person";
}

/** The carrier gate: a delegation is a human administrative act. */
function assertDelegatingCarrier(session: TrustedSessionContext): void {
  if (isVerifiedDelegatingPerson(session)) return;
  refuse(
    "FORBIDDEN",
    "Only a verified person may delegate a record action.",
    "Record actions are delegated by a person, on a carrier this server classified " +
      "as one. An api-key session, a service account and a session the server could " +
      "not classify as a person are all refused: an application that holds an action " +
      "cannot extend it, to itself or to anyone else.",
  );
}

/**
 * The existing provisioning ceiling, asked for when an application is named.
 *
 * The session's own verified `principalKind` travels with it: the ceiling
 * decides on the carrier before it decides on a role, and a caller that
 * dropped the class would be refused for the wrong reason — or, if the
 * ceiling ever stopped requiring one, admitted for no reason at all.
 */
function assertMayDelegateToIntegrations(session: TrustedSessionContext): void {
  try {
    assertMayManageApiKeys({
      roles: session.roles,
      credential: session.credential,
      ...(session.principalKind ? { principalKind: session.principalKind } : {}),
    });
  } catch (error) {
    if (error instanceof ApiKeyAuthorizationError) {
      refuse(
        "FORBIDDEN",
        "Not authorized to delegate a record action to an application.",
        "Naming an integration grants it the right to invoke this Operation on this " +
          "record. That is the integration-management authority, not the record's " +
          "edit permission.",
      );
    }
    throw error;
  }
}

/**
 * Every integration being GRANTED must be an active integration of this
 * tenant, and must still be one when this transaction commits.
 *
 * `for share` is what makes the second half true. Without it the status is
 * read from this transaction's snapshot, and an administrator disabling the
 * integration in the same moment commits either side of that read: the grant
 * lands on an integration that is already disabled, inert until someone
 * re-activates the integration and silently effective again the moment they
 * do. The share lock conflicts with the row lock the disable's `UPDATE` takes
 * (`for key share` would not), so the two orderings are the only two
 * outcomes — the disable commits first and this read, re-evaluated against
 * the committed row, no longer matches `active`; or this transaction commits
 * first and the disable waits for it, leaving a grant its administrator can
 * see and revoke.
 *
 * LOCK ORDER. This is taken BEFORE the record's ACL row, which is the one
 * global order every participant in this axis keeps:
 *
 *   integration -> credential -> record ACL
 *
 * The runtime check of a named action takes the first two in
 * `app.record_action_principal_live` and the third in
 * `app.record_action_allows` (db/migrations/record-actions.ts), in that
 * order; `disableIntegration` (auth/api-key/service.ts) writes the
 * integration row and then the keys under it and touches no business row.
 * Taking the integration AFTER the ACL row here would invert the first and
 * the third, and the cycle is reachable in three transactions even though two
 * `for share` holders never block each other: an action in flight holds the
 * integration share and waits for the ACL row this writer holds, a concurrent
 * disable queues its `UPDATE` behind that share, and this writer's own share
 * request then queues behind the disable rather than joining the holder. One
 * of the three is aborted by the deadlock detector — an availability failure
 * under load, not an access bypass, and avoidable by ordering.
 *
 * Moving it earlier costs the check nothing. The share lock is held until
 * commit either way, so a concurrent disable still has only two outcomes: it
 * commits first and this statement, re-evaluated against the committed row,
 * no longer matches `active`; or this transaction commits first and the
 * disable waits for it, leaving a grant its administrator can see and revoke.
 * The grant itself is still decided under the ACL-row lock below, which is
 * what fences a concurrent policy change on the record.
 *
 * Revocation deliberately takes neither check nor lock: a grant left behind
 * by a deleted or disabled integration must stay removable.
 *
 * One refusal for all three reasons — absent, another tenant's, not active —
 * so the answer cannot be used to probe another tenant's integration ids. The
 * ids named back are the caller's own input.
 */
export async function assertActiveIntegrations(
  trx: Transaction<DB>,
  tenantId: string,
  integrationIds: readonly string[],
): Promise<void> {
  if (integrationIds.length === 0) return;
  const rows = await sql<{ id: string }>`
    select id::text as id
      from platform.api_key_integrations
     where tenant_id = ${tenantId}::uuid
       and status = 'active'
       and id = any(${`{${integrationIds.join(",")}}`}::uuid[])
       for share
  `.execute(trx);
  const active = new Set(rows.rows.map((row) => row.id));
  const missing = integrationIds.filter((id) => !active.has(id)).sort();
  if (missing.length > 0) {
    refuse(
      "NOT_FOUND",
      "No active integration of this tenant matches the named application.",
      `${missing.join(", ")} is not an active integration of this tenant.`,
    );
  }
}

/** Apply the delta to one action's subject set. */
function applyDelta(
  current: RecordActionSubjects | undefined,
  grant: SubjectDelta,
  revoke: SubjectDelta,
): RecordActionSubjects {
  const base = current ?? { users: [], groups: [], roles: [], integrations: [] };
  const next = { users: [], groups: [], roles: [], integrations: [] } as RecordActionSubjects;
  for (const kind of SUBJECT_KINDS) {
    const removed = new Set(revoke[kind]);
    next[kind] = [...new Set([...base[kind], ...grant[kind]])]
      .filter((subject) => !removed.has(subject))
      .sort();
  }
  return next;
}

/**
 * The ACL document a delegation stores: the same document, one axis changed.
 *
 * The axis goes in as the STORED form — canonical, minus the subject kinds
 * that name nobody — so the column keeps reading as what was granted rather
 * than as three empty lists around it. Comparison still uses the full
 * canonical shape, which the parser restores.
 */
function withAxis(stored: unknown, axis: Record<string, RecordActionSubjects>): Record<string, unknown> {
  const document = { ...(stored && typeof stored === "object" && !Array.isArray(stored)
    ? stored as Record<string, unknown>
    : {}) };
  const canonical = storedRecordActionAxis(axis);
  if (Object.keys(canonical).length === 0) delete document.actions;
  else document.actions = canonical;
  return document;
}

export type RecordActionDelegationRequest = {
  entity: unknown;
  recordId: unknown;
  action: unknown;
  grant?: unknown;
  revoke?: unknown;
  /**
   * The record version the caller acted on. The lock already prevents a lost
   * update; this refuses an UNINFORMED one — a delta aimed at a record that
   * has moved since the caller looked at it.
   */
  expectedVersion?: string | undefined;
};

export type RecordActionDelegationResult = {
  entity: string;
  recordId: string;
  action: string;
  changed: boolean;
  subjects: RecordActionSubjects;
  /** The record's concurrency token after the delta, when the entity stores one. */
  version: string | null;
};

function versionToken(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The delegation, callable in-process as well as over an interface.
 *
 * Extracted from the handler so there is exactly ONE implementation of this
 * authority. The management surface
 * (record-action-assignments/mutation.ts) reaches the axis through this
 * function rather than through a write of its own: a second writer would be a
 * second set of checks to keep in step, which is the failure the whole
 * single-writer design exists to prevent.
 */
export async function applyRecordActionDelegation(
  db: OpenShapeForgeDatabase,
  session: TrustedSessionContext,
  request: RecordActionDelegationRequest,
): Promise<RecordActionDelegationResult> {
  const entityName = text(request.entity, "entity", /^[A-Z][A-Za-z0-9]*$/);
  const recordId = text(request.recordId, "recordId", UUID_PATTERN);
  const action = text(request.action, "action", /^[a-z][A-Za-z0-9]*$/);
  const grant = subjectDelta(request.grant, "grant");
  const revoke = subjectDelta(request.revoke, "revoke");
  const expectedVersion = request.expectedVersion;
  if (touchedKinds(grant, revoke).length === 0) {
    refuse("BAD_USER_INPUT", "The call grants and revokes nothing.");
  }
  assertDelegatingCarrier(session);

  // Resolved by AUTHORED entity name, the name a caller of a generic
  // Operation has; the physical table is the manifest's business. A subtype
  // projection never answers for the name: it shares its base's row, and the
  // lookup that authorizes an action is keyed on the base entity, so a
  // projection would write the sibling's policy.
  const table: GeneratedCrudTable | undefined = getGeneratedCrudTables().find(
    (candidate) => candidate.source?.authoringEntityName === entityName && !candidate.subtype,
  );
  if (!table) {
    refuse(
      "GENERATED_CRUD_NOT_ENABLED",
      `Generated CRUD is not enabled for ${entityName}.`,
    );
  }
  // The entity's own update gate, before anything is read: a caller that may
  // not update this entity learns nothing about its records.
  requireEntityOperation(table, "update", session);
  const config = table.source?.authorization?.recordPermissions;
  const declaration = recordActionDeclaration(table, action);
  if (!config || !declaration || !table.primaryKey || !table.tenantScoped) {
    refuse(
      "BAD_USER_INPUT",
      `${entityName} declares no record action "${action}".`,
      "Only an action declared under authorization.rowAccess.recordPermissions.actions " +
        "can be delegated; an entity without the record ACL has no axis at all.",
    );
  }
  for (const kind of touchedKinds(grant, revoke)) {
    if (!declaration.principals.includes(PRINCIPAL_OF[kind])) {
      refuse(
        "VALIDATION",
        `The ${action} action does not admit a ${PRINCIPAL_OF[kind]} principal.`,
        `${config.field}.actions.${action} admits ${declaration.principals.join(", ")} principals only.`,
      );
    }
  }
  if (touchedKinds(grant, revoke).includes("integrations")) {
    assertMayDelegateToIntegrations(session);
  }

  return withDbSession(db, session, async (trx, dbSession) => {
    // The integration rows FIRST, in the one global order every participant in
    // this axis keeps (integration -> credential -> record ACL; see
    // {@link assertActiveIntegrations} and db/migrations/record-actions.ts).
    // Held until commit, so a concurrent disable either loses the race or
    // waits for this transaction — the same two outcomes as checking it under
    // the ACL lock, without inverting the order a running action holds.
    await assertActiveIntegrations(trx, dbSession.tenantId, grant.integrations);
    // THEN the ACL row, held until commit. A runtime check that started before
    // this waits for it; one that starts after reads the result.
    const updatedAt = table.columns.find((column) => column.name === "updated_at");
    const versionSelect = updatedAt ? sql`, ${sql.id(updatedAt.name)} as version` : sql`, null as version`;
    const locked = await sql<{ acl: unknown; version: unknown }>`
      select ${sql.id(table.schema, table.table)}.${sql.id(config.column)} as acl
             ${versionSelect}
        from ${sql.id(table.schema, table.table)}
       where ${primaryKeyEquals(table, recordId)}
         and ${sql.id("tenant_id")} = ${dbSession.tenantId}
         ${subtypeScopeWhere(table)}
       limit 1
       for update
    `.execute(trx);
    const stored = locked.rows[0];
    if (!stored) {
      refuse("NOT_FOUND", `No ${entityName} record in this tenant matches this id.`);
    }
    // Changing who may act on a record is a change TO the record, so it takes
    // the record's own write authority as well. Read under the lock above, so
    // a concurrent revocation of the caller's own edit cannot slip past it.
    await assertRecordPermissionInTransaction(trx, dbSession, table, recordId, "edit");
    if (!parseRecordPermissions(stored.acl)) {
      refuse(
        "VALIDATION",
        "The record's stored permissions are not a valid document.",
        `${config.field} must be repaired before an action can be delegated on this record.`,
      );
    }
    // The lock is held, so the version read above is the one that will still
    // be in force when this write lands: a caller that acted on an older view
    // of the record is refused rather than applied blind.
    if (expectedVersion !== undefined && expectedVersion !== versionToken(stored.version)) {
      refuse(
        "VERSION_CONFLICT",
        "The record changed since you loaded it.",
        "expectedVersion does not match the record's current version token. Reload before saving.",
      );
    }
    const current = recordActionAxisOf(stored.acl);
    const next = { ...current, [action]: applyDelta(current[action], grant, revoke) };
    const document = withAxis(stored.acl, next);
    const subjects = canonicalRecordActionAxis(next)[action] ??
      { users: [], groups: [], roles: [], integrations: [] };
    // The row is locked, the authority is established and the delta is
    // resolved: the last point before a change that cannot be taken back.
    await assertAdmittedBeforeEffects(trx, dbSession);
    const result = await sql<{ version: unknown }>`
      update ${sql.id(table.schema, table.table)}
         set ${sql.id(config.column)} = ${document}
             ${updatedAt ? sql`, ${sql.id(updatedAt.name)} = now()` : sql``}
       where ${primaryKeyEquals(table, recordId)}
         and ${sql.id("tenant_id")} = ${dbSession.tenantId}
         ${subtypeScopeWhere(table)}
         and ${sql.id(config.column)} is distinct from ${document}
      returning ${updatedAt ? sql`${sql.id(updatedAt.name)}` : sql`null`} as version
    `.execute(trx);
    // The audit journal is the row trigger's (db/migrations/audit-history.ts):
    // this is an ordinary UPDATE of a business row in a session that carries
    // the verified actor, so the delegation is recorded with everything else
    // that happened to the record. Nothing is journalled when nothing changed.
    const written = result.rows[0];
    return {
      entity: entityName,
      recordId,
      action,
      changed: result.rows.length > 0,
      subjects,
      version: written ? versionToken(written.version) : versionToken(stored.version),
    };
  });
}

const delegateRecordAction: ModuleOperationHandler = async (input, context) => {
  const { db, session } = requireSession(context);
  const result = await applyRecordActionDelegation(db, session, {
    entity: input.entity,
    recordId: input.recordId,
    action: input.action,
    grant: input.grant,
    revoke: input.revoke,
  });
  // `version` is deliberately not projected: it is the management surface's
  // concurrency token, not part of this Operation's authored output contract.
  const { version: _version, ...value } = result;
  return { value, status: 200 };
};

const HANDLERS: Record<string, ModuleOperationHandler> = { delegateRecordAction };

export function recordActionOperationHandlerNames(): readonly string[] {
  return Object.keys(HANDLERS).sort();
}

/**
 * The delegation half of the plugin, for the one dispatcher that binds it.
 *
 * `osf-record-actions` has a single entry in the runtime's binding table
 * (record-action-assignments/operations.ts), so the axis writer and the
 * manager's view of it cannot drift into two differently-guarded bindings of
 * one plugin name.
 */
export function recordActionDelegationHandlers(): Record<string, ModuleOperationHandler> {
  return { ...HANDLERS };
}

export function recordActionOperationHandler(
  operation: Pick<OperationContract, "key" | "handler">,
): ModuleOperationHandler {
  const run = HANDLERS[operation.handler];
  if (!run) {
    throw new Error(
      `Unknown core record-action handler "${operation.handler}" for "${operation.key}".`,
    );
  }
  return run;
}
