// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import type { OpenShapeForgeDatabase } from "../connection.js";

/**
 * Grants the provisioned, restricted `openshapeforge_app` role exactly the
 * database privileges the app needs — no more.
 *
 * WHY THIS EXISTS
 * ---------------
 * The app runtime MUST connect as a NOSUPERUSER / NOBYPASSRLS role, otherwise
 * `FORCE ROW LEVEL SECURITY` on every tenant-scoped table is silently bypassed
 * (a superuser or a rolbypassrls role ignores all RLS policies) and tenant
 * isolation collapses to the app-layer WHERE clause alone. The host provisions
 * this cluster-wide role through the administrator connection; this migration
 * only applies database-scoped grants.
 *
 * IDEMPOTENCY
 * -----------
 * The role survives across the throwaway scratch databases used by
 * migrations.test.ts. GRANT and ALTER DEFAULT PRIVILEGES are naturally
 * idempotent, and the chain verifies the role contract before any DDL runs.
 *
 * PASSWORD OWNERSHIP
 * ------------------
 * The password is OPERATOR-OWNED, not source-owned. It is read from
 * OPENSHAPEFORGE_APP_PASSWORD (see {@link readAppRolePassword}) and must stay
 * consistent with the password in the runtime DATABASE_URL. It is applied only
 * on first creation of the role; migrations never alter it. To rotate, run
 * `db:provision-roles` once with OPENSHAPEFORGE_APP_PASSWORD_ROTATE=1 and the
 * new password, and update DATABASE_URL in lockstep.
 *
 * ORDERING
 * --------
 * `applyAppRoleMigration` runs FIRST in the chain, before any schema exists, so
 * every grant it issues is guarded on its schema being present and is a no-op
 * on a fresh database. GRANT ON ALL … only covers objects that EXIST at grant
 * time for the same reason. `applyAppRoleGrants` therefore runs AFTER the
 * helpers migration and the generated schema and re-applies BOTH halves — the
 * `app` schema grants and the table/sequence sweep — so the role ends up with
 * the same effective privileges on a database migrated from empty as on one
 * migrated incrementally, and newly-generated entities are covered
 * automatically on every migrate.
 */

/** The restricted runtime role. */
export const APP_ROLE = "openshapeforge_app";

/**
 * The local-dev-only default password for {@link APP_ROLE}. It matches the
 * DATABASE_URL in apps/api/.env.example and the RLS/migration scratch tests so
 * local work is frictionless. It is NEVER accepted in production —
 * {@link readAppRolePassword} fails closed there.
 */
export const DEV_APP_ROLE_PASSWORD_DEFAULT = "openshapeforge_app";

/**
 * Resolve the password to provision {@link APP_ROLE} with. Operator-owned: it
 * must match the password embedded in the runtime DATABASE_URL.
 *
 * Fails closed in production (mirrors config/production-guard.ts): when
 * NODE_ENV === 'production', OPENSHAPEFORGE_APP_PASSWORD must be set to a
 * non-empty value that is NOT the public dev default. Outside production it
 * falls back to the dev default so local dev and the scratch-DB tests keep
 * working without extra configuration.
 *
 * The dev default is never silently used in production, so the role's
 * credential can never collapse to a source-published constant equal to the
 * role name.
 */
export function readAppRolePassword(env: NodeJS.ProcessEnv = process.env): string {
  const password = env.OPENSHAPEFORGE_APP_PASSWORD;

  if (env.NODE_ENV === "production") {
    if (!password) {
      throw new Error(
        "OPENSHAPEFORGE_APP_PASSWORD is required in production. It provisions the " +
          "restricted, RLS-enforcing runtime role and must match the password in " +
          "DATABASE_URL. Set a strong, randomized secret (never the dev default).",
      );
    }
    if (password === DEV_APP_ROLE_PASSWORD_DEFAULT) {
      throw new Error(
        "OPENSHAPEFORGE_APP_PASSWORD is still the public dev default " +
          `('${DEV_APP_ROLE_PASSWORD_DEFAULT}'). This is a known, source-published ` +
          "credential for the RLS-enforcing runtime role. Set a strong, randomized secret.",
      );
    }
    return password;
  }

  return password || DEV_APP_ROLE_PASSWORD_DEFAULT;
}

/**
 * Whether this provisioning run should ROTATE the existing role's password.
 * Off by default: the password is set only at role creation, so an operator-chosen
 * credential is never clobbered on a routine `helm upgrade`. Set
 * OPENSHAPEFORGE_APP_PASSWORD_ROTATE=1 (with the new OPENSHAPEFORGE_APP_PASSWORD,
 * and DATABASE_URL updated in lockstep) for a single `db:provision-roles` run.
 */
export function shouldRotateAppRolePassword(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.OPENSHAPEFORGE_APP_PASSWORD_ROTATE;
  return flag === "1" || flag === "true";
}

/**
 * Every schema the generated manifest declares a table in, sorted so the DDL
 * order is deterministic.
 *
 * Derived rather than listed because a compiler PLUGIN contributes schemas the
 * core has never heard of — the workflow plugin owns `workflow` — and a
 * hardcoded list silently withholds every grant from them. The database is
 * loud about it (`permission denied for schema workflow`), but only once
 * something actually connects as the restricted role, and the migration and
 * e2e suites connect as the privileged one.
 */
const MANAGED_SCHEMAS: readonly string[] = [
  ...new Set(manifest.tables.map((table) => table.schema)),
]
  .filter((schema) => schema !== "app")
  .sort();

/**
 * USAGE on `app` and EXECUTE on the RLS helper functions it holds
 * (app.current_tenant(), etc.), for the restricted role.
 *
 * Split out because it has to run TWICE. `applyAppRoleMigration` runs first in
 * the chain — before `applyAppHelpersMigration` creates `app` — so the guard
 * below is false there on a fresh database and the grants are silently skipped.
 * Without the second call from {@link applyAppRoleGrants} (which runs after the
 * schema exists) the role was left holding EXECUTE on the helpers, which
 * functions grant to PUBLIC by default, and NO USAGE on the schema containing
 * them: every application statement naming `app.…` failed with
 * `permission denied for schema app` on a freshly migrated database while
 * working on one where `app` happened to pre-date the role (#295). RLS itself
 * was never affected — policy expressions are evaluated with the table owner's
 * privileges.
 *
 * The guard stays in both call sites: it is what makes this safe to call before
 * the schema exists, and re-granting is idempotent.
 *
 * USAGE and EXECUTE only, deliberately. `app` is excluded from
 * {@link MANAGED_SCHEMAS} so the DML sweep never reaches it — it holds no
 * tables — and CREATE is never granted: the restricted role must not be able to
 * define objects in the schema every RLS policy resolves its helpers through.
 */
async function applyAppSchemaGrants(db: OpenShapeForgeDatabase) {
  await sql`
    do $$
    begin
      if exists (select 1 from information_schema.schemata where schema_name = 'app') then
        execute format('grant usage on schema app to %I', ${sql.lit(APP_ROLE)});
        execute format('grant execute on all functions in schema app to %I', ${sql.lit(APP_ROLE)});
        execute format(
          'alter default privileges in schema app grant execute on functions to %I',
          ${sql.lit(APP_ROLE)}
        );
      end if;
    end
    $$;
  `.execute(db);
}

/**
 * Create/repair the role and grant database connect, schema usage, function
 * execute, and default privileges. Safe to run at any point in the chain —
 * every grant is guarded on its schema existing — and it runs FIRST, so on a
 * fresh database only the role itself and the CONNECT grant actually land.
 * {@link applyAppRoleGrants}, which runs after the schema steps, is what makes
 * the rest take effect.
 */
export async function applyAppRoleMigration(db: OpenShapeForgeDatabase) {
  // The role itself is part of the declared database role contract
  //    (db/database-roles.ts): the host provisions it with the admin
  //    credential and the chain has already verified it exists with LOGIN,
  //    NOSUPERUSER and NOBYPASSRLS. Nothing cluster-wide is written here.
  // 1. CONNECT on the database itself.
  //    Stock PostgreSQL grants CONNECT to PUBLIC, so this is a no-op on a local
  //    or CI Postgres — which is exactly why its absence went unnoticed. Managed
  //    providers revoke it (Scaleway RDB does), leaving the role able to
  //    authenticate but not connect:
  //      permission denied for database "openshapeforge"
  //      detail: "User does not have CONNECT privilege."
  //    current_database() keeps this correct whatever the database is named,
  //    and re-granting an existing privilege is idempotent.
  await sql`
    do $$
    begin
      execute format('grant connect on database %I to %I', current_database(), ${sql.lit(APP_ROLE)});
    end
    $$;
  `.execute(db);

  // 2. Grant USAGE on every table-bearing schema that exists.
  for (const schema of MANAGED_SCHEMAS) {
    await sql`
      do $$
      begin
        if exists (select 1 from information_schema.schemata where schema_name = ${sql.lit(schema)}) then
          execute format('grant usage on schema %I to %I', ${sql.lit(schema)}, ${sql.lit(APP_ROLE)});
        end if;
      end
      $$;
    `.execute(db);
  }

  // 3. USAGE on `app` + EXECUTE on its RLS helpers. A no-op here on a fresh
  //    database (the schema is created by the NEXT chain step);
  //    applyAppRoleGrants re-applies it once it exists.
  await applyAppSchemaGrants(db);

  // 4. ALTER DEFAULT PRIVILEGES for the migrate (current) role so any table or
  //    sequence it creates LATER — including newly generated entities — is
  //    auto-granted to openshapeforge_app without a manual grant.
  for (const schema of MANAGED_SCHEMAS) {
    await sql`
      do $$
      begin
        if exists (select 1 from information_schema.schemata where schema_name = ${sql.lit(schema)}) then
          execute format(
            'alter default privileges in schema %I grant select, insert, update, delete on tables to %I',
            ${sql.lit(schema)}, ${sql.lit(APP_ROLE)}
          );
          execute format(
            'alter default privileges in schema %I grant usage, select on sequences to %I',
            ${sql.lit(schema)}, ${sql.lit(APP_ROLE)}
          );
        end if;
      end
      $$;
    `.execute(db);
  }
}

/**
 * Sweep DML grants over ALL existing tables and sequences in every schema the
 * manifest declares. Must run AFTER the generated schema so new entities'
 * tables — and a plugin's newly-contributed schema — are covered. Idempotent —
 * re-runs harmlessly on every migrate, so the day a new entity is generated its
 * table is granted automatically without a bespoke migration.
 *
 * The restricted role gets SELECT/INSERT/UPDATE/DELETE (enough for the app; RLS
 * still filters every row) and USAGE/SELECT on sequences (identity columns).
 * It deliberately gets NO privileges that would let it bypass RLS.
 *
 * Also the point at which the `app` schema grants finally land on a fresh
 * migrate — see {@link applyAppSchemaGrants}. That is USAGE and EXECUTE only;
 * `app` is not in the DML sweep below.
 */
export async function applyAppRoleGrants(db: OpenShapeForgeDatabase) {
  await applyAppSchemaGrants(db);

  for (const schema of MANAGED_SCHEMAS) {
    await sql`
      do $$
      begin
        if exists (select 1 from information_schema.schemata where schema_name = ${sql.lit(schema)}) then
          execute format('grant usage on schema %I to %I', ${sql.lit(schema)}, ${sql.lit(APP_ROLE)});
          execute format(
            'grant select, insert, update, delete on all tables in schema %I to %I',
            ${sql.lit(schema)}, ${sql.lit(APP_ROLE)}
          );
          execute format(
            'grant usage, select on all sequences in schema %I to %I',
            ${sql.lit(schema)}, ${sql.lit(APP_ROLE)}
          );
        end if;
      end
      $$;
    `.execute(db);
  }

  // Documents must be created atomically with their first immutable version,
  // and DocumentVersion is append-only: through the SECURITY DEFINER commands
  // installed by migration 0007, or through the generic snapshot publish,
  // which inserts as the runtime role under a transaction-local marker the
  // write guard in core-invariants.ts checks (that guard is what refuses any
  // other insert). The broad generated-table sweep above intentionally
  // remains generic; these final revokes are re-applied on every migrate so a
  // fresh table, default privilege, or manual grant cannot reopen updates or
  // deletes for the runtime role. Generated reads remain available.
  await sql`
    do $$
    begin
      if to_regclass('erp.documents') is not null then
        execute format(
          'revoke insert on erp.documents from %I',
          ${sql.lit(APP_ROLE)}
        );
      end if;
      if to_regclass('erp.document_versions') is not null then
        execute format(
          'revoke update, delete on erp.document_versions from %I',
          ${sql.lit(APP_ROLE)}
        );
      end if;
      -- The bypass audit trail is append-only for the runtime: rows are
      -- inserted, completed by the bypass session that opened them
      -- (migrations/api-keys.ts), and never removed by the application.
      if to_regclass('platform.system_bypass_audit') is not null then
        execute format(
          'revoke delete on platform.system_bypass_audit from %I',
          ${sql.lit(APP_ROLE)}
        );
      end if;
    end
    $$;
  `.execute(db);
}
