// SPDX-License-Identifier: BUSL-1.1
/**
 * Regression guard for the security finding: the app must connect as a
 * NON-superuser role so `FORCE ROW LEVEL SECURITY` is actually enforced by
 * Postgres, not merely by the app-layer WHERE clause.
 *
 * The test runs the full migration chain (which provisions the cluster-wide
 * `openshapeforge_app` role) against a throwaway SCRATCH database, then connects
 * to that same scratch DB AS openshapeforge_app and asserts:
 *
 *   (a) current_setting('is_superuser') = 'off' — the role is restricted;
 *   (b) with app.tenant_id set to tenant B, a RAW count over a row inserted
 *       under tenant A returns 0. The count query carries NO app-layer tenant
 *       filter, so a 0 result proves RLS itself blocked the cross-tenant read.
 *
 * If (b) ever returns >0, the app role has regained RLS-bypass (superuser /
 * rolbypassrls) or a policy was dropped — exactly the finding this guards.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db/__tests__/rls-enforcement.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import { rlsBypassToken, rlsBypassTokenDigest } from "../rls-bypass.js";

/**
 * Privileged admin URL (superuser) used to create/drop the scratch database
 * and run the migration chain. Mirrors migrations.test.ts: the `postgres`
 * maintenance DB owned by the privileged `openshapeforge` role. The migrate chain
 * needs CREATE ROLE + DDL + GRANT, so it must be the privileged role — NOT the
 * restricted DATABASE_URL / OPENSHAPEFORGE_MIGRATE_DATABASE_URL (which points at
 * openshapeforge_dev and is guarded against below).
 */
const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 90_000;

function scratchAdminUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  url.pathname = `/${name}`;
  return url.toString();
}

/** Same scratch DB, but connecting AS the restricted openshapeforge_app role. */
function scratchAppUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.username = APP_ROLE;
  url.password = APP_ROLE_PASSWORD;
  url.pathname = `/${name}`;
  return url.toString();
}

async function withScratchDb<T>(fn: (name: string) => Promise<T>): Promise<T> {
  const name = `rls_enforcement_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`unsafe scratch database name: ${name}`);
  }
  const admin = new SQL(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
    try {
      return await fn(name);
    } finally {
      // FORCE (Postgres 13+) kills any straggling scratch connections. The
      // openshapeforge_app ROLE is cluster-wide and intentionally left in place —
      // it is the real app role, provisioned idempotently by every migrate.
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.close();
  }
}

async function withDb<T>(
  url: string,
  fn: (db: Kysely<DB>) => Promise<T>,
): Promise<T> {
  const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 1 });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

describe("RLS enforcement against the restricted app role", () => {
  test(
    "openshapeforge_app is non-superuser and RLS blocks cross-tenant reads",
    async () => {
      await withScratchDb(async (name) => {
        // Run the full chain as the privileged role — this provisions the
        // cluster-wide openshapeforge_app role and grants it access.
        await withDb(scratchAdminUrl(name), (db) =>
          db.connection().execute((conn) => runMigrationChain(conn)),
        );

        // Now connect AS openshapeforge_app and prove RLS is real.
        await withDb(scratchAppUrl(name), async (db) => {
          // (a) The runtime role must NOT be a superuser.
          const superuser = await sql<{ is_superuser: string }>`
            select current_setting('is_superuser') as is_superuser
          `.execute(db);
          expect(superuser.rows[0]?.is_superuser).toBe("off");

          const tenantA = randomUUID();
          const tenantB = randomUUID();
          const marker = `rls-probe-${randomUUID().slice(0, 8)}`;

          // Insert a row for tenant A with the matching GUC set.
          await db.connection().execute(async (conn) => {
            await sql`select set_config('app.tenant_id', ${tenantA}, false)`.execute(conn);
            await sql`
              insert into erp.relations (id, tenant_id, display_name, relation_type)
              values (gen_random_uuid(), ${tenantA}::uuid, ${marker}, ${"person"})
            `.execute(conn);

            // Sanity: with tenant A's GUC, the row is visible.
            const sameTenant = await sql<{ n: number }>`
              select count(*)::int as n from erp.relations where display_name = ${marker}
            `.execute(conn);
            expect(sameTenant.rows[0]?.n).toBe(1);

            // (b) Switch the tenant GUC to a DIFFERENT tenant and run a RAW
            // count with NO tenant filter. RLS — not any app-layer WHERE —
            // must hide the row. This is the exact regression guard.
            await sql`select set_config('app.tenant_id', ${tenantB}, false)`.execute(conn);
            const crossTenant = await sql<{ n: number }>`
              select count(*)::int as n from erp.relations where display_name = ${marker}
            `.execute(conn);
            expect(crossTenant.rows[0]?.n).toBe(0);

            // (c) The runtime role cannot lift RLS by naming the setting. This
            // is the statement an injection would send: before the bypass
            // became a credential it returned every tenant's rows.
            const probe = async (value: string) => {
              await sql`select set_config('app.bypass_rls', ${value}, false)`.execute(conn);
              const seen = await sql<{ n: number; bypass: boolean }>`
                select count(*)::int as n, app.bypass_rls() as bypass
                  from erp.relations where display_name = ${marker}
              `.execute(conn);
              return seen.rows[0];
            };
            await expect(probe("true")).rejects.toThrow("is not accepted from a runtime database role");
            // A relation of the runtime role's own making cannot vouch for it:
            // the role check reads pg_catalog.pg_roles, never a temporary
            // table that calls the session a superuser.
            await sql.raw(`create temp table pg_roles as
              select oid, rolname, true as rolsuper from pg_catalog.pg_roles where rolname = session_user`).execute(conn);
            await expect(probe("true")).rejects.toThrow("is not accepted from a runtime database role");
            await sql`select set_config('search_path', 'pg_temp, app, public', false)`.execute(conn);
            await expect(probe("true")).rejects.toThrow("is not accepted from a runtime database role");
            // Nor can temporary types or a search_path that puts pg_temp ahead
            // of pg_catalog stand in for anything the policy helper names.
            await sql.raw(`create domain pg_temp.text as pg_catalog.text; create domain pg_temp.bool as pg_catalog.bool;
              create domain pg_temp.name as pg_catalog.name; create temp table pg_proc as select 1 as oid`).execute(conn);
            await sql`select set_config('search_path', 'pg_temp, pg_catalog, app', false)`.execute(conn);
            await expect(probe("true")).rejects.toThrow("is not accepted from a runtime database role");
            expect(await probe("not-the-credential")).toEqual({ n: 0, bypass: false });
            await sql.raw(`reset search_path; drop table pg_temp.pg_roles; drop table pg_temp.pg_proc;
              drop domain pg_temp.text; drop domain pg_temp.bool; drop domain pg_temp.name`).execute(conn);
            // Swallowing the refusal yields nothing either: the statement that
            // would have read the rows is the one that fails.
            await sql`select set_config('app.bypass_rls', 'true', false)`.execute(conn);
            await sql.raw(`do $probe$ declare seen integer; begin
              select count(*) into seen from erp.relations;
              raise exception 'leaked % rows', seen;
            exception when insufficient_privilege then null; end $probe$`).execute(conn);
            expect(await probe("TRUE")).toEqual({ n: 0, bypass: false });
            expect(await probe("on")).toEqual({ n: 0, bypass: false });
            // The digest baked into the function is readable; presenting it
            // (or its preimage's neighbours) is not the credential.
            const digest = await sql<{ source: string }>`
              select prosrc as source from pg_proc where oid = 'app.bypass_rls()'::regprocedure
            `.execute(conn);
            const stored = /decode\('([0-9a-f]{64})'/.exec(digest.rows[0]?.source ?? "")?.[1];
            expect(stored).toBe(rlsBypassTokenDigest());
            expect(await probe(stored!)).toEqual({ n: 0, bypass: false });
            // The runtime role cannot become a role the policies would trust.
            await expect(sql`select set_config('role', 'openshapeforge', false)`.execute(conn)).rejects.toThrow();
            // (d) The operator credential, which never enters the database
            // except as a bound value in a bypass session, is what lifts it.
            expect(await probe(rlsBypassToken())).toEqual({ n: 1, bypass: true });
            expect(await probe("false")).toEqual({ n: 0, bypass: false });

            // (d2) A SECURITY DEFINER function owned by a role outside the
            // declared set may still raise the literal for its own statement —
            // the shape plugin SQL uses. The runtime role can neither create
            // such a function nor become its owner.
            const definerOwner = `rls_probe_owner_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
            await withDb(scratchAdminUrl(name), (admin) => admin.connection().execute(async (owner) => {
              await sql.raw(`
                create role ${definerOwner} nologin nosuperuser nobypassrls noinherit;
                grant usage on schema app, erp to ${definerOwner};
                grant select on erp.relations to ${definerOwner};
                create function app.rls_probe_definer(marker text) returns integer
                language plpgsql security definer set search_path = pg_catalog as $fn$
                declare found integer;
                begin
                  perform set_config('app.bypass_rls', 'true', true);
                  select count(*) into found from erp.relations r where r.display_name = marker;
                  perform set_config('app.bypass_rls', 'false', true);
                  return found;
                end $fn$;
                alter function app.rls_probe_definer(text) owner to ${definerOwner};
                grant execute on function app.rls_probe_definer(text) to ${APP_ROLE};
              `).execute(owner);
            }));
            try {
              await sql`select set_config('app.tenant_id', ${tenantB}, false)`.execute(conn);
              const viaDefiner = await sql<{ n: number; bypass: boolean }>`
                select app.rls_probe_definer(${marker}) as n, app.bypass_rls() as bypass
              `.execute(conn);
              expect(viaDefiner.rows[0]).toEqual({ n: 1, bypass: false });
            } finally {
              await withDb(scratchAdminUrl(name), (admin) => admin.connection().execute(async (owner) => {
                await sql.raw(`drop function app.rls_probe_definer(text); drop owned by ${definerOwner}; drop role ${definerOwner};`).execute(owner);
              }));
            }

            // The pre-tenant point lookups answer without any bypass setting.
            await sql`select set_config('app.tenant_id', '', false)`.execute(conn);
            const lookups = await sql<{ key: string | null; grant: string | null }>`
              select app.api_key_tenant(${"absent"}) as key, app.capability_grant_tenant(${randomUUID()}::uuid) as grant
            `.execute(conn);
            expect(lookups.rows[0]).toEqual({ key: null, grant: null });
          });

          // (d3) A per-workload login that is only a MEMBER of the app role is
          // a runtime login too: it reads under the app role's policies and
          // cannot name the literal either.
          const member = `rls_probe_member_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
          await withDb(scratchAdminUrl(name), (admin) => sql.raw(
            `create role ${member} login password '${APP_ROLE_PASSWORD}' nosuperuser nobypassrls; grant ${APP_ROLE} to ${member};`,
          ).execute(admin));
          try {
            const memberUrl = new URL(scratchAppUrl(name));
            memberUrl.username = member;
            await withDb(memberUrl.toString(), (asMember) => asMember.connection().execute(async (conn) => {
              await sql`select set_config('app.tenant_id', ${tenantB}, false), set_config('app.bypass_rls', 'true', false)`.execute(conn);
              const runtime = await sql<{ runtime: boolean }>`select app.session_is_runtime_login() as runtime`.execute(conn);
              expect(runtime.rows[0]?.runtime).toBe(true);
              await expect(sql`select count(*)::int as n from erp.relations where display_name = ${marker}`.execute(conn))
                .rejects.toThrow("is not accepted from a runtime database role");
            }));
          } finally {
            await withDb(scratchAdminUrl(name), (admin) => sql.raw(`drop owned by ${member}; drop role ${member};`).execute(admin));
          }

          // (e) 'true' still serves a connection that did not LOG IN as a
          // runtime role — the migrate role acting as the app role here — so
          // migrations and administrator seeds keep working.
          await withDb(scratchAdminUrl(name), (admin) => admin.connection().execute(async (conn) => {
            await sql`select set_config('role', ${APP_ROLE}, false), set_config('app.tenant_id', ${tenantB}, false)`.execute(conn);
            const before = await sql<{ n: number }>`select count(*)::int as n from erp.relations where display_name = ${marker}`.execute(conn);
            expect(before.rows[0]?.n).toBe(0);
            await sql`select set_config('app.bypass_rls', 'true', false)`.execute(conn);
            const after = await sql<{ n: number }>`select count(*)::int as n from erp.relations where display_name = ${marker}`.execute(conn);
            expect(after.rows[0]?.n).toBe(1);
          }));
        });
      });
    },
    TEST_TIMEOUT,
  );

  /**
   * §F.4 — owner-axis RLS proof. The owner axis emits (empty:public):
   *   app.bypass_rls() OR (tenant_id = app.current_tenant()
   *     AND ("owner_id" = app.current_user_id() OR "owner_id" IS NULL))
   * and (empty:restricted) the same without the OR-NULL branch. We create two
   * throwaway fixture tables in the scratch DB carrying exactly those policies
   * and prove visibility with RAW count(*) (no app-layer WHERE) — a count is
   * RLS-enforced, so the numbers themselves are the proof.
   */
  test(
    "owner axis: empty:public keeps unowned rows visible, hides other users' owned rows; empty:restricted hides unowned; bypass sees all",
    async () => {
      const tenant = randomUUID();
      const userA = randomUUID();
      const userB = randomUUID();

      await withScratchDb(async (name) => {
        // Run the chain AND create+seed the fixture tables as the privileged
        // role (it holds CREATE on erp and, as superuser, bypasses RLS so the
        // cross-user seed rows land without WITH CHECK interference).
        await withDb(scratchAdminUrl(name), async (db) => {
          await db.connection().execute((conn) => runMigrationChain(conn));

          await db.connection().execute(async (conn) => {
            // ── Fixture tables with the generated owner policies ──
            // empty:public → owner axis + OR-NULL branch.
            await sql`
              create table erp.owner_public_fixture (
                id uuid primary key default gen_random_uuid(),
                tenant_id uuid not null,
                owner_id uuid,
                marker text not null
              )
            `.execute(conn);
            await sql`alter table erp.owner_public_fixture enable row level security`.execute(conn);
            await sql`alter table erp.owner_public_fixture force row level security`.execute(conn);
            await sql`
              create policy owner_public_fixture_row_scope on erp.owner_public_fixture
                using (app.bypass_rls() or (tenant_id = app.current_tenant()
                  and ("owner_id" = app.current_user_id() or "owner_id" is null)))
                with check (app.bypass_rls() or (tenant_id = app.current_tenant()
                  and ("owner_id" = app.current_user_id() or "owner_id" is null)))
            `.execute(conn);

            // empty:restricted → owner axis only (no OR-NULL).
            await sql`
              create table erp.owner_restricted_fixture (
                id uuid primary key default gen_random_uuid(),
                tenant_id uuid not null,
                owner_id uuid,
                marker text not null
              )
            `.execute(conn);
            await sql`alter table erp.owner_restricted_fixture enable row level security`.execute(conn);
            await sql`alter table erp.owner_restricted_fixture force row level security`.execute(conn);
            await sql`
              create policy owner_restricted_fixture_row_scope on erp.owner_restricted_fixture
                using (app.bypass_rls() or (tenant_id = app.current_tenant()
                  and ("owner_id" = app.current_user_id())))
                with check (app.bypass_rls() or (tenant_id = app.current_tenant()
                  and ("owner_id" = app.current_user_id())))
            `.execute(conn);

            // Grant the restricted app role read/write on the fixtures so it can
            // run the RLS-enforced count(*) probes below.
            await sql.raw(
              `grant select, insert, update, delete on erp.owner_public_fixture, erp.owner_restricted_fixture to ${APP_ROLE}`,
            ).execute(conn);

            // owner_public: an unowned row (owner_id NULL) + a row owned by A.
            await sql`
              insert into erp.owner_public_fixture (tenant_id, owner_id, marker)
              values (${tenant}::uuid, null, ${"pub-unowned"}),
                     (${tenant}::uuid, ${userA}::uuid, ${"pub-owned-a"})
            `.execute(conn);
            // owner_restricted: an unowned row + a row owned by A.
            await sql`
              insert into erp.owner_restricted_fixture (tenant_id, owner_id, marker)
              values (${tenant}::uuid, null, ${"res-unowned"}),
                     (${tenant}::uuid, ${userA}::uuid, ${"res-owned-a"})
            `.execute(conn);
          });
        });

        // Now connect AS the restricted openshapeforge_app role and prove the owner
        // policy with RAW count(*) (no app-layer WHERE on owner/tenant).
        await withDb(scratchAppUrl(name), async (db) => {
          await db.connection().execute(async (conn) => {
            const countPublic = async (marker: string) => {
              const r = await sql<{ n: number }>`
                select count(*)::int as n from erp.owner_public_fixture where marker = ${marker}
              `.execute(conn);
              return r.rows[0]?.n ?? -1;
            };
            const countRestricted = async (marker: string) => {
              const r = await sql<{ n: number }>`
                select count(*)::int as n from erp.owner_restricted_fixture where marker = ${marker}
              `.execute(conn);
              return r.rows[0]?.n ?? -1;
            };
            const setSession = async (userId: string, scope: string, bypass: boolean) => {
              await sql`select set_config('app.tenant_id', ${tenant}, false)`.execute(conn);
              await sql`select set_config('app.user_id', ${userId}, false)`.execute(conn);
              await sql`select set_config('app.scope', ${scope}, false)`.execute(conn);
              await sql`select set_config('app.bypass_rls', ${bypass ? rlsBypassToken() : "false"}, false)`.execute(conn);
            };

            // ── As user A, scope=self (no bypass) ──
            await setSession(userA, "self", false);
            // empty:public — unowned row visible to A; A's owned row visible.
            expect(await countPublic("pub-unowned")).toBe(1);
            expect(await countPublic("pub-owned-a")).toBe(1);
            // empty:restricted — unowned row HIDDEN; A's owned row visible.
            expect(await countRestricted("res-unowned")).toBe(0);
            expect(await countRestricted("res-owned-a")).toBe(1);

            // ── As user B, scope=self (no bypass) ──
            await setSession(userB, "self", false);
            // empty:public — unowned still visible to B (public); A's owned row
            // invisible to B (cross-user isolation, raw count 0).
            expect(await countPublic("pub-unowned")).toBe(1);
            expect(await countPublic("pub-owned-a")).toBe(0);
            // empty:restricted — unowned hidden; A's owned row invisible to B.
            expect(await countRestricted("res-unowned")).toBe(0);
            expect(await countRestricted("res-owned-a")).toBe(0);

            // ── app.scope='tenant' (no bypass_rls) ──
            // NOTE: the owner policy here does NOT include a has_scope('tenant')
            // branch (deriveRowScope omits bypassRoles in Phase 1), so tenant
            // scope alone does NOT widen owner visibility. The break-glass path
            // is app.bypass_rls(). Prove that distinction precisely.
            await setSession(userB, "tenant", false);
            expect(await countPublic("pub-owned-a")).toBe(0);
            expect(await countRestricted("res-owned-a")).toBe(0);

            // ── Bypass via app.bypass_rls()='true' → sees ALL rows ──
            await setSession(userB, "self", true);
            expect(await countPublic("pub-unowned")).toBe(1);
            expect(await countPublic("pub-owned-a")).toBe(1);
            expect(await countRestricted("res-unowned")).toBe(1);
            expect(await countRestricted("res-owned-a")).toBe(1);
          });
        });
      });
    },
    TEST_TIMEOUT,
  );

  /**
   * §F.4 — group-axis RLS proof (Phase 2). We build a REAL org-unit hierarchy
   * (R → C → G, plus sibling S, plus a disjoint group B) so the trigger-
   * maintained platform.org_unit_closure drives expansion, then seed three
   * fixture tables carrying the generated group policy — one per expand mode:
   *
   *   descendants → "org_unit_id" = ANY(app.current_groups())
   *   exact       → "org_unit_id" = ANY(app.current_groups_exact())
   *   ancestors   → "org_unit_id" = ANY(app.current_groups_ancestors())
   *
   * The expansion GUCs (app.user_groups / _exact / _ancestors) are computed
   * EXACTLY as applyDbSession does — from a user's DIRECT org units against the
   * closure — and then RAW count(*) as the restricted openshapeforge_app role proves
   * each mode. A raw count is RLS-enforced, so the numbers ARE the proof.
   *
   * The descendants/exact fixture is org_unit_id=C (child) and =G (grandchild);
   * the ancestors fixture is org_unit_id=R (root) and =C. Cross-group uses a
   * disjoint group B row (empty:public fixture) + an empty:restricted fixture.
   */
  test(
    "group axis: descendants/exact/ancestors visibility, cross-group isolation, empty semantics, bypass",
    async () => {
      const tenant = randomUUID();
      const R = randomUUID(); // root
      const C = randomUUID(); // child of R
      const G = randomUUID(); // grandchild (child of C)
      const S = randomUUID(); // sibling root (disjoint from R subtree)
      const B = randomUUID(); // disjoint group B root

      await withScratchDb(async (name) => {
        // Privileged role: run the chain, build org units (trigger fills the
        // closure), and seed fixture tables with the generated group policies.
        await withDb(scratchAdminUrl(name), async (db) => {
          await db.connection().execute((conn) => runMigrationChain(conn));

          await db.connection().execute(async (conn) => {
            await sql`select set_config('app.tenant_id', ${tenant}, false)`.execute(conn);

            const insertUnit = async (id: string, parent: string | null) => {
              await sql`
                insert into platform.org_unit (id, tenant_id, parent_id, name)
                values (${id}::uuid, ${tenant}::uuid, ${parent}::uuid, ${`u-${id.slice(0, 4)}`})
              `.execute(conn);
            };
            await insertUnit(R, null);
            await insertUnit(C, R);
            await insertUnit(G, C);
            await insertUnit(S, null);
            await insertUnit(B, null);

            // ── group fixture (empty:public, descendants) ──
            await sql`
              create table erp.group_desc_fixture (
                id uuid primary key default gen_random_uuid(),
                tenant_id uuid not null,
                org_unit_id uuid,
                marker text not null
              )
            `.execute(conn);
            await sql`alter table erp.group_desc_fixture enable row level security`.execute(conn);
            await sql`alter table erp.group_desc_fixture force row level security`.execute(conn);
            await sql`
              create policy group_desc_fixture_row_scope on erp.group_desc_fixture
                using (app.bypass_rls() or (tenant_id = app.current_tenant()
                  and ("org_unit_id" = any(app.current_groups()) or "org_unit_id" is null)))
                with check (app.bypass_rls() or (tenant_id = app.current_tenant()
                  and ("org_unit_id" = any(app.current_groups()) or "org_unit_id" is null)))
            `.execute(conn);

            // ── group fixture (empty:restricted, exact) ──
            await sql`
              create table erp.group_exact_fixture (
                id uuid primary key default gen_random_uuid(),
                tenant_id uuid not null,
                org_unit_id uuid,
                marker text not null
              )
            `.execute(conn);
            await sql`alter table erp.group_exact_fixture enable row level security`.execute(conn);
            await sql`alter table erp.group_exact_fixture force row level security`.execute(conn);
            await sql`
              create policy group_exact_fixture_row_scope on erp.group_exact_fixture
                using (app.bypass_rls() or (tenant_id = app.current_tenant()
                  and ("org_unit_id" = any(app.current_groups_exact()))))
                with check (app.bypass_rls() or (tenant_id = app.current_tenant()
                  and ("org_unit_id" = any(app.current_groups_exact()))))
            `.execute(conn);

            // ── group fixture (empty:restricted, ancestors) ──
            await sql`
              create table erp.group_anc_fixture (
                id uuid primary key default gen_random_uuid(),
                tenant_id uuid not null,
                org_unit_id uuid,
                marker text not null
              )
            `.execute(conn);
            await sql`alter table erp.group_anc_fixture enable row level security`.execute(conn);
            await sql`alter table erp.group_anc_fixture force row level security`.execute(conn);
            await sql`
              create policy group_anc_fixture_row_scope on erp.group_anc_fixture
                using (app.bypass_rls() or (tenant_id = app.current_tenant()
                  and ("org_unit_id" = any(app.current_groups_ancestors()))))
                with check (app.bypass_rls() or (tenant_id = app.current_tenant()
                  and ("org_unit_id" = any(app.current_groups_ancestors()))))
            `.execute(conn);

            await sql.raw(
              `grant select, insert, update, delete on erp.group_desc_fixture, erp.group_exact_fixture, erp.group_anc_fixture to ${APP_ROLE}`,
            ).execute(conn);

            // Seed rows. descendants/exact fixtures: rows owned by C and G (both
            // under R) + a disjoint group-B row + an unowned (NULL) row.
            await sql`
              insert into erp.group_desc_fixture (tenant_id, org_unit_id, marker)
              values (${tenant}::uuid, ${C}::uuid, ${"desc-C"}),
                     (${tenant}::uuid, ${G}::uuid, ${"desc-G"}),
                     (${tenant}::uuid, ${B}::uuid, ${"desc-B"}),
                     (${tenant}::uuid, ${R}::uuid, ${"desc-R"}),
                     (${tenant}::uuid, null,       ${"desc-null"})
            `.execute(conn);
            await sql`
              insert into erp.group_exact_fixture (tenant_id, org_unit_id, marker)
              values (${tenant}::uuid, ${R}::uuid, ${"exact-R"}),
                     (${tenant}::uuid, ${C}::uuid, ${"exact-C"}),
                     (${tenant}::uuid, ${G}::uuid, ${"exact-G"})
            `.execute(conn);
            // ancestors fixture: rows owned by R (root) and C (mid) — the
            // ancestors of G.
            await sql`
              insert into erp.group_anc_fixture (tenant_id, org_unit_id, marker)
              values (${tenant}::uuid, ${R}::uuid, ${"anc-R"}),
                     (${tenant}::uuid, ${C}::uuid, ${"anc-C"}),
                     (${tenant}::uuid, ${S}::uuid, ${"anc-S"})
            `.execute(conn);
          });
        });

        // Restricted app role: prove each mode with RAW count(*).
        await withDb(scratchAppUrl(name), async (db) => {
          await db.connection().execute(async (conn) => {
            const count = async (table: string, marker: string) => {
              const r = await sql<{ n: number }>`
                select count(*)::int as n from ${sql.raw(table)} where marker = ${marker}
              `.execute(conn);
              return r.rows[0]?.n ?? -1;
            };

            // Expand a user's DIRECT groups exactly like applyDbSession, reading
            // the trigger-maintained closure (visible to the app role under the
            // tenant GUC).
            const expandAndSetSession = async (
              directGroups: string[],
              scope: string,
              bypass: boolean,
            ) => {
              await sql`select set_config('app.tenant_id', ${tenant}, false)`.execute(conn);
              await sql`select set_config('app.scope', ${scope}, false)`.execute(conn);
              await sql`select set_config('app.bypass_rls', ${bypass ? rlsBypassToken() : "false"}, false)`.execute(conn);
              if (directGroups.length === 0) {
                await sql`select set_config('app.user_groups', '', false)`.execute(conn);
                await sql`select set_config('app.user_groups_exact', '', false)`.execute(conn);
                await sql`select set_config('app.user_groups_ancestors', '', false)`.execute(conn);
                return;
              }
              // Postgres array text literal — see the note in applyDbSession.
              const directLiteral = `{${directGroups.join(",")}}`;
              const desc = await sql<{ id: string }>`
                select distinct descendant_id as id from platform.org_unit_closure
                where tenant_id = ${tenant}::uuid and ancestor_id = any(${directLiteral}::uuid[])
              `.execute(conn);
              const anc = await sql<{ id: string }>`
                select distinct ancestor_id as id from platform.org_unit_closure
                where tenant_id = ${tenant}::uuid and descendant_id = any(${directLiteral}::uuid[])
              `.execute(conn);
              await sql`select set_config('app.user_groups', ${desc.rows.map((r) => r.id).join(",")}, false)`.execute(conn);
              await sql`select set_config('app.user_groups_exact', ${directGroups.join(",")}, false)`.execute(conn);
              await sql`select set_config('app.user_groups_ancestors', ${anc.rows.map((r) => r.id).join(",")}, false)`.execute(conn);
            };

            // ── DESCENDANTS: direct group = R sees C's and G's rows ──
            await expandAndSetSession([R], "group", false);
            expect(await count("erp.group_desc_fixture", "desc-C")).toBe(1);
            expect(await count("erp.group_desc_fixture", "desc-G")).toBe(1);
            expect(await count("erp.group_desc_fixture", "desc-R")).toBe(1);
            // Disjoint group B is invisible (cross-group isolation).
            expect(await count("erp.group_desc_fixture", "desc-B")).toBe(0);
            // empty:public — unowned (NULL) row visible.
            expect(await count("erp.group_desc_fixture", "desc-null")).toBe(1);

            // A user directly in S sees none of R's subtree rows (raw count 0).
            await expandAndSetSession([S], "group", false);
            expect(await count("erp.group_desc_fixture", "desc-C")).toBe(0);
            expect(await count("erp.group_desc_fixture", "desc-G")).toBe(0);
            expect(await count("erp.group_desc_fixture", "desc-R")).toBe(0);
            // ...but the unowned row is still public to S.
            expect(await count("erp.group_desc_fixture", "desc-null")).toBe(1);

            // ── EXACT: direct group = R sees ONLY R, not C/G ──
            await expandAndSetSession([R], "group", false);
            expect(await count("erp.group_exact_fixture", "exact-R")).toBe(1);
            expect(await count("erp.group_exact_fixture", "exact-C")).toBe(0);
            expect(await count("erp.group_exact_fixture", "exact-G")).toBe(0);

            // ── ANCESTORS: direct group = G sees R and C (its ancestors) ──
            await expandAndSetSession([G], "group", false);
            expect(await count("erp.group_anc_fixture", "anc-R")).toBe(1);
            expect(await count("erp.group_anc_fixture", "anc-C")).toBe(1);
            // S is not an ancestor of G → invisible.
            expect(await count("erp.group_anc_fixture", "anc-S")).toBe(0);

            // ── empty:restricted (exact/ancestors fixtures) — a NULL org_unit
            //    row would be hidden. Prove no ancestor/exact match for an empty
            //    session (no direct groups) beyond the tenant. ──
            await expandAndSetSession([], "self", false);
            expect(await count("erp.group_exact_fixture", "exact-R")).toBe(0);
            expect(await count("erp.group_anc_fixture", "anc-R")).toBe(0);
            // empty:public descendants fixture — the unowned row stays visible
            // even with no groups.
            expect(await count("erp.group_desc_fixture", "desc-null")).toBe(1);
            expect(await count("erp.group_desc_fixture", "desc-C")).toBe(0);

            // ── Bypass: app.bypass_rls() sees ALL rows regardless of group ──
            await expandAndSetSession([S], "self", true);
            expect(await count("erp.group_desc_fixture", "desc-C")).toBe(1);
            expect(await count("erp.group_desc_fixture", "desc-B")).toBe(1);
            expect(await count("erp.group_exact_fixture", "exact-G")).toBe(1);
            expect(await count("erp.group_anc_fixture", "anc-S")).toBe(1);
          });
        });
      });
    },
    TEST_TIMEOUT,
  );
});
