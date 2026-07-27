// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";

/**
 * Provisions the restricted, non-superuser runtime role `openshapeforge_app` and
 * grants it exactly the privileges the app needs — no more.
 *
 * WHY THIS EXISTS
 * ---------------
 * The app runtime MUST connect as a NOSUPERUSER / NOBYPASSRLS role, otherwise
 * `FORCE ROW LEVEL SECURITY` on every tenant-scoped table is silently bypassed
 * (a superuser or a rolbypassrls role ignores all RLS policies) and tenant
 * isolation collapses to the app-layer WHERE clause alone. This migration runs
 * in the PRIVILEGED migrate chain (OPENSHAPEFORGE_MIGRATE_DATABASE_URL); the
 * restricted role itself can never create roles or issue these grants.
 *
 * IDEMPOTENCY
 * -----------
 * CREATE ROLE is CLUSTER-WIDE, so the role survives across the throwaway
 * scratch databases used by migrations.test.ts. Everything here is therefore
 * fully idempotent:
 *   - the role is created only if pg_roles has no such row, and its password
 *     is set only at that point (never force-reset on later runs);
 *   - ALTER ROLE ... NOSUPERUSER / NOBYPASSRLS re-asserts the load-bearing RLS
 *     attributes every run (defensive against manual tampering);
 *   - GRANT and ALTER DEFAULT PRIVILEGES are naturally idempotent.
 *
 * PASSWORD OWNERSHIP
 * ------------------
 * The password is OPERATOR-OWNED, not source-owned. It is read from
 * OPENSHAPEFORGE_APP_PASSWORD (see {@link readAppRolePassword}) and must stay
 * consistent with the password in the runtime DATABASE_URL. It is applied only
 * on first creation of the role; migrations do NOT overwrite an existing role's
 * password on every run (that would clobber an operator-chosen credential and
 * force a downgrade to a known value). To rotate, set
 * OPENSHAPEFORGE_APP_PASSWORD_ROTATE=1 for a single migrate run alongside the
 * new OPENSHAPEFORGE_APP_PASSWORD (and update DATABASE_URL in lockstep).
 *
 * The GRANT ON ALL … statements only cover objects that EXIST at grant time,
 * so `applyAppRoleGrants` (the ON ALL sweep) must run AFTER the generated
 * schema has created its tables — see the migration chain ordering. This
 * function (role + schema-usage + function grants + default privileges) is
 * safe to run before the generated schema; `applyAppRoleGrants` re-runs the
 * table/sequence sweep afterwards so newly-generated entities are covered
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
 * Whether this migrate run should ROTATE the existing role's password. Off by
 * default: the password is set only at role creation, so an operator-chosen
 * credential is never clobbered on a routine `helm upgrade`. Set
 * OPENSHAPEFORGE_APP_PASSWORD_ROTATE=1 (with the new OPENSHAPEFORGE_APP_PASSWORD,
 * and DATABASE_URL updated in lockstep) for a single run to rotate.
 */
function shouldRotateAppRolePassword(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.OPENSHAPEFORGE_APP_PASSWORD_ROTATE;
  return flag === "1" || flag === "true";
}

/**
 * Schemas the app role needs USAGE on. `app` holds the RLS helper functions;
 * `erp` and `platform` hold the tenant-scoped and platform tables. Only
 * schemas that actually exist are touched (guarded per-statement below).
 */
const APP_SCHEMAS = ["app", "erp", "platform"] as const;

/**
 * Create/repair the role and grant schema usage, function execute, and default
 * privileges. Safe to run at any point in the chain; call BEFORE the generated
 * schema so `app` helpers and schema usage are in place, then run
 * {@link applyAppRoleGrants} after the generated schema to sweep table grants.
 */
export async function applyAppRoleMigration(db: OpenShapeForgeDatabase) {
  const appRolePassword = readAppRolePassword();

  // 1. Create the role if absent. The password (operator-owned, must match
  //    DATABASE_URL) is set ONLY here, at first creation — never force-reset on
  //    later runs, so a routine migrate can't clobber an operator-chosen
  //    credential or downgrade it to a known value.
  //    NOSUPERUSER + NOBYPASSRLS are the load-bearing attributes for RLS.
  await sql`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = ${sql.lit(APP_ROLE)}) then
        create role ${sql.ref(APP_ROLE)}
          login password ${sql.lit(appRolePassword)}
          nosuperuser nobypassrls;
      end if;
    end
    $$;
  `.execute(db);

  // Re-assert the load-bearing RLS attributes every run so a tampered or legacy
  // role is repaired. These are NOT secrets, so re-asserting them is safe.
  // LOGIN is re-asserted too (a NOLOGIN role would break the runtime pool).
  await sql`alter role ${sql.ref(APP_ROLE)} login nosuperuser nobypassrls`.execute(db);

  // Rotate the password ONLY when explicitly requested for this run. This is
  // the sole path that overwrites an existing role's password; the default
  // (unset flag) leaves an operator-set credential untouched.
  if (shouldRotateAppRolePassword()) {
    await sql`alter role ${sql.ref(APP_ROLE)} login password ${sql.lit(appRolePassword)}`.execute(db);
  }

  // 2. CONNECT on the database itself.
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

  // 3. Grant USAGE on every schema that exists.
  for (const schema of APP_SCHEMAS) {
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

  // 4. EXECUTE on the app.* RLS helper functions (app.current_tenant(), etc.).
  //    Applying to ALL functions in `app` is broad but the schema only holds
  //    those helpers. Default privileges below cover future helpers.
  await sql`
    do $$
    begin
      if exists (select 1 from information_schema.schemata where schema_name = 'app') then
        execute format('grant execute on all functions in schema app to %I', ${sql.lit(APP_ROLE)});
        execute format(
          'alter default privileges in schema app grant execute on functions to %I',
          ${sql.lit(APP_ROLE)}
        );
      end if;
    end
    $$;
  `.execute(db);

  // 5. ALTER DEFAULT PRIVILEGES for the migrate (current) role so any table or
  //    sequence it creates LATER — including newly generated entities — is
  //    auto-granted to openshapeforge_app without a manual grant.
  for (const schema of ["erp", "platform"] as const) {
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
 * Sweep DML grants over ALL existing tables and sequences in the tenant-scoped
 * schemas. Must run AFTER the generated schema so new entities' tables are
 * covered. Idempotent — re-runs harmlessly on every migrate, so the day a new
 * entity is generated its table is granted automatically without a bespoke
 * migration.
 *
 * The restricted role gets SELECT/INSERT/UPDATE/DELETE (enough for the app; RLS
 * still filters every row) and USAGE/SELECT on sequences (identity columns).
 * It deliberately gets NO privileges that would let it bypass RLS.
 */
export async function applyAppRoleGrants(db: OpenShapeForgeDatabase) {
  for (const schema of ["erp", "platform"] as const) {
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
}
