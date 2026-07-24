import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";

export type DbSessionScope = "tenant" | "group" | "self";

const MAX_SESSION_GROUPS = 256;

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
  roles?: readonly string[] | null;
  groups?: readonly string[] | null;
  scope?: DbSessionScope | null;
};

export type DbSessionContext = {
  tenantId: string;
  userId: string;
  roles: readonly string[];
  groups: readonly string[];
  scope: DbSessionScope;
};

type DbSessionAfterCommitHook = () => Promise<void> | void;

const dbSessionHooks = new AsyncLocalStorage<{
  afterCommit: DbSessionAfterCommitHook[];
}>();

export function registerDbSessionAfterCommit(hook: DbSessionAfterCommitHook) {
  const store = dbSessionHooks.getStore();
  if (!store) return;
  store.afterCommit.push(hook);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a UUID.`);
  }
}

function normalizeGroups(groups: readonly string[] | null | undefined): readonly string[] {
  if (!groups || groups.length === 0) return [];
  // Trusted-context now propagates Keycloak group PATHS (e.g.
  // "/openshapeforge-demo/tenant-acme/role-directie") for app-level authorization.
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

export function createDbSessionContext(input: DbSessionInput): DbSessionContext {
  if (!input.tenantId) {
    throw new Error("Database session is missing tenantId; refusing unscoped access.");
  }
  if (!input.userId) {
    throw new Error("Database session is missing userId; refusing anonymous access.");
  }

  assertUuid(input.tenantId, "tenantId");
  assertUuid(input.userId, "userId");

  return {
    tenantId: input.tenantId,
    userId: input.userId,
    roles: input.roles ?? [],
    groups: normalizeGroups(input.groups),
    scope: normalizeScope(input.scope),
  };
}

export async function applyDbSession<TDatabase>(
  trx: Transaction<TDatabase>,
  session: DbSessionContext,
) {
  await sql`select set_config('app.tenant_id', ${session.tenantId}, true)`.execute(trx);
  await sql`select set_config('app.user_id', ${session.userId}, true)`.execute(trx);
  await sql`select set_config('app.roles', ${session.roles.join(",")}, true)`.execute(trx);
  await sql`select set_config('app.scope', ${session.scope}, true)`.execute(trx);

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
  const exact = [...session.groups];
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

  await sql`select set_config('app.user_groups', ${descendants.join(",")}, true)`.execute(trx);
  await sql`select set_config('app.user_groups_exact', ${exact.join(",")}, true)`.execute(trx);
  await sql`select set_config('app.user_groups_ancestors', ${ancestors.join(",")}, true)`.execute(trx);
}

export async function withDbSession<TDatabase, TResult>(
  db: Kysely<TDatabase>,
  input: DbSessionInput,
  callback: (trx: Transaction<TDatabase>, session: DbSessionContext) => Promise<TResult>,
): Promise<TResult> {
  const session = createDbSessionContext(input);
  const hooks = { afterCommit: [] as DbSessionAfterCommitHook[] };

  const result = await dbSessionHooks.run(hooks, () =>
    db.transaction().execute(async (trx) => {
      await applyDbSession(trx, session);
      return callback(trx, session);
    }),
  );

  for (const hook of hooks.afterCommit) {
    await hook();
  }

  return result;
}

export const SYSTEM_BYPASS_ROLE = "Platform.SystemBypass";

export type SystemSessionInput = {
  /**
   * The acting subject — typically a service-account user id from
   * Keycloak. Audit rows record this.
   */
  actorSubject: string;
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
  callback: (trx: Transaction<TDatabase>) => Promise<TResult>,
): Promise<TResult> {
  if (!input.roles.includes(SYSTEM_BYPASS_ROLE)) {
    throw new Error(
      `withSystemSession requires role ${SYSTEM_BYPASS_ROLE}; actor ${input.actorSubject} does not hold it.`,
    );
  }
  if (!input.reason || input.reason.trim().length === 0) {
    throw new Error("withSystemSession requires a non-empty reason for audit logging.");
  }

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
      await sql`select set_config('app.user_id', ${input.actorSubject}, true)`.execute(trx);
      await sql`select set_config('app.roles', ${input.roles.join(",")}, true)`.execute(trx);
      await sql`select set_config('app.bypass_rls', 'true', true)`.execute(trx);

      await sql`
        insert into platform.system_bypass_audit
          (id, actor_subject, reason, started_at, tenant_id)
        values
          (${auditId}, ${input.actorSubject}, ${input.reason}, ${startedAt}, ${input.tenantId ?? null})
      `.execute(trx);

      const result = await callback(trx);
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
