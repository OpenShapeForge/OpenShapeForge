// SPDX-License-Identifier: BUSL-1.1
/**
 * `Query.currentTenant` — the caller's OWN row in `platform.tenants`, and
 * nothing else.
 *
 * ══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
 *
 * `apps/web` renders the signed-in organisation's name in the app shell
 * (`lib/server/active-tenant-shell.ts`) and scopes reporting embeds by a stable
 * tenant key. Both facts live in `platform.tenants`, which had no read path at
 * all: the web app issued a `tenants(filter: …)` collection query the API has
 * never exposed, behind a feature flag whose "off" position substituted a
 * hard-coded name.
 *
 * ══ WHY IT IS NOT THE `tenants` COLLECTION THE WEB APP ASKED FOR ════════════
 *
 * `platform.tenants` is declared `generatedCrud: false` and `domainInternal:
 * true` precisely so it gets NO generated GraphQL or REST surface, and that is
 * not an oversight to work around. The tenant graph is per-tenant: every type on
 * it is fenced by a tenant predicate, and a registry whose rows ARE tenants has
 * no predicate to satisfy. A `tenants(filter: { … })` field would be a
 * cross-tenant enumeration surface on a per-tenant schema — a security defect,
 * as #293 says in as many words.
 *
 * `currentTenant` is a different thing wearing a similar name. It takes NO
 * arguments. There is no filter, no pagination, no id parameter — no way for a
 * caller to name a tenant other than the one its session already is. It is the
 * "viewer" shape: a field about the caller, not a query over a registry.
 *
 * ══ WHAT ACTUALLY ENFORCES THAT ═════════════════════════════════════════════
 *
 * Not the absence of an argument — that is only what makes the surface
 * inexpressive. The enforcement is the row-level-security policy the compiler
 * emits for this table from `tenantIdentityColumn: id`:
 *
 *     CREATE POLICY "tenants_tenant_registry" ON "platform"."tenants"
 *       USING (app.bypass_rls() OR ("id" = app.current_tenant()))
 *       WITH CHECK (app.bypass_rls());
 *
 * The read below runs inside `withDbSession`, which sets `app.tenant_id` from
 * the resolved session and does NOT set `app.bypass_rls`. So the first disjunct
 * is false and the policy reduces to `id = app.current_tenant()`: at most one
 * row, and it is the row whose id the caller already presented in its own `tid`
 * claim. Nothing is disclosed that the caller did not bring with it.
 *
 * The runtime connects as the restricted `openshapeforge_app` role
 * (NOSUPERUSER, NOBYPASSRLS — `db/migrations/app-role.ts`), and the table is
 * `FORCE ROW LEVEL SECURITY`, so the policy applies to this query the same way
 * it applies to every other read on this connection.
 *
 * The statement ALSO carries its own `where id = …` predicate. That is not
 * belt-and-braces decoration: it is what makes this resolver safe to call from a
 * session that has the bypass set. Under `app.bypass_rls()` the policy's first
 * disjunct is true and the table is fully visible — so a predicate-less
 * `select * from platform.tenants` would return THE WHOLE REGISTRY if this code
 * ever ran inside a system session. The predicate makes the query's scope a
 * property of the query rather than of its caller, and the two restrictions come
 * from the same place: `applyDbSession` writes `session.tenantId` into
 * `app.tenant_id`, which is exactly what `app.current_tenant()` reads back. If
 * they could somehow disagree the intersection would be empty, which is the
 * right way to fail.
 *
 * The predicate is a BOUND PARAMETER rather than a call to `app.current_tenant()`
 * in the query text, and that is forced rather than chosen: the restricted
 * runtime role holds EXECUTE on the `app.*` helpers but NOT `USAGE` on the `app`
 * schema (`provisionAppRole` grants it only if the schema already exists, and on
 * a fresh migrate it does not yet), so any application query naming `app.…`
 * fails with `permission denied for schema app`. Established by running this
 * resolver against a freshly migrated database as `openshapeforge_app`, not
 * inferred. The POLICY is unaffected — PostgreSQL evaluates RLS policy
 * expressions with the table owner's privileges, which is why every
 * `tenant_id = app.current_tenant()` policy in the schema works for a role that
 * cannot name the function itself.
 *
 * The asymmetric policy (`WITH CHECK (app.bypass_rls())`) means this path can
 * never write: every mutation of the registry goes through the control plane's
 * audited `withSystemSession`.
 *
 * ══ AUTHORIZATION ═══════════════════════════════════════════════════════════
 *
 * Authenticated, not role-gated — the same posture as `entityPageConfigs`, and
 * for a stronger reason: this returns facts about the caller's own tenant, which
 * every session in that tenant already possesses in its token (`tid`) or can
 * read off its own URL. A role gate here would make the app shell's title depend
 * on entity permissions.
 */
import { GraphQLError } from "graphql";
import { sql } from "kysely";
import { withDbSession } from "../db/session.js";
import type { GraphqlContext } from "./context.js";

/**
 * A deliberately narrow projection of the registry row.
 *
 * `keycloak_organization_id`, `keycloak_realm` and the timestamps are omitted:
 * they are control-plane bookkeeping, they say something about the deployment's
 * identity infrastructure rather than about the tenant, and no tenant-facing
 * screen has a use for them. `status` IS included, because a tenant's own
 * lifecycle state is something its UI may legitimately want to surface.
 */
export const currentTenantTypeDefs = /* GraphQL */ `
  """
  The signed-in session's own tenant. Takes no arguments and can never name
  another tenant; the row-level-security policy on the underlying registry
  restricts it to the session's own row.
  """
  type CurrentTenant {
    """
    The tenant UUID — the \`tid\` claim and the row-level-security key.
    Immutable, and therefore safe to sign into authorization-relevant
    parameters.
    """
    id: ID!
    """
    The URL and Keycloak Organization alias key. Immutable after creation.
    """
    slug: String!
    """
    The display name. MUTABLE — never use it as an identifier.
    """
    name: String!
    """The TENANTSTATUS lifecycle state: active, inactive or suspended."""
    status: String!
  }
`;

export const currentTenantQueryFields = `
  currentTenant: CurrentTenant
`;

type CurrentTenantRow = {
  id: string;
  slug: string;
  name: string;
  status: string;
};

/**
 * Null rather than an error when the session's tenant has no registry row.
 *
 * A deployment that predates the tenant registry has sessions whose `tid` names
 * no row, and the shell asking for a display name must not turn that into a 500
 * on every page. The caller decides what to do with the absence —
 * `active-tenant-shell.ts` renders no organisation label, while the reporting
 * key resolver refuses outright, which is the correct split: a missing label is
 * cosmetic, a missing scoping key is not.
 */
export async function resolveCurrentTenant(
  _parent: unknown,
  _args: unknown,
  context: GraphqlContext,
): Promise<CurrentTenantRow | null> {
  const session = context.session;
  if (!session?.tenantId || !session?.userId) {
    throw new GraphQLError("currentTenant requires an authenticated session.", {
      extensions: { code: "UNAUTHENTICATED", status: 401 },
    });
  }
  if (!context.db) {
    throw new GraphQLError("Database is not configured.", {
      extensions: { code: "DATABASE_NOT_CONFIGURED", status: 503 },
    });
  }

  return withDbSession(context.db, session, async (trx, dbSession) => {
    // `dbSession.tenantId`, not `session.tenantId`: the former is what
    // `createDbSessionContext` validated as a UUID and what `applyDbSession` put
    // into `app.tenant_id`, so the predicate and the policy are backed by
    // literally the same value. See the header for why this is a bound
    // parameter rather than `app.current_tenant()` in the query text.
    const result = await sql<CurrentTenantRow>`
      select id, slug, name, status
        from platform.tenants
       where id = ${dbSession.tenantId}::uuid
    `.execute(trx);
    return result.rows[0] ?? null;
  });
}
