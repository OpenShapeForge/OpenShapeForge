// SPDX-License-Identifier: BUSL-1.1
import { withRuntimeSpan } from "@openshapeforge/observability";
import { auditContext, runWithAuditContext, type AuditContext } from "../platform/audit-context.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { readStatementTimeoutMs } from "../config/limits.js";
import { actingRelationId, type ActingRelationSource } from "./acting-relation.js";
import { withReadBarrierDatabase } from "./read-barrier.js";
import { boundedReadTransaction } from "./bounded-read-transaction.js";

export type DbSessionScope = "tenant" | "group" | "self";

/**
 * What kind of principal the SERVER decided this session is.
 *
 * The named-action axis of the record ACL matches a subject kind against this
 * and nothing else, so it has to be derived from facts the server read, never
 * from anything a caller can assert:
 *
 *   person       verified bearer claims that are not a service account, or any
 *                carrier whose identity-Relation link was read back from
 *                `platform.identity_relations` (`verifiedAuditIdentity`)
 *   application  a resolved API-key integration, and only that
 *   service      a verified client-credentials principal with no integration
 *                behind it — organization automation included
 *   unknown      a carrier that states nothing and has no link to read
 *
 * `unknown` is spelled out rather than left empty so no consumer can read a
 * missing value as a permissive one. It holds no named action; neither does
 * `service`. None of this changes a role check, a scope or the view/edit/delete
 * permissions — those behave for every existing session exactly as before.
 */
export type DbPrincipalClass = "person" | "application" | "service" | "unknown";

const MAX_SESSION_GROUPS = 256;
const MAX_RELATION_GROUPS = 256;

// Closure expansion of the direct set (capped at MAX_SESSION_GROUPS) can
// legitimately grow far beyond it: a shallow-but-wide org tree turns one
// assigned root into its entire subtree. Cap each expanded set so a
// pathological hierarchy cannot inflate the `app.user_groups{,_ancestors}`
// GUCs (and the `= ANY(...)` array every group-scoped RLS check evaluates)
// without bound. Sized well above the direct cap to leave room for genuine
// expansion while still bounding GUC size and per-query cost.
const MAX_EXPANDED_SESSION_GROUPS = 4096;

export type DbSessionInput = {
  tenantId?: string | null;
  userId?: string | null;
  /** Trusted identity context retained by nested database work, never caller input. */
  auditIdentityId?: string | null;
  auditIssuer?: string | null;
  /**
   * Opaque binding to a verified interactive login session. This is control
   * metadata for canonical Operations and is deliberately not projected into
   * a PostgreSQL GUC or used as database authority.
   */
  loginSessionBinding?: string;
  /** Server-derived display label used only in safe, tenant-local messages. */
  userDisplayName?: string | null;
  roles?: readonly string[] | null;
  groups?: readonly string[] | null;
  /**
   * Server-derived active RelationGroup memberships. These are not Keycloak
   * groups and are never expanded through the platform org-unit hierarchy.
   */
  relationGroupIds?: readonly string[] | null;
  /**
   * The verified application this session acts as, when it acts as one
   * (auth/trusted-context.ts, {@link VerifiedAppPrincipal}). Only the API-key
   * carrier produces it; every other credential leaves it absent and the
   * `app.app_principal_id` GUC empty, so a record-action policy matches
   * nobody. Declared structurally so the database layer keeps no dependency
   * on the auth layer.
   */
  appPrincipal?: { integrationId: string } | null;
  /**
   * What the bearer verifier made of the token's claims, when the carrier
   * states it. Server-derived; a carrier that asserts nothing leaves it
   * undefined and is classified from the identity link instead, or not at all.
   */
  principalKind?: "person" | "service";
  scope?: DbSessionScope | null;
} & NonNullable<ActingRelationSource>;

export type DbSessionContext = {
  tenantId: string;
  userId: string;
  auditIdentityId?: string | null;
  auditIssuer?: string | null;
  roles: readonly string[];
  groups: readonly string[];
  relationGroupIds: readonly string[];
  /** The acting Relation (acting-relation.ts); `app.current_relation_id()`. */
  relationId: string | null;
  /** The verified application id; `app.current_app_principal()`. */
  appPrincipalId: string | null;
  /** The verified principal class; `app.current_principal_class()`. */
  principalClass: DbPrincipalClass;
  scope: DbSessionScope;
};

type DbSessionAfterCommitHook = () => Promise<void> | void;

const dbSessionHooks = new AsyncLocalStorage<{
  afterCommit: DbSessionAfterCommitHook[];
}>();

const activeDbSession = new AsyncLocalStorage<{
  db: Kysely<unknown>;
  trx: Transaction<unknown>;
  session: DbSessionContext;
  audit: AuditContext;
}>();

function resolveAuditSession(input: AuditContext | null | undefined = auditContext()): AuditContext {
  return input ?? { operationId: "", correlationId: crypto.randomUUID(), actorKind: "system" as const };
}

function auditSessionSettings(audit: AuditContext) {
  return [
    sql`set_config('app.audit_operation', ${audit.operationId}, true)`,
    sql`set_config('app.audit_correlation', ${audit.correlationId}, true)`,
    sql`set_config('app.audit_actor_kind', ${audit.actorKind}, true)`,
  ];
}

async function applyAuditSession<T>(trx: Transaction<T>, input: AuditContext | null | undefined): Promise<AuditContext> {
  const audit = resolveAuditSession(input);
  await sql`select ${sql.join(auditSessionSettings(audit))}`.execute(trx);
  return audit;
}

export function registerDbSessionAfterCommit(hook: DbSessionAfterCommitHook) {
  const store = dbSessionHooks.getStore();
  if (!store) return;
  store.afterCommit.push(hook);
}

/** The database that opened the active session, so nested readers reuse its transaction. */
export function currentDbSessionDatabase(): Kysely<unknown> | undefined {
  return activeDbSession.getStore()?.db;
}

/**
 * The sessions this module derived, as the objects it froze.
 *
 * Membership is the capability a rejoin requires ({@link rejoinActiveSession}).
 * Only {@link createDbSessionContext} adds to it, and a `WeakSet` holds no key
 * a caller can enumerate, copy or forge, so an object that is in it is one
 * this module built from a carrier's own facts — and nothing outside this
 * module can put one there or take one out.
 */
const derivedSessions = new WeakSet<DbSessionContext>();

/**
 * Freeze a derived session, and brand it as this module's.
 *
 * The derived session leaves this module in two places — the second argument
 * of every {@link withDbSession} callback, and {@link activeDbSessionContext}
 * — and both used to hand out the MUTABLE object the transaction's GUCs had
 * been written from. Editing one field of it (`tenantId`, `userId`, `roles`,
 * `principalClass`, `appPrincipalId`) changed what every service-level check
 * beside those GUCs then read, and handing it back with `independent: true`
 * opened a SECOND transaction whose settings were written from the edited
 * fields — with the nested fence below comparing the object against itself,
 * field by field, and agreeing every time.
 *
 * Frozen, that assignment throws (a module is strict code) instead of
 * succeeding quietly, and the three arrays are frozen too, so a `push` onto
 * `roles` is not the way around it either. The object stays the one the
 * carrier's facts produced, for as long as the transaction it opened lives.
 */
function sealSession(session: DbSessionContext): DbSessionContext {
  Object.freeze(session.roles);
  Object.freeze(session.groups);
  Object.freeze(session.relationGroupIds);
  Object.freeze(session);
  derivedSessions.add(session);
  return session;
}

/**
 * The session the active transaction on `db` was opened with, if any.
 *
 * For the one case {@link withDbSession} cannot serve: work that must run in
 * the caller's transaction but does not itself hold the context that
 * transaction was established from. Such a caller would have to REBUILD a
 * session from what it does hold — and a rebuilt session drops the identity
 * link, the audit identity and the RelationGroup memberships the resolver
 * put there, which is exactly the substitution the nested-session fence
 * below refuses. Asking for the active session instead and passing it back
 * verbatim joins the transaction without replacing anything in it.
 *
 * The same holds for the two fields the record ACL reads — the verified
 * application principal and the principal class. Both are DERIVED here from
 * what the carrier supplied ({@link resolvePrincipalClass}), and neither is a
 * field of this type, so re-deriving a session from a context would classify
 * a verified person with no Relation as `unknown` and strip an application
 * principal to null. {@link withDbSession} therefore recognises this exact
 * object and reuses it rather than deriving anything from it.
 *
 * What comes back is the FROZEN session ({@link sealSession}), so a caller
 * reads it and cannot edit it: an assignment to a field of it throws, and the
 * role, group and RelationGroup arrays are frozen as well. That matters here
 * more than anywhere else, because this object is the one a rejoin is
 * recognised by — an editable one would have made this accessor a way to
 * rewrite the active session's tenant, roles or principal class and then open
 * an independent transaction from the result.
 *
 * This is NOT an authorization source. It reports what the active database
 * session already is; a caller still decides on the session core verified
 * and handed it, and must satisfy itself that the two name the same
 * principal before joining (api-key/service.ts does both).
 */
export function activeDbSessionContext<TDatabase>(
  db: Kysely<TDatabase>,
): DbSessionContext | undefined {
  const active = activeDbSession.getStore();
  return active && active.db === (db as unknown as Kysely<unknown>) ? active.session : undefined;
}

/** RFC 4122 shape, the one every id this layer accepts must have. */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a UUID.`);
  }
}

function normalizeGroups(groups: readonly string[] | null | undefined): readonly string[] {
  if (!groups || groups.length === 0) return [];
  // Trusted-context now propagates Keycloak group PATHS (e.g.
  // "/customer/region/editors") for app-level authorization.
  // The DB session GUC `app.user_groups` only accepts UUIDs — path → org-unit
  // UUID translation is a separate concern. Silently filter the paths so the
  // session can still apply, while UUID groups (when present) flow through.
  const uuids = groups.filter(
    (groupId): groupId is string => typeof groupId === "string" && UUID_PATTERN.test(groupId),
  );
  if (uuids.length > MAX_SESSION_GROUPS) {
    throw new Error(
      `Database session has ${uuids.length} group UUIDs; cap is ${MAX_SESSION_GROUPS}. Tighten Keycloak group hygiene before retrying.`,
    );
  }
  return uuids;
}

function normalizeRelationGroupIds(
  groups: readonly string[] | null | undefined,
): readonly string[] {
  if (!groups || groups.length === 0) return [];
  if (groups.length > MAX_RELATION_GROUPS) {
    throw new Error(
      `Database session has ${groups.length} RelationGroup memberships; cap is ${MAX_RELATION_GROUPS}.`,
    );
  }
  const unique = [...new Set(groups)];
  for (const groupId of unique) assertUuid(groupId, "relationGroupId");
  return unique.sort();
}

function assertExpandedGroupsWithinCap(expanded: readonly string[], label: string) {
  if (expanded.length > MAX_EXPANDED_SESSION_GROUPS) {
    throw new Error(
      `Database session expanded to ${expanded.length}+ org units for ${label}; cap is ${MAX_EXPANDED_SESSION_GROUPS}. Assign a narrower org unit than a shallow, very wide subtree root.`,
    );
  }
}

function normalizeScope(scope: DbSessionScope | null | undefined): DbSessionScope {
  if (scope === "tenant" || scope === "group" || scope === "self") return scope;
  return "self";
}

export function verifiedAuditIdentity(input: DbSessionInput): { auditIdentityId: string | null; auditIssuer: string | null } {
  const link = input.relation as { identityId?: unknown; issuer?: unknown; subject?: unknown; status?: unknown } | undefined;
  if (link && ["linked", "pending_confirmation"].includes(String(link.status)) &&
      link.subject === input.userId && typeof link.identityId === "string" &&
      UUID_PATTERN.test(link.identityId) && typeof link.issuer === "string" && link.issuer) {
    return { auditIdentityId: link.identityId, auditIssuer: link.issuer };
  }
  // A nested database session already carries the verified identity context.
  if (input.auditIdentityId) {
    assertUuid(input.auditIdentityId, "auditIdentityId");
    return { auditIdentityId: input.auditIdentityId, auditIssuer: input.auditIssuer ?? null };
  }
  return { auditIdentityId: null, auditIssuer: null };
}

/**
 * The verified application id, or null. A malformed value is a programming
 * error here rather than a denial to be papered over: the only writer is the
 * API-key resolver, which reads a uuid primary key, so anything else means
 * some other path invented a principal.
 */
function normalizeAppPrincipalId(
  principal: { integrationId: string } | null | undefined,
): string | null {
  if (!principal) return null;
  assertUuid(principal.integrationId, "appPrincipal.integrationId");
  return principal.integrationId;
}

/**
 * Classify the session from server-sourced facts, most specific first.
 *
 * A resolved integration outranks the "service" kind its own token carries:
 * an API-key session is both, and `application` is the narrower, useful
 * answer. A stated kind outranks the identity link, so a verified service
 * account can never be re-read as a person by attaching a Relation to it.
 * The link is the fallback for carriers that state nothing — the web tier's
 * trusted-context bundle, which is how real people reach this code — and it
 * is itself a row this server read under RLS, not a claim.
 */
export function resolvePrincipalClass(input: DbSessionInput): DbPrincipalClass {
  if (input.appPrincipal) return "application";
  if (input.principalKind === "service") return "service";
  if (input.principalKind === "person") return "person";
  return verifiedAuditIdentity(input).auditIdentityId ? "person" : "unknown";
}

export function createDbSessionContext(input: DbSessionInput): DbSessionContext {
  if (!input.tenantId) {
    throw new Error("Database session is missing tenantId; refusing unscoped access.");
  }
  if (!input.userId) {
    throw new Error("Database session is missing userId; refusing anonymous access.");
  }

  assertUuid(input.tenantId, "tenantId");
  assertUuid(input.userId, "userId");

  return sealSession({
    tenantId: input.tenantId,
    userId: input.userId,
    ...verifiedAuditIdentity(input),
    // Copied before they are frozen: the carrier's arrays belong to the caller,
    // and freezing one would reach back out of this layer into code that is
    // entitled to keep editing its own.
    roles: [...(input.roles ?? [])],
    groups: [...normalizeGroups(input.groups)],
    relationGroupIds: [...normalizeRelationGroupIds(input.relationGroupIds)],
    relationId: actingRelationId(input),
    appPrincipalId: normalizeAppPrincipalId(input.appPrincipal),
    principalClass: resolvePrincipalClass(input),
    scope: normalizeScope(input.scope),
  });
}

export async function applyDbSession<TDatabase>(
  trx: Transaction<TDatabase>,
  session: DbSessionContext,
  options: { statementTimeoutMs?: number; sharedReadBarrier?: string } = {},
) {
  // Bound subsequent statements in this tenant-scoped transaction so an
  // accepted GraphQL/REST request cannot hold a database
  // connection indefinitely (issue #130). Transaction-local (`set_config(...,
  // true)`), so it is scoped to this request and reset on commit/rollback; it
  // also covers the closure-expansion queries below. The initial settings
  // statement itself, like BEGIN, runs before this limit takes effect.
  // 0 disables the override (dev/opt-out).
  const statementTimeoutMs = options.statementTimeoutMs ?? readStatementTimeoutMs();
  // A tenant session is never a continuation of a system session. Clear the
  // break-glass flag before any tenant-scoped lookup. This statement contains
  // only transaction-local settings: no row access runs until ALL have been
  // applied. Batch the round trips, not the authorization or audit checks.
  const audit = resolveAuditSession();
  const exact = [...session.groups];
  const settings = await sql<{ shared_read_marker?: boolean }>`select ${sql.join([
    ...(statementTimeoutMs > 0
      ? [sql`set_config('statement_timeout', ${String(statementTimeoutMs)}, true)`]
      : []),
    sql`set_config('app.bypass_rls', 'false', true)`,
    sql`set_config('app.shared_read_barrier', ${options.sharedReadBarrier ?? ''}, true)`,
    sql`set_config('app.tenant_id', ${session.tenantId}, true)`,
    sql`set_config('app.user_id', ${session.userId}, true)`,
    sql`set_config('app.audit_identity_id', ${session.auditIdentityId??''}, true)`,
    sql`set_config('app.audit_actor_issuer', ${session.auditIssuer??''}, true)`,
    ...auditSessionSettings(audit),
    sql`set_config('app.roles', ${session.roles.join(",")}, true)`,
    sql`set_config('app.scope', ${session.scope}, true)`,
    sql`set_config('app.relation_group_ids', ${session.relationGroupIds.join(",")}, true)`,
    sql`set_config('app.relation_id', ${session.relationId ?? ""}, true)`,
    // Always written, empty included: a transaction-local setting that is only
    // written when present would let one request's application principal be
    // observed by the next session opened on the same transaction.
    sql`set_config('app.app_principal_id', ${session.appPrincipalId ?? ""}, true)`,
    sql`set_config('app.principal_class', ${session.principalClass}, true)`,
    sql`set_config('app.user_groups', '', true)`,
    sql`set_config('app.user_groups_exact', '', true)`,
    sql`set_config('app.user_groups_ancestors', '', true)`,
  ])}${options.sharedReadBarrier ? sql`, pg_try_advisory_xact_lock_shared(hashtext('osf.read-barrier:shared-backend'), 0) as shared_read_marker` : sql``}`.execute(trx);
  if (options.sharedReadBarrier && !settings.rows[0]?.shared_read_marker) {
    throw new Error("Shared read metadata marker is unavailable.");
  }

  // Group expansion (§E.1/E.3). The user's DIRECT org-unit UUIDs
  // (session.groups — already UUID-filtered and capped at MAX_SESSION_GROUPS by
  // normalizeGroups) are expanded ONCE here, after the tenant GUC is set, into
  // three per-mode sets read by app.current_groups{,_exact,_ancestors}():
  //   descendants  → app.user_groups           (child units — closure ancestor→descendant)
  //   exact        → app.user_groups_exact      (the direct set, no expansion)
  //   ancestors    → app.user_groups_ancestors  (parent units — closure descendant→ancestor)
  // The emitted RLS policy compares against the already-expanded set, so the
  // hot policy path never joins the closure (STABLE-function InitPlan contract).
  //
  // PERF NOTE: up to two closure queries per withDbSession (exact needs none).
  // Acceptable for now; if it becomes hot, cache per (tenant, direct-set) or
  // fold into the identity resolver's session establishment.
  let descendants: string[] = [];
  let ancestors: string[] = [];
  if (exact.length > 0) {
    // The bun/kysely driver serializes a JS string[] as a bare comma-joined
    // scalar (no braces), which Postgres rejects for a uuid[] cast. Build the
    // Postgres array text literal `{a,b,...}` explicitly. Every element is a
    // validated UUID (normalizeGroups), so no escaping is required.
    const directLiteral = `{${exact.join(",")}}`;

    // Fetch one row beyond the cap so an over-large expansion is detected
    // without materializing the entire pathological subtree into JS.
    const descendantsResult = await sql<{ id: string }>`
      select distinct descendant_id as id
      from platform.org_unit_closure
      where tenant_id = ${session.tenantId}::uuid
        and ancestor_id = any(${directLiteral}::uuid[])
      limit ${MAX_EXPANDED_SESSION_GROUPS + 1}
    `.execute(trx);
    descendants = descendantsResult.rows.map((row) => row.id);
    assertExpandedGroupsWithinCap(descendants, "app.user_groups (descendants)");

    const ancestorsResult = await sql<{ id: string }>`
      select distinct ancestor_id as id
      from platform.org_unit_closure
      where tenant_id = ${session.tenantId}::uuid
        and descendant_id = any(${directLiteral}::uuid[])
      limit ${MAX_EXPANDED_SESSION_GROUPS + 1}
    `.execute(trx);
    ancestors = ancestorsResult.rows.map((row) => row.id);
    assertExpandedGroupsWithinCap(ancestors, "app.user_groups_ancestors (ancestors)");
  }

  if (exact.length > 0) await sql`select set_config('app.user_groups', ${descendants.join(",")}, true),
    set_config('app.user_groups_exact', ${exact.join(",")}, true),
    set_config('app.user_groups_ancestors', ${ancestors.join(",")}, true)`.execute(trx);
  return audit;
}

/**
 * The active session itself, when `input` IS it — otherwise undefined.
 *
 * It returns the session the active transaction on `db` was OPENED with rather
 * than the object the caller passed. Here those are the same object, so the
 * distinction looks idle and is not: it is what makes the answer independent
 * of the caller entirely, so no field of the returned session can have come
 * from anywhere but this module's own derivation.
 *
 * Identity is the capability, and it is one a caller cannot manufacture.
 * {@link activeDbSessionContext} is the only way to obtain the object, the
 * object is frozen ({@link sealSession}), and it is in
 * {@link derivedSessions}, which only {@link createDbSessionContext} writes.
 * A caller-shaped object, a spread, a prototype child and a context from a
 * different database are none of those things: they fall through to
 * {@link createDbSessionContext} and are then held to the nested fence below
 * exactly as before. This establishes no session either; a rejoin requires an
 * active one, by construction.
 */
function rejoinActiveSession<TDatabase>(
  db: Kysely<TDatabase>,
  input: DbSessionInput | DbSessionContext,
): DbSessionContext | undefined {
  const active = activeDbSession.getStore();
  if (!active || active.db !== (db as unknown as Kysely<unknown>)) return undefined;
  if ((input as unknown) !== active.session) return undefined;
  return derivedSessions.has(active.session) ? active.session : undefined;
}

export async function withDbSession<TDatabase, TResult>(
  db: Kysely<TDatabase>,
  input: DbSessionInput | DbSessionContext,
  callback: (trx: Transaction<TDatabase>, session: DbSessionContext) => Promise<TResult>,
  options: { isolationLevel?: "repeatable read" | "serializable"; independent?: boolean } = {},
): Promise<TResult> {
  // A rejoin reuses the derived session; everything else derives one. Nothing
  // is widened either way — the rejoined object is the one this function
  // derived when it opened the transaction being rejoined, taken from the
  // active store rather than from the caller.
  const rejoined = rejoinActiveSession(db, input);
  const session = rejoined ?? createDbSessionContext(input);
  const active = activeDbSession.getStore();
  if (active && active.db === db) {
    // A rejoin IS the active session — one frozen object, so there is nothing
    // to compare and no comparison that could be satisfied by editing it.
    // Everything else was derived from a carrier's own facts and has to name
    // the same principal, field for field.
    const sameSession = session === active.session ||
      (active.session.tenantId === session.tenantId &&
      active.session.userId === session.userId &&
      active.session.auditIdentityId === session.auditIdentityId &&
      active.session.auditIssuer === session.auditIssuer &&
      active.session.scope === session.scope &&
      active.session.roles.length === session.roles.length &&
      active.session.roles.every((role, index) => role === session.roles[index]) &&
      active.session.groups.length === session.groups.length &&
      active.session.groups.every((group, index) => group === session.groups[index]) &&
      active.session.relationGroupIds.length === session.relationGroupIds.length &&
      active.session.relationGroupIds.every(
        (group, index) => group === session.relationGroupIds[index],
      ) &&
      active.session.relationId === session.relationId &&
      active.session.appPrincipalId === session.appPrincipalId &&
      active.session.principalClass === session.principalClass);
    if (!sameSession) {
      throw new Error("Nested database work cannot replace the active session.");
    }
    if (!options.independent) {
      const audit = auditContext() ?? active.audit;
      const trx = active.trx as Transaction<TDatabase>;
      if (audit?.operationId === active.audit?.operationId && audit?.correlationId === active.audit?.correlationId && audit?.actorKind === active.audit?.actorKind) return callback(trx, active.session);
      await applyAuditSession(trx, audit);
      try {
        const result = await activeDbSession.run({ ...active, audit }, () => callback(trx, active.session));
        await applyAuditSession(trx, active.audit);
        return result;
      } catch (error) {
        // A caller's savepoint may need to recover an aborted transaction first.
        try { await applyAuditSession(trx, active.audit); } catch { /* Preserve the original failure. */ }
        throw error;
      }
    }
  }
  const hooks = { afterCommit: [] as DbSessionAfterCommitHook[] };

  const result = await withRuntimeSpan("database.session", () => dbSessionHooks.run(hooks, () => withReadBarrierDatabase(db, session.tenantId, (database, barrier) => {
    const transaction = options.isolationLevel
      ? database.transaction().setIsolationLevel(options.isolationLevel)
      : database.transaction();
    return transaction.execute(async (original) => {
      const execute = async (trx: Transaction<TDatabase>) => {
      const audit = await applyDbSession(trx, session, barrier ? {
        statementTimeoutMs: Math.min(readStatementTimeoutMs() || barrier.budgetMs, barrier.budgetMs),
        sharedReadBarrier: barrier.marker,
      } : {});
      return runWithAuditContext(audit, () => activeDbSession.run(
        {
          db: db as Kysely<unknown>,
          trx: trx as Transaction<unknown>,
          session,
          audit,
        },
        () => callback(trx, session),
      ));
      };
      return barrier ? boundedReadTransaction(original, barrier.budgetMs, barrier.isActive, barrier.retain, execute) : execute(original);
    });
  })));

  for (const hook of hooks.afterCommit) {
    await hook();
  }

  return result;
}

let savepoints = 0;

/**
 * Run work inside its own savepoint, so that its failure discards exactly
 * what it did and nothing of the transaction it is part of.
 *
 * This is what makes one invocation's failure its own. A canonical Operation
 * invoked from inside another one JOINS the caller's transaction
 * ({@link withDbSession} above), consumes this request's mutation controls —
 * an edit lease, a single-use confirmation challenge — writes its rows, and
 * may then be refused or fail. Callers that turn such a failure into an
 * ordinary error result (the entity runtime, the Operations API) would
 * otherwise leave those consumed controls and partial writes in the caller's
 * transaction, to be committed with work that has nothing to do with them.
 *
 * On success the savepoint is released and the work commits with its caller,
 * exactly as before. On failure the rollback also recovers a transaction the
 * database itself aborted, so the caller's earlier work survives a nested
 * failure and its later work can still commit.
 */
export async function withInvocationSavepoint<TDatabase, TResult>(
  trx: Transaction<TDatabase>,
  work: () => Promise<TResult>,
): Promise<TResult> {
  savepoints = (savepoints + 1) % Number.MAX_SAFE_INTEGER;
  const savepoint = sql.raw(`osf_invocation_${savepoints}`);
  await sql`savepoint ${savepoint}`.execute(trx);
  try {
    const result = await work();
    await sql`release savepoint ${savepoint}`.execute(trx);
    return result;
  } catch (error) {
    try {
      await sql`rollback to savepoint ${savepoint}`.execute(trx);
      await sql`release savepoint ${savepoint}`.execute(trx);
    } catch {
      // The connection or transaction is gone; the original failure is what
      // the caller has to see, not this one.
    }
    throw error;
  }
}

/**
 * A tenant-scoped transaction with NO user identity, for the one caller that
 * cannot have one yet: API key resolution.
 *
 * `withDbSession` refuses a session without a user, and it is right to — every
 * other caller in the system has already authenticated by the time it opens a
 * transaction. Credential resolution is the exception by construction: it reads
 * the integration row in order to PRODUCE an identity, so requiring one first
 * is circular. The tenant is already known at that point (it comes from the
 * credential row, which carries no RLS of its own), so the tenant policy can
 * still be satisfied.
 *
 * This is strictly narrower than `withSystemSession`: RLS stays ON and the
 * tenant GUC is set, so the callback sees exactly one tenant's rows. It grants
 * no cross-tenant reach and therefore writes no bypass audit row. Do not reach
 * for it anywhere an authenticated session is available — it exists to close a
 * bootstrap gap, not to skip supplying a user.
 */
export async function withCredentialResolutionSession<TDatabase, TResult>(
  db: Kysely<TDatabase>,
  tenantId: string,
  callback: (trx: Transaction<TDatabase>) => Promise<TResult>,
): Promise<TResult> {
  assertUuid(tenantId, "tenantId");

  return db.transaction().execute(async (trx) => {
    const statementTimeoutMs = readStatementTimeoutMs();
    if (statementTimeoutMs > 0) {
      await sql`select set_config('statement_timeout', ${String(statementTimeoutMs)}, true)`.execute(
        trx,
      );
    }
    await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
    // Deliberately no app.user_id, no app.roles, no app.scope, no
    // app.principal_class and no
    // app.app_principal_id: nothing this callback reads is user-, role- or
    // application-predicated, and setting a placeholder would make a later
    // rowScope or record-action policy silently match the wrong rows. The
    // application principal is an OUTPUT of this resolution, not an input.
    return callback(trx);
  });
}

export const SYSTEM_BYPASS_ROLE = "Platform.SystemBypass";

export type SystemSessionInput = {
  /**
   * The acting subject — typically a service-account user id from
   * Keycloak. Audit rows record this.
   */
  actorSubject: string;
  /** Optional internal UUID actor for SQL policies; audit keeps actorSubject. */
  databaseActorId?: string;
  /**
   * Roles the actor presents. Must include SYSTEM_BYPASS_ROLE or
   * withSystemSession throws BEFORE any SQL runs.
   */
  roles: readonly string[];
  /**
   * Free-text reason logged in the audit row. Required — operators have
   * to justify every bypass invocation.
   */
  reason: string;
  /**
   * Tenant context for the bypass session. RLS is disabled inside, but
   * the GUC is still set so any code that reads it (e.g. for partition
   * routing) keeps working.
   */
  tenantId?: string | null;
};

export type SystemSessionAuditContext = {
  /** The row written for this invocation; useful when an audit read must omit itself. */
  auditId: string;
  startedAt: string;
};

/**
 * Break-glass wrapper that disables RLS for the duration of the callback.
 * Use ONLY for:
 *   - Migration runners (DDL contexts).
 *   - Bulk ingest pipelines where row-by-row policy evaluation would
 *     dominate cost AND the input is trusted.
 *   - Analytics queries that legitimately span tenants AND the caller
 *     holds SYSTEM_BYPASS_ROLE.
 *
 * Refuses to run if the actor does not hold SYSTEM_BYPASS_ROLE. Writes
 * an audit row before AND after the callback so partial failures are
 * still traced.
 */
export async function withSystemSession<TDatabase, TResult>(
  db: Kysely<TDatabase>,
  input: SystemSessionInput,
  callback: (
    trx: Transaction<TDatabase>,
    audit: SystemSessionAuditContext,
  ) => Promise<TResult>,
): Promise<TResult> {
  if (!input.roles.includes(SYSTEM_BYPASS_ROLE)) {
    throw new Error(
      `withSystemSession requires role ${SYSTEM_BYPASS_ROLE}; actor ${input.actorSubject} does not hold it.`,
    );
  }
  if (!input.reason || input.reason.trim().length === 0) {
    throw new Error("withSystemSession requires a non-empty reason for audit logging.");
  }
  if (input.databaseActorId !== undefined)
    assertUuid(input.databaseActorId, "databaseActorId");

  // A per-invocation audit id. Keying start/end on this uuid (the table PK)
  // instead of (actor_subject, started_at) keeps two concurrent same-actor
  // bypass sessions that begin in the same millisecond from sharing — and
  // cross-contaminating — an audit row. It also makes the failure-path
  // `on conflict (id)` below meaningful (the PK is the conflict target).
  const auditId = randomUUID();
  const startedAt = new Date().toISOString();
  let endedAt: string | undefined;
  let succeeded = false;

  try {
    return await db.transaction().execute(async (trx) => {
      if (input.tenantId) {
        assertUuid(input.tenantId, "tenantId");
        await sql`select set_config('app.tenant_id', ${input.tenantId}, true)`.execute(trx);
      }
      await sql`select set_config('app.user_id', ${input.databaseActorId ?? input.actorSubject}, true)`.execute(trx);
      const audit = auditContext();
      const appliedAudit = await applyAuditSession(trx, audit ? { ...audit, actorKind: "system" } : null);
      await sql`select set_config('app.roles', ${input.roles.join(",")}, true)`.execute(trx);
      await sql`select set_config('app.bypass_rls', 'true', true), set_config('app.shared_read_barrier', '', true)`.execute(trx);

      await sql`
        insert into platform.system_bypass_audit
          (id, actor_subject, reason, started_at, tenant_id)
        values
          (${auditId}, ${input.actorSubject}, ${input.reason}, ${startedAt}, ${input.tenantId ?? null})
      `.execute(trx);

      const result = await runWithAuditContext(appliedAudit, () => callback(trx, { auditId, startedAt }));
      succeeded = true;
      endedAt = new Date().toISOString();

      await sql`
        update platform.system_bypass_audit
          set ended_at = ${endedAt}, succeeded = true
          where id = ${auditId}
      `.execute(trx);

      return result;
    });
  } finally {
    if (!succeeded) {
      endedAt = endedAt ?? new Date().toISOString();
      try {
        await sql`
          insert into platform.system_bypass_audit
            (id, actor_subject, reason, started_at, ended_at, succeeded, tenant_id)
          values
            (${auditId}, ${input.actorSubject}, ${input.reason}, ${startedAt}, ${endedAt}, false, ${input.tenantId ?? null})
          on conflict (id) do nothing
        `.execute(db);
      } catch {
        // best effort — if even the audit insert fails (DB down), we have
        // already lost the transaction. Keep silent.
      }
    }
  }
}
