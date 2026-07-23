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
 *   - the role is created only if pg_roles has no such row;
 *   - ALTER ROLE ... PASSWORD / NOSUPERUSER / NOBYPASSRLS re-asserts the
 *     intended attributes every run (defensive against manual tampering);
 *   - GRANT and ALTER DEFAULT PRIVILEGES are naturally idempotent.
 *
 * The GRANT ON ALL … statements only cover objects that EXIST at grant time,
 * so `applyAppRoleGrants` (the ON ALL sweep) must run AFTER the generated
 * schema has created its tables — see the migration chain ordering. This
 * function (role + schema-usage + function grants + default privileges) is
 * safe to run before the generated schema; `applyAppRoleGrants` re-runs the
 * table/sequence sweep afterwards so newly-generated entities are covered
 * automatically on every migrate.
 */

/** The restricted runtime role and its dev password. */
export const APP_ROLE = "openshapeforge_app";
const APP_ROLE_PASSWORD = "openshapeforge_app";

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
  // 1. Create the role if absent, then re-assert its attributes idempotently.
  //    NOSUPERUSER + NOBYPASSRLS are the load-bearing attributes for RLS.
  await sql`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = ${sql.lit(APP_ROLE)}) then
        create role ${sql.ref(APP_ROLE)}
          login password ${sql.lit(APP_ROLE_PASSWORD)}
          nosuperuser nobypassrls;
      end if;
    end
    $$;
  `.execute(db);

  // Re-assert password + attributes every run so a tampered or legacy role is
  // repaired. Separate statements (not inside the DO guard) keep them running
  // even when the role already existed.
  await sql`alter role ${sql.ref(APP_ROLE)} login password ${sql.lit(APP_ROLE_PASSWORD)}`.execute(db);
  await sql`alter role ${sql.ref(APP_ROLE)} nosuperuser nobypassrls`.execute(db);

  // 2. Grant USAGE on every schema that exists.
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

  // 3. EXECUTE on the app.* RLS helper functions (app.current_tenant(), etc.).
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

  // 4. ALTER DEFAULT PRIVILEGES for the migrate (current) role so any table or
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
